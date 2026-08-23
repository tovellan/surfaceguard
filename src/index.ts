export {
  astroAdapter,
  genericAdapter,
  nextjsAdapter,
  viteAdapter,
  adapters,
} from './adapters/index.js';
export { VERSION, DEFAULT_LIMITS } from './constants.js';
export { canonicalizeUrl, decodeTextVariants, repeatedlyDecodeUrl } from './decode.js';
export { SurfaceGuardError } from './errors.js';
export { globToRegExp, matchesGlob } from './glob.js';
export { loadPolicy, resolveLimits, validatePolicy } from './policy.js';
export { renderJson, renderMarkdown, renderSarif, toSarif } from './reporters/index.js';
export { scanArtifacts } from './scan.js';
export type {
  AdapterContext,
  ArtifactFile,
  ArtifactKind,
  FileRule,
  Finding,
  FrameworkAdapter,
  PatternRule,
  RouteEvidence,
  ScanCompleteness,
  ScanLimits,
  ScanOptions,
  ScanResult,
  Severity,
  SurfaceGuardPolicy,
  SurfaceGuardPolicyV1,
} from './types.js';
