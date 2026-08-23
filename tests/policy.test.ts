import { describe, expect, it } from 'vitest';

import { SurfaceGuardError } from '../src/errors.js';
import { resolveLimits, validatePolicy } from '../src/policy.js';

describe('policy validation', () => {
  it('accepts a minimal version 1 policy and supplies limits', () => {
    const policy = validatePolicy({ schemaVersion: 1 });
    expect(resolveLimits(policy).maxFiles).toBeGreaterThan(1_000);
    expect(validatePolicy({ schemaVersion: 1, adapter: 'vite' }).adapter).toBe('vite');
  });

  it.each([
    [{ schemaVersion: 2 }, 'schemaVersion'],
    [{ schemaVersion: 1, unknown: true }, 'unknown'],
    [{ schemaVersion: 1, routes: { allow: [1] } }, 'allow'],
    [{ schemaVersion: 1, sourceMaps: { mode: 'sometimes' } }, 'mode'],
    [{ schemaVersion: 1, limits: { maxFiles: 0 } }, 'positive'],
    [
      { schemaVersion: 1, forbidden: { text: [{ id: 'Bad ID', pattern: 'x' }] } },
      'identifier',
    ],
    [
      {
        schemaVersion: 1,
        forbidden: { files: [{ id: 'private-file', glob: '*.txt', message: 42 }] },
      },
      'message',
    ],
  ])('rejects malformed policy %#', (input, message) => {
    expect(() => validatePolicy(input)).toThrow(message);
  });

  it('returns machine-readable configuration errors', () => {
    try {
      validatePolicy({ schemaVersion: 7 });
      expect.fail('expected validation to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(SurfaceGuardError);
      expect((error as SurfaceGuardError).toJSON()).toMatchObject({
        code: 'SG_CONFIG_INVALID',
      });
    }
  });
});
