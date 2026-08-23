import { basename, extname } from 'node:path';

import { rethrowOperationalError } from '../errors.js';
import { AdapterBudget } from './limits.js';
import type {
  AdapterContext,
  ArtifactKind,
  Finding,
  FrameworkAdapter,
  RouteEvidence,
} from '../types.js';

const ROUTE_KEYS = new Set(['page', 'path', 'pathname', 'route', 'routes']);
const SITEMAP_FILENAME =
  /^sitemap(?:(?:[_-]?index)|(?:[_-]?\d+)|(?:-[^/]*))?\.xml(?:\.gz)?$/u;

export function classifyGeneric(relativePath: string): ArtifactKind {
  const lower = relativePath.toLowerCase();
  const name = basename(lower);
  const extension = extname(lower);
  if (name === 'robots.txt') return 'robots';
  if (SITEMAP_FILENAME.test(name)) return 'sitemap';
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
  routes: RouteEvidence[],
  budget: AdapterBudget,
): void {
  const pending: { value: unknown; pointer: string; key?: string }[] = [
    { value, pointer: '' },
  ];
  while (pending.length > 0) {
    budget.checkSignal();
    const current = pending.pop();
    if (!current) continue;
    if (typeof current.value === 'string') {
      if (
        current.value.startsWith('/') &&
        (current.key === undefined || ROUTE_KEYS.has(current.key))
      ) {
        budget.addRoute(routes, {
          route: current.value,
          artifactPath,
          pointer: current.pointer,
        });
      }
      continue;
    }
    if (Array.isArray(current.value)) {
      for (let index = current.value.length - 1; index >= 0; index -= 1) {
        pending.push({
          value: current.value[index],
          pointer: `${current.pointer}/${index}`,
          ...(current.key === undefined ? {} : { key: current.key }),
        });
      }
      continue;
    }
    if (!current.value || typeof current.value !== 'object') continue;
    const record = current.value as Record<string, unknown>;
    const keys = Object.keys(record);
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const childKey = keys[index];
      if (childKey === undefined) continue;
      pending.push({
        value: record[childKey],
        pointer: `${current.pointer}/${childKey}`,
        key: childKey,
      });
    }
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
    const budget = new AdapterBudget(context);
    for (const file of context.files.filter(
      (candidate) => candidate.kind === 'route-manifest',
    )) {
      try {
        const value = JSON.parse(await context.readText(file)) as unknown;
        budget.inspectManifest(value, file.relativePath);
        walkRoutes(value, file.relativePath, routes, budget);
      } catch (error) {
        rethrowOperationalError(error);
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
