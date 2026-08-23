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
  'app-path-routes-manifest.json',
  'app-paths-manifest.json',
  'build-manifest.json',
  'pages-manifest.json',
  'prerender-manifest.json',
  'routes-manifest.json',
]);
const NEXT_INTERNAL_APP_ROUTES = new Set(['/_global-error', '/_not-found']);

export function isNextManifest(relativePath: string): boolean {
  return NEXT_MANIFESTS.has(basename(relativePath));
}

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

  const normalized = publicSegments.length > 0 ? `/${publicSegments.join('/')}` : '/';
  return NEXT_INTERNAL_APP_ROUTES.has(normalized) ? undefined : normalized;
}

function normalizeAppRoute(route: string): string | undefined {
  return NEXT_INTERNAL_APP_ROUTES.has(route) ? undefined : route;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function objectSection(
  root: Record<string, unknown>,
  section: string,
  manifest: string,
): Record<string, unknown> | undefined {
  const value = root[section];
  if (value === undefined) return undefined;
  const object = objectValue(value);
  if (!object) throw new TypeError(`${manifest} ${section} must be an object`);
  return object;
}

function objectArraySection(
  root: Record<string, unknown>,
  section: string,
  manifest: string,
): Record<string, unknown>[] | undefined {
  const value = root[section];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => objectValue(entry) === undefined)) {
    throw new TypeError(`${manifest} ${section} must be an array of objects`);
  }
  return value as Record<string, unknown>[];
}

function requiredRoute(value: unknown, location: string): string {
  if (typeof value !== 'string' || value.length === 0 || !value.startsWith('/')) {
    throw new TypeError(`${location} must name a non-empty absolute route string`);
  }
  return value;
}

function rewriteSections(
  root: Record<string, unknown>,
  manifest: string,
): readonly { group?: string; entries: Record<string, unknown>[] }[] {
  const value = root.rewrites;
  if (value === undefined) return [];
  if (Array.isArray(value)) {
    if (value.some((entry) => objectValue(entry) === undefined)) {
      throw new TypeError(`${manifest} rewrites must be an array of objects`);
    }
    return [{ entries: value as Record<string, unknown>[] }];
  }
  const groups = objectValue(value);
  if (!groups) {
    throw new TypeError(`${manifest} rewrites must be an array or grouped object`);
  }
  const sections: { group: string; entries: Record<string, unknown>[] }[] = [];
  for (const group of ['beforeFiles', 'afterFiles', 'fallback']) {
    const entries = groups[group];
    if (entries === undefined) continue;
    if (
      !Array.isArray(entries) ||
      entries.some((entry) => objectValue(entry) === undefined)
    ) {
      throw new TypeError(`${manifest} rewrites.${group} must be an array of objects`);
    }
    sections.push({ group, entries: entries as Record<string, unknown>[] });
  }
  return sections;
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
  if (name === 'app-path-routes-manifest.json') {
    Object.entries(root).forEach(([appPath, route]) =>
      addRoute(
        routes,
        seen,
        requiredRoute(route, `${name} ${appPath}`),
        file,
        `/${appPath}`,
        budget,
        normalizeAppRoute,
      ),
    );
    return;
  }
  if (name === 'build-manifest.json') {
    const pages = objectSection(root, 'pages', name);
    Object.keys(pages ?? {}).forEach((route) =>
      addRoute(routes, seen, route, file, `/pages/${route}`, budget),
    );
    return;
  }
  if (name === 'prerender-manifest.json') {
    for (const section of ['routes', 'dynamicRoutes'] as const) {
      const entries = objectSection(root, section, name);
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
    ] as const) {
      const entries = objectArraySection(root, section, name) ?? [];
      entries.forEach((candidate, index) => {
        const location = `${name} ${section}[${index}]`;
        addRoute(
          routes,
          seen,
          requiredRoute(
            section === 'redirects'
              ? candidate.source
              : (candidate.page ?? candidate.source ?? candidate.pathname),
            location,
          ),
          file,
          `/${section}/${index}`,
          budget,
        );
      });
    }
    for (const rewrite of rewriteSections(root, name)) {
      rewrite.entries.forEach((candidate, index) => {
        const location = rewrite.group
          ? `${name} rewrites.${rewrite.group}[${index}]`
          : `${name} rewrites[${index}]`;
        addRoute(
          routes,
          seen,
          requiredRoute(candidate.source, location),
          file,
          rewrite.group ? `/rewrites/${rewrite.group}/${index}` : `/rewrites/${index}`,
          budget,
        );
      });
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
