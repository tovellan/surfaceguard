import { basename, extname } from 'node:path';

import type {
  AdapterContext,
  ArtifactKind,
  Finding,
  FrameworkAdapter,
  RouteEvidence,
} from '../types.js';

const ROUTE_KEYS = new Set(['page', 'path', 'pathname', 'route']);

export function classifyGeneric(relativePath: string): ArtifactKind {
  const lower = relativePath.toLowerCase();
  const name = basename(lower);
  const extension = extname(lower);
  if (name === 'robots.txt') return 'robots';
  if (/^sitemap(?:-[^/]*)?\.xml$/u.test(name) || name === 'sitemap.xml.gz')
    return 'sitemap';
  if (name.endsWith('.map') || name.endsWith('.map.json')) return 'source-map';
  if (
    name.includes('routes-manifest') ||
    name.includes('route-manifest') ||
    name === 'pages-manifest.json' ||
    name === 'app-paths-manifest.json' ||
    name === 'prerender-manifest.json'
  ) {
    return 'route-manifest';
  }
  if (name === 'manifest.json' || name.endsWith('.webmanifest') || extension === '.html') {
    return 'metadata';
  }
  if (
    /\/(?:server|serverless)\//u.test(`/${lower}`) &&
    ['.js', '.cjs', '.mjs'].includes(extension)
  ) {
    return 'server-bundle';
  }
  if (
    /\/(?:static\/chunks|chunks|assets)\//u.test(`/${lower}`) &&
    ['.js', '.cjs', '.mjs'].includes(extension)
  ) {
    return 'client-chunk';
  }
  if (
    ['.js', '.cjs', '.mjs', '.css', '.json', '.xml', '.txt', '.html', '.svg'].includes(
      extension,
    )
  ) {
    return 'static-asset';
  }
  return 'unknown';
}

function walkRoutes(
  value: unknown,
  artifactPath: string,
  pointer: string,
  routes: RouteEvidence[],
  key?: string,
): void {
  if (typeof value === 'string') {
    if (value.startsWith('/') && (key === undefined || ROUTE_KEYS.has(key))) {
      routes.push({ route: value, artifactPath, pointer });
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      walkRoutes(item, artifactPath, `${pointer}/${index}`, routes, key),
    );
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
    walkRoutes(child, artifactPath, `${pointer}/${childKey}`, routes, childKey);
  }
}

export const genericAdapter: FrameworkAdapter = {
  name: 'generic',
  detect: () => 1,
  classify: classifyGeneric,
  async collectRoutes(context: AdapterContext): Promise<{
    routes: RouteEvidence[];
    findings: Finding[];
  }> {
    const routes: RouteEvidence[] = [];
    const findings: Finding[] = [];
    for (const file of context.files.filter(
      (candidate) => candidate.kind === 'route-manifest',
    )) {
      try {
        const value = JSON.parse(await context.readText(file)) as unknown;
        walkRoutes(value, file.relativePath, '', routes);
      } catch (error) {
        findings.push({
          ruleId: 'SG1004',
          severity: 'error',
          category: 'route',
          artifactPath: file.relativePath,
          message: 'Route manifest is malformed or unreadable',
          evidence: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { routes, findings };
  },
};
