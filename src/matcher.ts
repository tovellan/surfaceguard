import { decodeTextVariantsForMatching, rawSpanForMatch } from './decode.js';
import { SurfaceGuardError } from './errors.js';
import type { ArtifactFile, Finding, PatternRule, ScanLimits } from './types.js';

interface LocationCursor {
  offset: number;
  line: number;
  lineStart: number;
}

function locationAt(
  text: string,
  offset: number,
  cursor: LocationCursor,
): { line: number; column: number; offset: number } {
  if (offset < cursor.offset) {
    cursor.offset = 0;
    cursor.line = 1;
    cursor.lineStart = 0;
  }
  while (cursor.offset < offset) {
    const code = text.charCodeAt(cursor.offset);
    if (code === 13) {
      if (text.charCodeAt(cursor.offset + 1) === 10 && cursor.offset + 1 < offset) {
        cursor.offset += 1;
      }
      cursor.line += 1;
      cursor.lineStart = cursor.offset + 1;
    } else if (code === 10) {
      cursor.line += 1;
      cursor.lineStart = cursor.offset + 1;
    }
    cursor.offset += 1;
  }
  return { line: cursor.line, column: offset - cursor.lineStart + 1, offset };
}

export function compilePatternRule(
  rule: PatternRule,
  limits: ScanLimits,
  path?: string,
): RegExp | undefined {
  if (rule.pattern.length > limits.maxPatternLength) {
    throw new SurfaceGuardError(
      'SG_CONFIG_INVALID',
      `Pattern ${rule.id} exceeds maxPatternLength`,
      {
        ruleId: rule.id,
        ...(path ? { path } : {}),
        limit: limits.maxPatternLength,
      },
    );
  }
  if (rule.match !== 'regex') return undefined;
  if (/\([^)]*[+*][^)]*\)[+*{]/u.test(rule.pattern)) {
    throw new SurfaceGuardError(
      'SG_CONFIG_INVALID',
      `Pattern ${rule.id} contains a nested quantifier`,
      {
        ruleId: rule.id,
        ...(path ? { path } : {}),
      },
    );
  }
  try {
    return new RegExp(rule.pattern, rule.caseSensitive === false ? 'gui' : 'gu');
  } catch (error) {
    throw new SurfaceGuardError(
      'SG_CONFIG_INVALID',
      `Pattern ${rule.id} is not a valid regular expression`,
      {
        ruleId: rule.id,
        ...(path ? { path } : {}),
        cause: error instanceof Error ? error.message : String(error),
      },
    );
  }
}

function* literalMatches(
  text: string,
  pattern: string,
  caseSensitive: boolean,
): Generator<[number, number]> {
  if (!caseSensitive) {
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    yield* regexMatches(text, new RegExp(escaped, 'giu'));
    return;
  }
  let offset = 0;
  while (pattern.length > 0) {
    const index = text.indexOf(pattern, offset);
    if (index < 0) break;
    yield [index, pattern.length];
    offset = index + Math.max(1, pattern.length);
  }
}

function codePointWidthAt(text: string, index: number): number {
  const codePoint = text.codePointAt(index);
  return codePoint !== undefined && codePoint > 0xffff ? 2 : 1;
}

function* regexMatches(text: string, regex: RegExp): Generator<[number, number]> {
  regex.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    yield [match.index, match[0].length];
    if (match[0].length === 0) {
      regex.lastIndex += codePointWidthAt(text, regex.lastIndex);
    }
  }
}

export function matchPatternRule(
  raw: string,
  file: ArtifactFile,
  rule: PatternRule,
  category: 'text' | 'endpoint' | 'metadata',
  limits: ScanLimits,
): Finding[] {
  if (rule.scopes && !rule.scopes.includes('all') && !rule.scopes.includes(file.kind))
    return [];
  const regex = compilePatternRule(rule, limits);
  const variants = decodeTextVariantsForMatching(raw, limits.maxDecodePasses);
  const findings: Finding[] = [];
  const seen = new Set<string>();
  for (const variant of variants) {
    const locationCursor: LocationCursor = { offset: 0, line: 1, lineStart: 0 };
    const matches = regex
      ? regexMatches(variant.text, regex)
      : literalMatches(variant.text, rule.pattern, rule.caseSensitive !== false);

    for (const [start, length] of matches) {
      const span = rawSpanForMatch(variant, start, length);
      if (!span) continue;
      const key = `${span.start}:${span.end}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const evidence = raw.slice(span.start, span.end);
      findings.push({
        ruleId: rule.id,
        severity: rule.severity ?? 'error',
        category,
        artifactPath: file.relativePath,
        message: rule.message ?? `Forbidden ${category} pattern matched`,
        evidence,
        location: locationAt(raw, span.start, locationCursor),
        transform: variant.transform,
        help: `Remove the matched material from the produced ${file.kind} artifact or narrow the policy deliberately.`,
      });
      if (findings.length >= limits.maxFindings) return findings;
    }
  }
  return findings;
}
