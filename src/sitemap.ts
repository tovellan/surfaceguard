import { canonicalizeUrl } from './decode.js';
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
  entriesVisited: number;
}

export function parseSitemap(
  text: string,
  maxDecodePasses: number,
  options: SitemapParseOptions,
): ParsedSitemap {
  const routes: string[] = [];
  let entriesVisited = options.entriesVisited ?? 0;
  let cursor = 0;
  let openLocation: number | undefined;
  while (cursor < text.length) {
    throwIfAborted(options.signal);
    const tagStart = text.indexOf('<', cursor);
    if (tagStart < 0) break;
    const tagEnd = text.indexOf('>', tagStart + 1);
    if (tagEnd < 0) break;
    cursor = tagEnd + 1;

    let nameStart = tagStart + 1;
    const closing = text[nameStart] === '/';
    if (closing) nameStart += 1;
    if (text.slice(nameStart, nameStart + 3).toLowerCase() !== 'loc') continue;
    const boundary = text[nameStart + 3];
    if (boundary !== '>' && boundary !== '/' && !/\s/u.test(boundary ?? '')) continue;

    if (!closing) {
      if (text.slice(tagStart, tagEnd).trimEnd().endsWith('/')) continue;
      openLocation ??= tagEnd + 1;
      continue;
    }
    if (openLocation === undefined) continue;

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
    const value = decodeXml(text.slice(openLocation, tagStart).trim());
    openLocation = undefined;
    if (!value) continue;
    try {
      const canonical = canonicalizeUrl(value, maxDecodePasses);
      const url = new URL(canonical, 'https://surfaceguard.invalid');
      routes.push(`${url.pathname}${url.search}`);
    } catch {
      continue;
    }
  }
  return { routes, entriesVisited };
}

export interface RobotsRules {
  disallow: string[];
  sitemaps: string[];
}

export function parseRobots(text: string): RobotsRules {
  const rules: RobotsRules = { disallow: [], sitemaps: [] };
  for (const line of text.split(/\r?\n/u)) {
    const withoutComment = line.split('#', 1)[0]?.trim() ?? '';
    const separator = withoutComment.indexOf(':');
    if (separator < 0) continue;
    const name = withoutComment.slice(0, separator).trim().toLowerCase();
    const value = withoutComment.slice(separator + 1).trim();
    if (name === 'disallow' && value.startsWith('/')) rules.disallow.push(value);
    if (name === 'sitemap' && value) rules.sitemaps.push(value);
  }
  return rules;
}
