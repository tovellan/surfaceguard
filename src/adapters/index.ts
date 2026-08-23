import { extname } from 'node:path';

import { astroAdapter } from './astro.js';
import { genericAdapter } from './generic.js';
import { isNextManifest, nextjsAdapter } from './nextjs.js';
import { viteAdapter } from './vite.js';
import { SurfaceGuardError } from '../errors.js';
import type { ArtifactFile, FrameworkAdapter } from '../types.js';

export const adapters: readonly FrameworkAdapter[] = [
  nextjsAdapter,
  astroAdapter,
  viteAdapter,
  genericAdapter,
];

function strongAutoSignals(files: readonly ArtifactFile[]): {
  frameworks: string[];
  genericRouteManifest: boolean;
} {
  const frameworks: string[] = [];
  if (files.some((file) => isNextManifest(file.relativePath))) frameworks.push('nextjs');
  if (
    files.some((file) => extname(file.relativePath.toLowerCase()) === '.html') &&
    files.some((file) => file.relativePath.startsWith('_astro/'))
  ) {
    frameworks.push('astro');
  }
  if (files.some((file) => file.relativePath === '.vite/manifest.json')) {
    frameworks.push('vite');
  }
  const genericRouteManifest = files.some(
    (file) =>
      !isNextManifest(file.relativePath) &&
      genericAdapter.classify(file.relativePath) === 'route-manifest',
  );
  return { frameworks, genericRouteManifest };
}

export function selectAdapter(
  requested: 'auto' | 'astro' | 'generic' | 'nextjs' | 'vite',
  files: readonly ArtifactFile[],
): FrameworkAdapter {
  if (requested !== 'auto') {
    const exact = adapters.find((adapter) => adapter.name === requested);
    if (!exact)
      throw new SurfaceGuardError('SG_CONFIG_INVALID', `Unknown adapter: ${requested}`);
    return exact;
  }
  const signals = strongAutoSignals(files);
  if (
    signals.frameworks.length > 1 ||
    (signals.genericRouteManifest && signals.frameworks.length > 0)
  ) {
    const conflicts = [
      ...signals.frameworks,
      ...(signals.genericRouteManifest ? ['generic-route-manifest'] : []),
    ];
    throw new SurfaceGuardError(
      'SG_CONFIG_INVALID',
      `Artifact contains conflicting adapter signals (${conflicts.join(', ')}); select an adapter explicitly`,
      { signals: conflicts },
    );
  }
  const strongFramework = signals.frameworks[0];
  if (strongFramework) {
    return adapters.find((adapter) => adapter.name === strongFramework) ?? genericAdapter;
  }
  if (signals.genericRouteManifest) return genericAdapter;
  return (
    [...adapters].sort((left, right) => right.detect(files) - left.detect(files))[0] ??
    genericAdapter
  );
}

export { astroAdapter } from './astro.js';
export { genericAdapter } from './generic.js';
export { nextjsAdapter } from './nextjs.js';
export { viteAdapter } from './vite.js';
