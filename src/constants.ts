import type { ScanLimits } from './types.js';

export const VERSION = '0.5.0';

export const DEFAULT_LIMITS: Readonly<ScanLimits> = Object.freeze({
  maxEntries: 100_000,
  maxDirectories: 10_000,
  maxDepth: 64,
  maxFiles: 50_000,
  maxFileBytes: 16 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
  maxRoutes: 50_000,
  maxManifestEntries: 100_000,
  maxSitemapEntries: 50_000,
  maxFindings: 1_000,
  maxDecodePasses: 3,
  maxPatternLength: 1_024,
});
