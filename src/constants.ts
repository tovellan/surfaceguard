import type { ScanLimits } from './types.js';

export const VERSION = '0.4.0';

export const DEFAULT_LIMITS: Readonly<ScanLimits> = Object.freeze({
  maxFiles: 50_000,
  maxFileBytes: 16 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
  maxFindings: 1_000,
  maxDecodePasses: 3,
  maxPatternLength: 1_024,
});
