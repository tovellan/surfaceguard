import { extname } from 'node:path';

import { classifyGeneric } from './generic.js';
import { encodeArtifactPath } from './artifact-path.js';
import { AdapterBudget } from './limits.js';
import type {
  AdapterContext,
  ArtifactKind,
  Finding,
  FrameworkAdapter,
  RouteEvidence,
} from '../types.js';

const ASTRO_ASSET_DIRECTORY = '_astro/';

function isHtml(relativePath: string): boolean {
  return extname(relativePath.toLowerCase()) === '.html';
}

function routeForHtml(relativePath: string): string {
  if (relativePath === 'index.html') return '/';
  if (relativePath.endsWith('/index.html')) {
    return `/${encodeArtifactPath(relativePath.slice(0, -'index.html'.length))}`;
  }
  return `/${encodeArtifactPath(relativePath)}`;
}

export const astroAdapter: FrameworkAdapter = {
  name: 'astro',
  detect(files): number {
    const hasDefaultAssets = files.some((file) =>
      file.relativePath.startsWith(ASTRO_ASSET_DIRECTORY),
    );
    const hasHtml = files.some((file) => isHtml(file.relativePath));
    return hasDefaultAssets && hasHtml ? files.length * 16 + 1 : 0;
  },
  classify(relativePath: string): ArtifactKind | undefined {
    const generic = classifyGeneric(relativePath);
    if (generic === 'source-map' || generic === 'server-bundle') return generic;
    if (['.js', '.cjs', '.mjs'].includes(extname(relativePath.toLowerCase()))) {
      return 'client-chunk';
    }
    return generic;
  },
  collectRoutes(context: AdapterContext): Promise<{
    routes: RouteEvidence[];
    findings: Finding[];
  }> {
    return Promise.resolve().then(() => {
      const routes: RouteEvidence[] = [];
      const budget = new AdapterBudget(context);
      for (const file of context.files.filter((candidate) =>
        isHtml(candidate.relativePath),
      )) {
        budget.addRoute(routes, {
          route: routeForHtml(file.relativePath),
          artifactPath: file.relativePath,
          pointer: '/',
          routeKind: 'artifact-path' as const,
        });
      }
      return { routes, findings: [] };
    });
  },
};
