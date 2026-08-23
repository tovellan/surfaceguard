import { describe, expect, it } from 'vitest';

import { SurfaceGuardError } from '../src/errors.js';
import { resolveLimits, validatePolicy } from '../src/policy.js';

describe('policy validation', () => {
  it('accepts a minimal version 1 policy and supplies limits', () => {
    const policy = validatePolicy({ schemaVersion: 1 });
    const limits = resolveLimits(policy);
    expect(limits.maxFiles).toBeGreaterThan(1_000);
    expect(limits.maxEntries).toBeGreaterThan(0);
    expect(limits.maxDirectories).toBeGreaterThan(0);
    expect(limits.maxDepth).toBeGreaterThan(0);
    expect(limits.maxRoutes).toBeGreaterThan(0);
    expect(limits.maxManifestEntries).toBeGreaterThan(0);
    expect(limits.maxSitemapEntries).toBeGreaterThan(0);
    expect(limits.maxRobotsRules).toBeGreaterThan(0);
    expect(limits.maxRobotsComparisons).toBeGreaterThan(0);
    expect(limits.maxRobotsWork).toBeGreaterThan(0);
    expect(validatePolicy({ schemaVersion: 1, adapter: 'vite' }).adapter).toBe('vite');
    expect(validatePolicy({ schemaVersion: 1, adapter: 'astro' }).adapter).toBe('astro');
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

  it.each([
    [{ schemaVersion: 1, routes: { deny: ['[z-a]'] } }, '$.routes.deny[0]'],
    [
      {
        schemaVersion: 1,
        forbidden: { files: [{ id: 'private-file', glob: '[z-a]' }] },
      },
      '$.forbidden.files[0].glob',
    ],
    [
      {
        schemaVersion: 1,
        forbidden: { text: [{ id: 'broken-regex', pattern: '(', match: 'regex' }] },
      },
      '$.forbidden.text[0].pattern',
    ],
    [
      {
        schemaVersion: 1,
        forbidden: {
          endpoints: [{ id: 'nested-regex', pattern: '(a+)+', match: 'regex' }],
        },
      },
      '$.forbidden.endpoints[0].pattern',
    ],
    [
      {
        schemaVersion: 1,
        limits: { maxPatternLength: 3 },
        forbidden: { metadata: [{ id: 'long-pattern', pattern: 'four' }] },
      },
      '$.forbidden.metadata[0].pattern',
    ],
    [
      {
        schemaVersion: 1,
        limits: { maxPatternLength: 3 },
        exclude: ['four'],
      },
      '$.exclude[0]',
    ],
  ])('eagerly rejects an unusable pattern %#', (input, path) => {
    try {
      validatePolicy(input);
      expect.fail('expected validation to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(SurfaceGuardError);
      expect(error).toMatchObject({
        code: 'SG_CONFIG_INVALID',
        details: { path },
      });
    }
  });

  it.each([
    [{ schemaVersion: 1, exclude: ['dist/**', 'dist/**'] }, '$.exclude[1]'],
    [{ schemaVersion: 1, routes: { require: ['/docs', '/docs'] } }, '$.routes.require[1]'],
    [
      {
        schemaVersion: 1,
        forbidden: {
          text: [{ id: 'scoped', pattern: 'secret', scopes: ['unknown', 'unknown'] }],
        },
      },
      '$.forbidden.text[0].scopes[1]',
    ],
  ])('rejects duplicate values where the schema requires uniqueness %#', (input, path) => {
    try {
      validatePolicy(input);
      expect.fail('expected validation to fail');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'SG_CONFIG_INVALID',
        details: { path },
      });
    }
  });

  it('rejects limit integers outside the JSON-safe range', () => {
    expect(() =>
      validatePolicy({
        schemaVersion: 1,
        limits: { maxFiles: Number.MAX_SAFE_INTEGER + 1 },
      }),
    ).toThrow('positive integer');
  });

  it.each([
    { schemaVersion: 1, exclude: new Array<string>(1) },
    { schemaVersion: 1, routes: { deny: new Array<string>(1) } },
    { schemaVersion: 1, forbidden: { text: new Array(1) } },
    { schemaVersion: 1, forbidden: { files: new Array(1) } },
  ])('rejects sparse arrays supplied through the library API', (input) => {
    expect(() => validatePolicy(input)).toThrow(
      expect.objectContaining({ code: 'SG_CONFIG_INVALID' }),
    );
  });

  it.each([
    {
      schemaVersion: 1,
      forbidden: { text: [{ id: `a${'b'.repeat(255)}`, pattern: 'x' }] },
    },
    {
      schemaVersion: 1,
      forbidden: {
        files: [{ id: 'long-message', glob: '*', message: '😀'.repeat(513) }],
      },
    },
  ])('rejects policy-controlled output fields beyond their UTF-8 ceilings', (input) => {
    expect(() => validatePolicy(input)).toThrow(
      expect.objectContaining({ code: 'SG_CONFIG_INVALID' }),
    );
  });
});
