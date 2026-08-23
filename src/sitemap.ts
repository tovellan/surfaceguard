import { canonicalizeUrl, repeatedlyDecodeUrl } from './decode.js';
import { SurfaceGuardError, throwIfAborted } from './errors.js';

function decodeXml(value: string): string {
  const entities: Readonly<Record<string, string>> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
  };
  return value.replace(
    /&(amp|lt|gt|quot|apos|#x[0-9a-f]+|#[0-9]+);/giu,
    (match: string, name: string) => {
      const named = entities[name.toLowerCase()];
      if (named !== undefined) return named;

      const hexadecimal = name[1]?.toLowerCase() === 'x';
      const digits = name.slice(hexadecimal ? 2 : 1);
      const codePoint = Number.parseInt(digits, hexadecimal ? 16 : 10);
      const validXmlCharacter =
        codePoint === 0x9 ||
        codePoint === 0xa ||
        codePoint === 0xd ||
        (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
        (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
        (codePoint >= 0x10000 && codePoint <= 0x10ffff);
      return validXmlCharacter ? String.fromCodePoint(codePoint) : match;
    },
  );
}

export interface SitemapParseOptions {
  maxEntries: number;
  entriesVisited?: number;
  signal?: AbortSignal;
}

export interface ParsedSitemap {
  routes: string[];
  robotsPaths: string[];
  entriesVisited: number;
}

interface OpenLocation {
  depth: number;
  kind: 'page' | 'sitemap-reference';
  chunks: string[];
}

function markupEnd(text: string, start: number, signal?: AbortSignal): number {
  let quote: '"' | "'" | undefined;
  for (let index = start; index < text.length; index += 1) {
    if ((index & 0xfff) === 0) throwIfAborted(signal);
    const character = text[index];
    if (quote) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '>') return index;
  }
  return -1;
}

function markupName(text: string, start: number, end: number): string {
  let cursor = start + 1;
  if (text[cursor] === '/') cursor += 1;
  while (/\s/u.test(text[cursor] ?? '')) cursor += 1;
  const nameStart = cursor;
  while (cursor < end && !/[\s/>]/u.test(text[cursor] ?? '')) cursor += 1;
  return text.slice(nameStart, cursor);
}

function localName(name: string): string {
  const separator = name.lastIndexOf(':');
  return name.slice(separator + 1).toLowerCase();
}

function selfClosingMarkup(text: string, start: number, end: number): boolean {
  let cursor = end - 1;
  while (cursor > start && /\s/u.test(text[cursor] ?? '')) cursor -= 1;
  return text[cursor] === '/';
}

const VISIBLE_URL_SCHEME = /^[a-z][a-z\d+.-]*:/iu;

function robotsPathForSitemapLocation(
  value: string,
  maxDecodePasses: number,
): string | undefined {
  const input = value.trim().replaceAll('\\', '/');
  let current = input;
  for (let pass = 0; pass <= maxDecodePasses; pass += 1) {
    if (VISIBLE_URL_SCHEME.test(current) || current.startsWith('//')) {
      try {
        const url = current.startsWith('//')
          ? new URL(current, 'https://surfaceguard.invalid')
          : new URL(current);
        return `${url.pathname}${url.search}`;
      } catch {
        // The URL structure can require one more bounded percent-decoding pass.
      }
    }
    if (pass === maxDecodePasses) break;
    const decoded = repeatedlyDecodeUrl(current, 1);
    if (decoded === current) break;
    current = decoded;
  }
  try {
    const relative = new URL(input, 'https://surfaceguard.invalid');
    return `${relative.pathname}${relative.search}`;
  } catch {
    return undefined;
  }
}

export function parseSitemap(
  text: string,
  maxDecodePasses: number,
  options: SitemapParseOptions,
): ParsedSitemap {
  const routes: string[] = [];
  const robotsPaths: string[] = [];
  let entriesVisited = options.entriesVisited ?? 0;
  let cursor = 0;
  let elementDepth = 0;
  let rootKind: 'urlset' | 'sitemapindex' | undefined;
  let pageEntryDepth: number | undefined;
  let sitemapEntryDepth: number | undefined;
  let openLocation: OpenLocation | undefined;

  const visitLocation = (value: string, kind: OpenLocation['kind']): void => {
    entriesVisited += 1;
    if (entriesVisited > options.maxEntries) {
      throw new SurfaceGuardError(
        'SG_RESOURCE_LIMIT',
        'Sitemap entry count exceeds maxSitemapEntries',
        {
          limit: options.maxEntries,
          observed: entriesVisited,
        },
      );
    }
    const trimmed = value.trim();
    if (!trimmed || kind === 'sitemap-reference') return;
    const robotsPath = robotsPathForSitemapLocation(trimmed, maxDecodePasses);
    if (robotsPath) robotsPaths.push(robotsPath);
    try {
      const canonical = canonicalizeUrl(trimmed, maxDecodePasses);
      const url = new URL(canonical, 'https://surfaceguard.invalid');
      routes.push(`${url.pathname}${url.search}`);
    } catch {
      // Invalid sitemap locations are not public route evidence.
    }
  };

  while (cursor < text.length) {
    throwIfAborted(options.signal);
    const tagStart = text.indexOf('<', cursor);
    if (tagStart < 0) {
      if (openLocation) openLocation.chunks.push(decodeXml(text.slice(cursor)));
      break;
    }
    if (openLocation && tagStart > cursor) {
      openLocation.chunks.push(decodeXml(text.slice(cursor, tagStart)));
    }

    if (text.startsWith('<!--', tagStart)) {
      const end = text.indexOf('-->', tagStart + 4);
      if (end < 0) break;
      cursor = end + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', tagStart)) {
      const end = text.indexOf(']]>', tagStart + 9);
      if (end < 0) break;
      if (openLocation) openLocation.chunks.push(text.slice(tagStart + 9, end));
      cursor = end + 3;
      continue;
    }
    if (text.startsWith('<?', tagStart)) {
      const end = text.indexOf('?>', tagStart + 2);
      if (end < 0) break;
      cursor = end + 2;
      continue;
    }
    if (text.slice(tagStart, tagStart + 9).toUpperCase() === '<!DOCTYPE') {
      throw new SurfaceGuardError(
        'SG_IO_ERROR',
        'Sitemap DOCTYPE declarations are unsupported',
        { reason: 'External and custom XML entities are not expanded' },
      );
    }

    const tagEnd = markupEnd(text, tagStart + 1, options.signal);
    if (tagEnd < 0) break;
    const name = markupName(text, tagStart, tagEnd);
    const local = localName(name);
    const locationTag = local === 'loc';
    const closing = text[tagStart + 1] === '/';
    const selfClosing = !closing && selfClosingMarkup(text, tagStart, tagEnd);

    if (closing) {
      if (locationTag && openLocation?.depth === elementDepth) {
        visitLocation(openLocation.chunks.join(''), openLocation.kind);
        openLocation = undefined;
      }
      if (local === 'url' && pageEntryDepth === elementDepth) {
        pageEntryDepth = undefined;
      }
      if (local === 'sitemap' && sitemapEntryDepth === elementDepth) {
        sitemapEntryDepth = undefined;
      }
      if (
        elementDepth === 1 &&
        ((local === 'urlset' && rootKind === 'urlset') ||
          (local === 'sitemapindex' && rootKind === 'sitemapindex'))
      ) {
        rootKind = undefined;
      }
      elementDepth = Math.max(0, elementDepth - 1);
    } else {
      const parentDepth = elementDepth;
      let locationKind: OpenLocation['kind'] | undefined;
      if (locationTag && parentDepth === pageEntryDepth) locationKind = 'page';
      if (locationTag && parentDepth === sitemapEntryDepth) {
        locationKind = 'sitemap-reference';
      }

      if (selfClosing) {
        if (locationKind && !openLocation) visitLocation('', locationKind);
      } else {
        if (parentDepth === 0) {
          if (local === 'urlset' || local === 'sitemapindex') rootKind = local;
        } else if (parentDepth === 1 && rootKind === 'urlset' && local === 'url') {
          pageEntryDepth = parentDepth + 1;
        } else if (
          parentDepth === 1 &&
          rootKind === 'sitemapindex' &&
          local === 'sitemap'
        ) {
          sitemapEntryDepth = parentDepth + 1;
        }
        if (locationKind && !openLocation) {
          openLocation = {
            depth: parentDepth + 1,
            kind: locationKind,
            chunks: [],
          };
        }
        elementDepth += 1;
      }
    }
    cursor = tagEnd + 1;
  }
  return { routes, robotsPaths, entriesVisited };
}

export interface RobotsRules {
  disallow: string[];
  sitemaps: string[];
}

export interface RobotsParseOptions {
  maxRuleLength?: number;
  maxRules?: number;
  signal?: AbortSignal;
}

export function parseRobots(text: string, options: RobotsParseOptions = {}): RobotsRules {
  const rules: RobotsRules = { disallow: [], sitemaps: [] };
  const maxRules = options.maxRules ?? Number.MAX_SAFE_INTEGER;
  const maxRuleLength = options.maxRuleLength ?? Number.MAX_SAFE_INTEGER;
  let rulesVisited = 0;
  const addRule = (kind: keyof RobotsRules, value: string): void => {
    if (value.length > maxRuleLength) {
      throw new SurfaceGuardError(
        'SG_RESOURCE_LIMIT',
        'robots.txt directive exceeds maxPatternLength',
        { limit: maxRuleLength, observed: value.length },
      );
    }
    rulesVisited += 1;
    if (rulesVisited > maxRules) {
      throw new SurfaceGuardError(
        'SG_RESOURCE_LIMIT',
        'robots.txt directive count exceeds maxRobotsRules',
        { limit: maxRules, observed: rulesVisited },
      );
    }
    rules[kind].push(value);
  };
  let cursor = 0;
  while (cursor <= text.length) {
    throwIfAborted(options.signal);
    let end = cursor;
    while (end < text.length && text[end] !== '\r' && text[end] !== '\n') end += 1;
    const line = text.slice(cursor, end);
    const comment = line.indexOf('#');
    const withoutComment = line.slice(0, comment < 0 ? line.length : comment).trim();
    const separator = withoutComment.indexOf(':');
    if (separator >= 0) {
      const name = withoutComment.slice(0, separator).trim().toLowerCase();
      const value = withoutComment.slice(separator + 1).trim();
      if (name === 'disallow' && value.startsWith('/')) addRule('disallow', value);
      if (name === 'sitemap' && value) addRule('sitemaps', value);
    }
    if (end >= text.length) break;
    cursor = end + 1;
    if (text[end] === '\r' && text[cursor] === '\n') cursor += 1;
  }
  return rules;
}

function unreserved(byte: number): boolean {
  return (
    (byte >= 0x41 && byte <= 0x5a) ||
    (byte >= 0x61 && byte <= 0x7a) ||
    (byte >= 0x30 && byte <= 0x39) ||
    byte === 0x2d ||
    byte === 0x2e ||
    byte === 0x5f ||
    byte === 0x7e
  );
}

function hexDigit(code: number): number {
  if (code >= 0x30 && code <= 0x39) return code - 0x30;
  const folded = code | 0x20;
  return folded >= 0x61 && folded <= 0x66 ? folded - 0x57 : -1;
}

const ROBOTS_ENCODER = new TextEncoder();

function normalizeRobotsOctets(value: string): string {
  let normalized = '';
  for (let index = 0; index < value.length;) {
    const first = hexDigit(value.charCodeAt(index + 1));
    const second = hexDigit(value.charCodeAt(index + 2));
    if (value[index] === '%' && first >= 0 && second >= 0) {
      const byte = (first << 4) | second;
      normalized += unreserved(byte)
        ? String.fromCodePoint(byte)
        : `%${byte.toString(16).padStart(2, '0').toUpperCase()}`;
      index += 3;
      continue;
    }

    const codePoint = value.codePointAt(index) ?? 0;
    const character = String.fromCodePoint(codePoint);
    if (codePoint <= 0x7f) {
      normalized += character;
    } else {
      for (const byte of ROBOTS_ENCODER.encode(character)) {
        normalized += `%${byte.toString(16).padStart(2, '0').toUpperCase()}`;
      }
    }
    index += character.length;
  }
  return normalized;
}

function wildcardPrefixMatch(value: string, pattern: string, anchored: boolean): boolean {
  const firstStar = pattern.indexOf('*');
  if (firstStar < 0) {
    return anchored ? value === pattern : value.startsWith(pattern);
  }

  const first = pattern.slice(0, firstStar);
  if (first && !value.startsWith(first)) return false;
  let cursor = first.length;
  let patternCursor = firstStar + 1;
  let nextStar = pattern.indexOf('*', patternCursor);

  while (nextStar >= 0) {
    const segment = pattern.slice(patternCursor, nextStar);
    if (segment) {
      const match = value.indexOf(segment, cursor);
      if (match < 0) return false;
      cursor = match + segment.length;
    }
    patternCursor = nextStar + 1;
    nextStar = pattern.indexOf('*', patternCursor);
  }

  const last = pattern.slice(patternCursor);
  if (anchored) {
    const match = value.length - last.length;
    return match >= cursor && value.startsWith(last, match);
  }
  return !last || value.includes(last, cursor);
}

export function matchesRobotsRule(pathAndQuery: string, rule: string): boolean {
  return matchesCompiledRobotsRule(
    normalizeRobotsPath(pathAndQuery),
    compileRobotsRule(rule),
  );
}

export interface CompiledRobotsRule {
  anchored: boolean;
  pattern: string;
}

export function normalizeRobotsPath(pathAndQuery: string): string {
  return normalizeRobotsOctets(pathAndQuery);
}

export function compileRobotsRule(rule: string): CompiledRobotsRule {
  const anchored = rule.endsWith('$');
  const body = anchored ? rule.slice(0, -1) : rule;
  return { anchored, pattern: normalizeRobotsOctets(body) };
}

export function matchesCompiledRobotsRule(
  normalizedPathAndQuery: string,
  rule: CompiledRobotsRule,
): boolean {
  return wildcardPrefixMatch(normalizedPathAndQuery, rule.pattern, rule.anchored);
}
