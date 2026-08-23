import { genericAdapter } from './generic.js';
import { nextjsAdapter } from './nextjs.js';
import { SurfaceGuardError } from '../errors.js';
import type { ArtifactFile, FrameworkAdapter } from '../types.js';

export const adapters: readonly FrameworkAdapter[] = [nextjsAdapter, genericAdapter];

export function selectAdapter(
  requested: 'auto' | 'generic' | 'nextjs',
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

export { genericAdapter } from './generic.js';
export { nextjsAdapter } from './nextjs.js';
