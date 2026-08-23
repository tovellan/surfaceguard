import { basename } from 'node:path';

import { classifyGeneric } from './generic.js';
import { AdapterBudget } from './limits.js';
import { rethrowOperationalError } from '../errors.js';
import type {
  ArtifactFile,
  ArtifactKind,
  Finding,
  FrameworkAdapter,
  RouteEvidence,
} from '../types.js';

const NEXT_MANIFESTS = new Set([
  'app-paths-manifest.json',
  'build-manifest.json',
  'pages-manifest.json',
  'prerender-manifest.json',
  'routes-manifest.json',
]);

function addRoute(
  routes: RouteEvidence[],
  seen: Set<string>,
  route: unknown,
  file: ArtifactFile,
  pointer: string,
  budget: AdapterBudget,
  normalize: (value: string) => string | undefined = (value) => value,
): void {
  if (typeof route !== 'string' || !route.startsWith('/')) return;
  const normalized = normalize(route);
  if (!normalized) return;
  const key = `${normalized}\0${file.relativePath}\0${pointer}`;
  if (seen.has(key)) return;
  seen.add(key);
  budget.addRoute(routes, {
    route: normalized,
    artifactPath: file.relativePath,
    pointer,
  });
}

function normalizeAppPath(route: string): string | undefined {
  const segments = route.split('/').filter(Boolean);
  if (segments.at(-1) === 'page' || segments.at(-1) === 'route') segments.pop();
  const publicSegments: string[] = [];

  for (let segment of segments) {
    if (segment.startsWith('@') || /^\([^/]+\)$/u.test(segment)) continue;
    if (segment.startsWith('(...)')) {
      publicSegments.length = 0;
      segment = segment.slice(5);
    } else {
      while (segment.startsWith('(..)')) {
        publicSegments.pop();
        segment = segment.slice(4);
      }
      if (segment.startsWith('(.)')) segment = segment.slice(3);
    }
    if (segment) publicSegments.push(segment);
  }

  if (publicSegments.includes('_not-found')) return undefined;
  return publicSegments.length > 0 ? `/${publicSegments.join('/')}` : '/';
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function collectNextRoutes(
  value: unknown,
  file: ArtifactFile,
  routes: RouteEvidence[],
  budget: AdapterBudget,
): void {
  const root = objectValue(value);
  if (!root) throw new TypeError('Manifest root must be an object');
  const seen = new Set<string>();
  const name = basename(file.relativePath);

  if (name === 'pages-manifest.json') {
    Object.keys(root).forEach((route) =>
      addRoute(routes, seen, route, file, `/${route}`, budget),
    );
    return;
  }
  if (name === 'app-paths-manifest.json') {
    Object.keys(root).forEach((route) =>
      addRoute(routes, seen, route, file, `/${route}`, budget, normalizeAppPath),
    );
    return;
  }
  if (name === 'build-manifest.json') {
    const pages = objectValue(root.pages);
    Object.keys(pages ?? {}).forEach((route) =>
      addRoute(routes, seen, route, file, `/pages/${route}`, budget),
    );
    return;
  }
  if (name === 'prerender-manifest.json') {
    for (const section of ['routes', 'dynamicRoutes'] as const) {
      const entries = objectValue(root[section]);
      Object.keys(entries ?? {}).forEach((route) =>
        addRoute(routes, seen, route, file, `/${section}/${route}`, budget),
      );
    }
    return;
  }
  if (name === 'routes-manifest.json') {
    for (const section of [
      'staticRoutes',
      'dynamicRoutes',
      'dataRoutes',
      'redirects',
      'rewrites',
    ] as const) {
      const entries = root[section];
      if (Array.isArray(entries)) {
        entries.forEach((entry, index) => {
          const candidate = objectValue(entry);
          addRoute(
            routes,
            seen,
            candidate?.page ?? candidate?.source ?? candidate?.pathname,
            file,
            `/${section}/${index}`,
            budget,
          );
        });
      } else if (section === 'rewrites') {
        const groups = objectValue(entries);
        for (const [group, groupEntries] of Object.entries(groups ?? {})) {
          if (!Array.isArray(groupEntries)) continue;
          groupEntries.forEach((entry, index) => {
            const candidate = objectValue(entry);
            addRoute(
              routes,
              seen,
              candidate?.source,
              file,
              `/rewrites/${group}/${index}`,
              budget,
            );
          });
        }
      }
    }
  }
}

export const nextjsAdapter: FrameworkAdapter = {
  name: 'nextjs',
  detect(files): number {
    return files.reduce((score, file) => {
      const name = basename(file.relativePath);
      if (NEXT_MANIFESTS.has(name)) return score + 10;
      if (file.relativePath.includes('static/chunks/')) return score + 2;
      if (file.relativePath.includes('server/')) return score + 1;
      return score;
    }, 0);
  },
  classify(relativePath: string): ArtifactKind | undefined {
    const name = basename(relativePath);
    if (NEXT_MANIFESTS.has(name)) return 'route-manifest';
    return classifyGeneric(relativePath);
  },
  async collectRoutes(context): Promise<{ routes: RouteEvidence[]; findings: Finding[] }> {
    const routes: RouteEvidence[] = [];
    const findings: Finding[] = [];
    const budget = new AdapterBudget(context);
    for (const file of context.files.filter(
      (candidate) =>
        candidate.kind === 'route-manifest' &&
        NEXT_MANIFESTS.has(basename(candidate.relativePath)),
    )) {
      try {
        const value = JSON.parse(await context.readText(file)) as unknown;
        budget.inspectManifest(value, file.relativePath);
        collectNextRoutes(value, file, routes, budget);
      } catch (error) {
        rethrowOperationalError(error);
        findings.push({
          ruleId: 'SG1004',
          severity: 'error',
          category: 'route',
          artifactPath: file.relativePath,
          message: 'Next.js route manifest is malformed or unreadable',
          evidence: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { routes, findings };
  },
};
