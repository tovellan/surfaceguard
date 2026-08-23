import { rawSpanForMatch, decodeTextVariants } from './decode.js';
import { SurfaceGuardError } from './errors.js';
import type { ArtifactFile, Finding, PatternRule, ScanLimits } from './types.js';

function locationAt(
  text: string,
  offset: number,
): { line: number; column: number; offset: number } {
  let line = 1;
  let lineStart = 0;
  for (let index = 0; index < offset; index += 1) {
    if (text.charCodeAt(index) === 10) {
      line += 1;
      lineStart = index + 1;
    }
  }
  return { line, column: offset - lineStart + 1, offset };
}

function safeRegex(rule: PatternRule, limits: ScanLimits): RegExp {
  if (rule.pattern.length > limits.maxPatternLength) {
    throw new SurfaceGuardError(
      'SG_CONFIG_INVALID',
      `Pattern ${rule.id} exceeds maxPatternLength`,
      {
        ruleId: rule.id,
        limit: limits.maxPatternLength,
      },
    );
  }
  if (/\([^)]*[+*][^)]*\)[+*{]/u.test(rule.pattern)) {
    throw new SurfaceGuardError(
      'SG_CONFIG_INVALID',
      `Pattern ${rule.id} contains a nested quantifier`,
      {
        ruleId: rule.id,
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
        cause: error instanceof Error ? error.message : String(error),
      },
    );
  }
}

function literalMatches(
  text: string,
  pattern: string,
  caseSensitive: boolean,
): [number, number][] {
  const haystack = caseSensitive ? text : text.toLocaleLowerCase('en-US');
  const needle = caseSensitive ? pattern : pattern.toLocaleLowerCase('en-US');
  const matches: [number, number][] = [];
  let offset = 0;
  while (needle.length > 0) {
    const index = haystack.indexOf(needle, offset);
    if (index < 0) break;
    matches.push([index, needle.length]);
    offset = index + Math.max(1, needle.length);
  }
  return matches;
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
  if (rule.pattern.length > limits.maxPatternLength) {
    throw new SurfaceGuardError(
      'SG_CONFIG_INVALID',
      `Pattern ${rule.id} exceeds maxPatternLength`,
      {
        ruleId: rule.id,
      },
    );
  }

  const variants = decodeTextVariants(raw, limits.maxDecodePasses);
  const findings: Finding[] = [];
  const seen = new Set<string>();
  const regex = rule.match === 'regex' ? safeRegex(rule, limits) : undefined;

  for (const variant of variants) {
    const matches: [number, number][] = [];
    if (regex) {
      regex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(variant.text)) !== null) {
        matches.push([match.index, match[0].length]);
        if (match[0].length === 0) regex.lastIndex += 1;
      }
    } else {
      matches.push(
        ...literalMatches(variant.text, rule.pattern, rule.caseSensitive !== false),
      );
    }

    for (const [start, length] of matches) {
      const span = rawSpanForMatch(variant, start, Math.max(1, length));
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
        location: locationAt(raw, span.start),
        transform: variant.transform,
        help: `Remove the matched material from the produced ${file.kind} artifact or narrow the policy deliberately.`,
      });
    }
  }
  return findings;
}
