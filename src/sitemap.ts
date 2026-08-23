import { canonicalizeUrl } from './decode.js';

function decodeXml(value: string): string {
  const entities = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
  } as const;
  return value.replace(
    /&(amp|lt|gt|quot|apos);/gu,
    (_match, name: keyof typeof entities) => {
      return entities[name];
    },
  );
}

export function parseSitemap(text: string, maxDecodePasses: number): string[] {
  const routes: string[] = [];
  const expression = /<loc\b[^>]*>([\s\S]*?)<\/loc>/giu;
  let match: RegExpExecArray | null;
  while ((match = expression.exec(text)) !== null) {
    const value = decodeXml(match[1]?.trim() ?? '');
    if (!value) continue;
    try {
      const canonical = canonicalizeUrl(value, maxDecodePasses);
      const url = new URL(canonical, 'https://surfaceguard.invalid');
      routes.push(`${url.pathname}${url.search}`);
    } catch {
      continue;
    }
  }
  return routes;
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
