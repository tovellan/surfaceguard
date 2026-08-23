import { basename } from 'node:path';

import { classifyGeneric } from './generic.js';
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
): void {
  if (typeof route !== 'string' || !route.startsWith('/')) return;
  const normalized = route.endsWith('/page') ? route.slice(0, -5) || '/' : route;
  const key = `${normalized}\0${file.relativePath}\0${pointer}`;
  if (seen.has(key)) return;
  seen.add(key);
  routes.push({ route: normalized, artifactPath: file.relativePath, pointer });
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
): void {
  const root = objectValue(value);
  if (!root) throw new TypeError('Manifest root must be an object');
  const seen = new Set<string>();
  const name = basename(file.relativePath);

  if (name === 'pages-manifest.json' || name === 'app-paths-manifest.json') {
    Object.keys(root).forEach((route) => addRoute(routes, seen, route, file, `/${route}`));
    return;
  }
  if (name === 'build-manifest.json') {
    const pages = objectValue(root.pages);
    Object.keys(pages ?? {}).forEach((route) =>
      addRoute(routes, seen, route, file, `/pages/${route}`),
    );
    return;
  }
  if (name === 'prerender-manifest.json') {
    for (const section of ['routes', 'dynamicRoutes'] as const) {
      const entries = objectValue(root[section]);
      Object.keys(entries ?? {}).forEach((route) =>
        addRoute(routes, seen, route, file, `/${section}/${route}`),
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
          );
        });
      } else if (section === 'rewrites') {
        const groups = objectValue(entries);
        for (const [group, groupEntries] of Object.entries(groups ?? {})) {
          if (!Array.isArray(groupEntries)) continue;
          groupEntries.forEach((entry, index) => {
            const candidate = objectValue(entry);
            addRoute(routes, seen, candidate?.source, file, `/rewrites/${group}/${index}`);
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
    for (const file of context.files.filter(
      (candidate) =>
        candidate.kind === 'route-manifest' &&
        NEXT_MANIFESTS.has(basename(candidate.relativePath)),
    )) {
      try {
        collectNextRoutes(
          JSON.parse(await context.readText(file)) as unknown,
          file,
          routes,
        );
      } catch (error) {
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
