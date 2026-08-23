import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { SurfaceGuardError } from '../src/errors.js';
import { loadPolicy } from '../src/policy.js';
import { scanArtifacts } from '../src/scan.js';
import type { SurfaceGuardPolicy } from '../src/types.js';

const temporary: string[] = [];
const project = resolve(import.meta.dirname, '..');

afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('artifact scanning', () => {
  it('passes the synthetic public Next.js fixture', async () => {
    const policy = await loadPolicy(join(project, 'fixtures/policy.json'));
    const result = await scanArtifacts({
      root: join(project, 'fixtures/next-passing/build'),
      policy,
    });
    expect(result.adapter).toBe('nextjs');
    expect(result.findings).toEqual([]);
    expect(result.failed).toBe(false);
    expect(result.statistics.routesFound).toBe(3);
  });

  it('explains every vulnerable fixture class', async () => {
    const policy = await loadPolicy(join(project, 'fixtures/policy.json'));
    const result = await scanArtifacts({
      root: join(project, 'fixtures/next-vulnerable/build'),
      policy,
    });
    const rules = new Set(result.findings.map((finding) => finding.ruleId));
    expect(rules).toEqual(
      new Set([
        'SG2001',
        'SG2002',
        'SG3001',
        'SG3003',
        'SG4003',
        'SG4004',
        'SG4006',
        'environment-file',
        'private-copy',
        'private-endpoint',
        'private-metadata',
      ]),
    );
    const encoded = result.findings.find(
      (finding) => finding.ruleId === 'private-endpoint',
    );
    expect(encoded).toMatchObject({
      evidence: '%252Fprivate-api%252F',
      transform: 'raw+percent+percent',
    });
    expect(result.failed).toBe(true);
  });

  it('does not follow symlinks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'surfaceguard-symlink-'));
    temporary.push(root);
    await writeFile(join(root, 'safe.js'), 'safe', 'utf8');
    await symlink('/etc/passwd', join(root, 'linked.js'));
    const result = await scanArtifacts({ root, policy: { schemaVersion: 1 } });
    expect(result.findings).toContainEqual(
      expect.objectContaining({ ruleId: 'SG1002', artifactPath: 'linked.js' }),
    );
  });

  it('rejects symlink roots and bounded resource excess', async () => {
    const root = await mkdtemp(join(tmpdir(), 'surfaceguard-root-'));
    temporary.push(root);
    const linkedRoot = `${root}-link`;
    temporary.push(linkedRoot);
    await symlink(root, linkedRoot);
    await expect(
      scanArtifacts({ root: linkedRoot, policy: { schemaVersion: 1 } }),
    ).rejects.toMatchObject({
      code: 'SG_ROOT_INVALID',
    });
    await writeFile(join(root, 'large.js'), '0123456789', 'utf8');
    await expect(
      scanArtifacts({
        root,
        policy: { schemaVersion: 1, limits: { maxFileBytes: 5 } },
      }),
    ).rejects.toBeInstanceOf(SurfaceGuardError);
  });

  it('reports malformed manifests without exposing an exception', async () => {
    const root = await mkdtemp(join(tmpdir(), 'surfaceguard-malformed-'));
    temporary.push(root);
    await mkdir(join(root, 'server'));
    await writeFile(join(root, 'server/pages-manifest.json'), '{bad json', 'utf8');
    const result = await scanArtifacts({
      root,
      policy: { schemaVersion: 1, adapter: 'nextjs' },
    });
    expect(result.findings).toContainEqual(expect.objectContaining({ ruleId: 'SG1004' }));
  });

  it('supports regex rules and severity thresholds', async () => {
    const root = await mkdtemp(join(tmpdir(), 'surfaceguard-regex-'));
    temporary.push(root);
    await writeFile(join(root, 'bundle.js'), 'const endpoint="/service/42"', 'utf8');
    const policy: SurfaceGuardPolicy = {
      schemaVersion: 1,
      failOn: 'error',
      forbidden: {
        endpoints: [
          {
            id: 'service-number',
            pattern: '/service/\\d+',
            match: 'regex',
            severity: 'warning',
          },
        ],
      },
    };
    const result = await scanArtifacts({ root, policy });
    expect(result.findings[0]).toMatchObject({
      ruleId: 'service-number',
      severity: 'warning',
    });
    expect(result.failed).toBe(false);
  });

  it('rejects adversarial nested-quantifier regular expressions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'surfaceguard-regex-'));
    temporary.push(root);
    await writeFile(join(root, 'bundle.js'), 'aaaaaaaaaaaaaaaa', 'utf8');
    await expect(
      scanArtifacts({
        root,
        policy: {
          schemaVersion: 1,
          forbidden: { text: [{ id: 'unsafe-regex', pattern: '(a+)+$', match: 'regex' }] },
        },
      }),
    ).rejects.toMatchObject({ code: 'SG_CONFIG_INVALID' });
  });

  it('distinguishes inline source map policy from missing sitemap policy', async () => {
    const root = await mkdtemp(join(tmpdir(), 'surfaceguard-inline-map-'));
    temporary.push(root);
    await writeFile(
      join(root, 'bundle.js'),
      'console.log("safe")\n//# sourceMappingURL=data:application/json;base64,e30=',
      'utf8',
    );
    const allowed = await scanArtifacts({
      root,
      policy: { schemaVersion: 1, sourceMaps: { mode: 'forbid', inline: 'allow' } },
    });
    expect(allowed.findings).toEqual([]);
    const forbidden = await scanArtifacts({
      root,
      policy: {
        schemaVersion: 1,
        sourceMaps: { mode: 'forbid', inline: 'forbid' },
        sitemap: { mode: 'required' },
      },
    });
    expect(new Set(forbidden.findings.map((finding) => finding.ruleId))).toEqual(
      new Set(['SG3002', 'SG4001']),
    );
  });

  it('streams fixture text without changing its bytes', async () => {
    const value = await readFile(
      join(project, 'fixtures/next-passing/build/static/chunks/app.js'),
      'utf8',
    );
    expect(Buffer.byteLength(value)).toBeGreaterThan(80);
  });
});
