import { astroAdapter } from './astro.js';
import { genericAdapter } from './generic.js';
import { nextjsAdapter } from './nextjs.js';
import { viteAdapter } from './vite.js';
import { SurfaceGuardError } from '../errors.js';
import type { ArtifactFile, FrameworkAdapter } from '../types.js';

export const adapters: readonly FrameworkAdapter[] = [
  nextjsAdapter,
  astroAdapter,
  viteAdapter,
  genericAdapter,
];

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
  return (
    [...adapters].sort((left, right) => right.detect(files) - left.detect(files))[0] ??
    genericAdapter
  );
}

export { astroAdapter } from './astro.js';
export { genericAdapter } from './generic.js';
export { nextjsAdapter } from './nextjs.js';
export { viteAdapter } from './vite.js';
