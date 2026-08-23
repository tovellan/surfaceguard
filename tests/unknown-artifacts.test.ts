import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { scanArtifacts } from '../src/scan.js';

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('unknown artifact inspection', () => {
  it('scans valid extensionless text with an unscoped text rule', async () => {
    const root = await mkdtemp(join(tmpdir(), 'surfaceguard-extensionless-text-'));
    temporary.push(root);
    await writeFile(
      join(root, 'apple-app-site-association'),
      '{"environment":"INTERNAL_ONLY"}',
      'utf8',
    );

    const result = await scanArtifacts({
      root,
      policy: {
        schemaVersion: 1,
        forbidden: { text: [{ id: 'private-copy', pattern: 'INTERNAL_ONLY' }] },
      },
    });

    expect(result.findings).toContainEqual(
      expect.objectContaining({
        ruleId: 'private-copy',
        artifactPath: 'apple-app-site-association',
      }),
    );
    expect(result.statistics.filesScanned).toBe(1);
  });

  it.each([undefined, ['all'] as const, ['unknown'] as const])(
    'fails closed on ambiguous bytes for an applicable unknown rule scoped as %j',
    async (scopes) => {
      const root = await mkdtemp(join(tmpdir(), 'surfaceguard-explicit-unknown-'));
      temporary.push(root);
      await writeFile(
        join(root, 'opaque-artifact'),
        Buffer.concat([Buffer.from([0xff]), Buffer.from('INTERNAL_ONLY')]),
      );

      const result = await scanArtifacts({
        root,
        policy: {
          schemaVersion: 1,
          forbidden: {
            text: [
              {
                id: 'private-copy',
                pattern: 'INTERNAL_ONLY',
                ...(scopes ? { scopes: [...scopes] } : {}),
              },
            ],
          },
        },
      });

      expect(result.findings).toContainEqual(
        expect.objectContaining({ ruleId: 'SG1003', artifactPath: 'opaque-artifact' }),
      );
      expect(result.findings).toContainEqual(
        expect.objectContaining({
          ruleId: 'private-copy',
          artifactPath: 'opaque-artifact',
        }),
      );
      expect(result.completeness.textInspection).toBe('incomplete');
      expect(result.failed).toBe(true);
    },
  );

  it('probes valid unknown text for source maps without rejecting ordinary binary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'surfaceguard-unknown-source-map-'));
    temporary.push(root);
    await writeFile(join(root, 'extensionless'), '//# sourceMappingURL=private.map');
    await writeFile(join(root, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const result = await scanArtifacts({
      root,
      policy: { schemaVersion: 1, sourceMaps: { mode: 'forbid', inline: 'forbid' } },
    });

    expect(result.findings).toContainEqual(
      expect.objectContaining({ ruleId: 'SG3003', artifactPath: 'extensionless' }),
    );
    expect(result.findings).not.toContainEqual(
      expect.objectContaining({ ruleId: 'SG1003', artifactPath: 'logo.png' }),
    );
    expect(result.completeness.textInspection).toBe('complete');
  });

  it.each([
    { label: 'omitted', scopes: undefined },
    { label: 'all', scopes: ['all'] as const },
  ])(
    'does not interpret valid UTF-8 in a recognized binary when scopes are $label',
    async ({ scopes }) => {
      const root = await mkdtemp(join(tmpdir(), 'surfaceguard-explicit-binary-'));
      temporary.push(root);
      await writeFile(join(root, 'manual.pdf'), '%PDF-1.4\n/Note(INTERNAL_ONLY)\n%%EOF');

      const result = await scanArtifacts({
        root,
        policy: {
          schemaVersion: 1,
          forbidden: {
            text: [
              {
                id: 'private-copy',
                pattern: 'INTERNAL_ONLY',
                ...(scopes ? { scopes: [...scopes] } : {}),
              },
            ],
          },
        },
      });

      expect(result.findings).not.toContainEqual(
        expect.objectContaining({ ruleId: 'private-copy', artifactPath: 'manual.pdf' }),
      );
      expect(result.statistics.filesScanned).toBe(0);
      expect(result.failed).toBe(false);
    },
  );

  it('interprets a recognized binary when a rule explicitly scopes unknown artifacts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'surfaceguard-explicit-binary-'));
    temporary.push(root);
    await writeFile(join(root, 'manual.pdf'), '%PDF-1.4\n/Note(INTERNAL_ONLY)\n%%EOF');

    const result = await scanArtifacts({
      root,
      policy: {
        schemaVersion: 1,
        forbidden: {
          text: [{ id: 'private-copy', pattern: 'INTERNAL_ONLY', scopes: ['unknown'] }],
        },
      },
    });

    expect(result.findings).toContainEqual(
      expect.objectContaining({ ruleId: 'private-copy', artifactPath: 'manual.pdf' }),
    );
    expect(result.statistics.filesScanned).toBe(1);
    expect(result.failed).toBe(true);
  });

  it('does not let invalid-byte padding suppress unscoped matching', async () => {
    const root = await mkdtemp(join(tmpdir(), 'surfaceguard-unknown-padding-'));
    temporary.push(root);
    await writeFile(
      join(root, 'opaque-artifact'),
      Buffer.concat([Buffer.alloc(100, 0xff), Buffer.from('INTERNAL_ONLY')]),
    );
    const result = await scanArtifacts({
      root,
      policy: {
        schemaVersion: 1,
        forbidden: { text: [{ id: 'private-copy', pattern: 'INTERNAL_ONLY' }] },
      },
    });
    expect(result.findings).toContainEqual(
      expect.objectContaining({ ruleId: 'private-copy', artifactPath: 'opaque-artifact' }),
    );
    expect(result.findings).not.toContainEqual(
      expect.objectContaining({ ruleId: 'SG1003', artifactPath: 'opaque-artifact' }),
    );
    expect(result.completeness.textInspection).toBe('incomplete');
    expect(result.statistics.filesScanned).toBe(1);
  });
});
