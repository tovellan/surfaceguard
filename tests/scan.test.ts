import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

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

  it('auto-detects Vite and evaluates produced HTML routes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'surfaceguard-vite-'));
    temporary.push(root);
    await mkdir(join(root, '.vite'));
    await writeFile(join(root, 'index.html'), '<main>Home</main>', 'utf8');
    await writeFile(join(root, 'admin.html'), '<main>Admin</main>', 'utf8');
    await writeFile(
      join(root, '.vite/manifest.json'),
      JSON.stringify({ 'src/main.ts': { file: 'assets/main.js', isEntry: true } }),
      'utf8',
    );
    const result = await scanArtifacts({
      root,
      policy: { schemaVersion: 1, routes: { deny: ['/admin.html'] } },
    });
    expect(result.adapter).toBe('vite');
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        ruleId: 'SG2002',
        artifactPath: 'admin.html',
        evidence: '/admin.html',
      }),
    );
  });

  it('keeps filesystem delimiters inside Astro artifact routes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'surfaceguard-astro-paths-'));
    temporary.push(root);
    await mkdir(join(root, '_astro'));
    await mkdir(join(root, 'docs'));
    await writeFile(join(root, 'index.html'), '<main>Home</main>', 'utf8');
    await writeFile(join(root, '_astro/app.js'), 'console.log("public")', 'utf8');
    await writeFile(join(root, 'docs/private#draft.html'), '<main>Draft</main>', 'utf8');
    await writeFile(join(root, 'docs/private?draft.html'), '<main>Draft</main>', 'utf8');
    await writeFile(join(root, 'docs/private%23draft.html'), '<main>Draft</main>', 'utf8');
    const result = await scanArtifacts({
      root,
      policy: {
        schemaVersion: 1,
        routes: {
          deny: [
            '/docs/private%23draft.html',
            '/docs/private%3Fdraft.html',
            '/docs/private%2523draft.html',
          ],
        },
      },
    });
    expect(result.adapter).toBe('astro');
    expect(
      new Set(
        result.findings
          .filter((finding) => finding.ruleId === 'SG2002')
          .map((finding) => finding.evidence),
      ),
    ).toEqual(
      new Set([
        '/docs/private%2523draft.html',
        '/docs/private%23draft.html',
        '/docs/private%3Fdraft.html',
      ]),
    );
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
    await writeFile(join(root, 'large.bin'), '0123456789', 'utf8');
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

  it('retains exact empty evidence for zero-width decoded regex matches', async () => {
    const root = await mkdtemp(join(tmpdir(), 'surfaceguard-zero-width-'));
    temporary.push(root);
    await writeFile(join(root, 'bundle.js'), '%41', 'utf8');
    const result = await scanArtifacts({
      root,
      policy: {
        schemaVersion: 1,
        forbidden: {
          text: [
            {
              id: 'decoded-boundary',
              pattern: '(?<=A)$',
              match: 'regex',
            },
          ],
        },
      },
    });
    const boundary = result.findings.find(
      (finding) => finding.ruleId === 'decoded-boundary',
    );
    expect(boundary).toMatchObject({
      evidence: '',
      transform: 'raw+percent',
    });
    expect(boundary?.location?.offset).toBe(3);
  });

  it.each(['literal', 'regex'] as const)(
    'bounds repeated %s matches before allocating the complete match set',
    async (match) => {
      const root = await mkdtemp(join(tmpdir(), 'surfaceguard-findings-'));
      temporary.push(root);
      await writeFile(join(root, 'bundle.js'), 'a'.repeat(256 * 1024), 'utf8');
      const result = await scanArtifacts({
        root,
        policy: {
          schemaVersion: 1,
          limits: { maxFindings: 7 },
          forbidden: { text: [{ id: 'repeated-text', pattern: 'a', match }] },
        },
      });
      expect(result.findings).toHaveLength(7);
      expect(result.statistics.findingsTruncated).toBe(true);
    },
  );

  it('does not let low-severity findings hide a later failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'surfaceguard-finding-threshold-'));
    temporary.push(root);
    await writeFile(join(root, 'a.js'), 'xxxxx', 'utf8');
    await writeFile(join(root, 'z.js'), 'SECRET', 'utf8');
    const result = await scanArtifacts({
      root,
      policy: {
        schemaVersion: 1,
        failOn: 'error',
        limits: { maxFindings: 2 },
        forbidden: {
          text: [
            { id: 'bait', pattern: 'x', severity: 'note' },
            { id: 'private-copy', pattern: 'SECRET', severity: 'error' },
          ],
        },
      },
    });
    expect(result.failed).toBe(true);
    expect(result.statistics.filesScanned).toBe(2);
    expect(result.statistics.findingsTruncated).toBe(true);
    expect(result.findings).toHaveLength(2);
    expect(result.findings).toContainEqual(
      expect.objectContaining({ ruleId: 'private-copy', severity: 'error' }),
    );
  });

  it('lets later high-severity matches displace every retained note', async () => {
    const root = await mkdtemp(join(tmpdir(), 'surfaceguard-finding-priority-'));
    temporary.push(root);
    await writeFile(join(root, 'bundle.js'), 'xxxxxSECRETSECRET', 'utf8');
    const result = await scanArtifacts({
      root,
      policy: {
        schemaVersion: 1,
        limits: { maxFindings: 2 },
        forbidden: {
          text: [
            { id: 'bait', pattern: 'x', severity: 'note' },
            { id: 'private-copy', pattern: 'SECRET', severity: 'error' },
          ],
        },
      },
    });
    expect(result.findings).toHaveLength(2);
    expect(result.findings.every((finding) => finding.severity === 'error')).toBe(true);
    expect(result.failed).toBe(true);
  });

  it('can truncate note details without turning an error threshold into failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'surfaceguard-note-truncation-'));
    temporary.push(root);
    await writeFile(join(root, 'bundle.js'), 'xxxxx', 'utf8');
    const result = await scanArtifacts({
      root,
      policy: {
        schemaVersion: 1,
        failOn: 'error',
        limits: { maxFindings: 2 },
        forbidden: { text: [{ id: 'advisory', pattern: 'x', severity: 'note' }] },
      },
    });
    expect(result.findings).toHaveLength(2);
    expect(result.completeness.findingDetails).toBe('truncated');
    expect(result.failed).toBe(false);
  });

  it.each(['utf-16le', 'utf-16be'] as const)(
    'scans BOM-tagged %s text artifacts',
    async (encoding) => {
      const root = await mkdtemp(join(tmpdir(), `surfaceguard-${encoding}-`));
      temporary.push(root);
      const body = Buffer.from('const value = "INTERNAL_ONLY";', 'utf16le');
      if (encoding === 'utf-16be') body.swap16();
      const bom = encoding === 'utf-16le' ? [0xff, 0xfe] : [0xfe, 0xff];
      await writeFile(join(root, 'bundle.js'), Buffer.concat([Buffer.from(bom), body]));
      const result = await scanArtifacts({
        root,
        policy: {
          schemaVersion: 1,
          forbidden: { text: [{ id: 'private-copy', pattern: 'INTERNAL_ONLY' }] },
        },
      });
      expect(result.findings).toContainEqual(
        expect.objectContaining({ ruleId: 'private-copy' }),
      );
      expect(result.findings).not.toContainEqual(
        expect.objectContaining({ ruleId: 'SG1003' }),
      );
    },
  );

  it('decodes a BOM-tagged UTF-16 route manifest before route policy evaluation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'surfaceguard-utf16-manifest-'));
    temporary.push(root);
    await mkdir(join(root, 'server'));
    const body = Buffer.from(JSON.stringify({ '/private': 'private.js' }), 'utf16le');
    await writeFile(
      join(root, 'server/pages-manifest.json'),
      Buffer.concat([Buffer.from([0xff, 0xfe]), body]),
    );
    const result = await scanArtifacts({
      root,
      policy: {
        schemaVersion: 1,
        adapter: 'nextjs',
        routes: { deny: ['/private'] },
      },
    });
    expect(result.findings).toContainEqual(
      expect.objectContaining({ ruleId: 'SG2002', evidence: '/private' }),
    );
    expect(result.findings).not.toContainEqual(
      expect.objectContaining({ ruleId: 'SG1003' }),
    );
  });

  it('evaluates valid route escapes adjacent to malformed percent bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'surfaceguard-malformed-route-'));
    temporary.push(root);
    await mkdir(join(root, 'server'));
    await writeFile(
      join(root, 'server/pages-manifest.json'),
      JSON.stringify({ '/%2Fprivate%FF': 'private.js' }),
      'utf8',
    );
    const result = await scanArtifacts({
      root,
      policy: {
        schemaVersion: 1,
        adapter: 'nextjs',
        routes: { deny: ['/private*'] },
      },
    });
    expect(result.findings).toContainEqual(
      expect.objectContaining({ ruleId: 'SG2002', evidence: '/private%FF' }),
    );
  });

  it('treats repeated leading slashes in manifests as route path separators', async () => {
    const root = await mkdtemp(join(tmpdir(), 'surfaceguard-leading-slash-route-'));
    temporary.push(root);
    await mkdir(join(root, 'server'));
    await writeFile(
      join(root, 'server/pages-manifest.json'),
      JSON.stringify({ '//private': 'private.js' }),
      'utf8',
    );
    const result = await scanArtifacts({
      root,
      policy: {
        schemaVersion: 1,
        adapter: 'nextjs',
        routes: { deny: ['/private'] },
      },
    });
    expect(result.findings).toContainEqual(
      expect.objectContaining({ ruleId: 'SG2002', evidence: '/private' }),
    );
  });

  it('retains separate raw evidence for repeated scalars in one percent run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'surfaceguard-percent-spans-'));
    temporary.push(root);
    await writeFile(join(root, 'bundle.js'), '%41%42%41', 'utf8');
    const result = await scanArtifacts({
      root,
      policy: {
        schemaVersion: 1,
        forbidden: { text: [{ id: 'encoded-a', pattern: 'A' }] },
      },
    });
    const matches = result.findings.filter((finding) => finding.ruleId === 'encoded-a');
    expect(matches.map((finding) => finding.evidence)).toEqual(['%41', '%41']);
    expect(matches.map((finding) => finding.location?.offset)).toEqual([0, 6]);
  });

  it('reports one encoding finding when an adapter reads an artifact twice', async () => {
    const root = await mkdtemp(join(tmpdir(), 'surfaceguard-encoding-dedup-'));
    temporary.push(root);
    await mkdir(join(root, 'server'));
    await writeFile(
      join(root, 'server/pages-manifest.json'),
      Buffer.concat([Buffer.from([0xff]), Buffer.from('{"/":"index.js"}')]),
    );
    const result = await scanArtifacts({
      root,
      policy: { schemaVersion: 1, adapter: 'nextjs' },
    });
    expect(result.findings.filter((finding) => finding.ruleId === 'SG1003')).toHaveLength(
      1,
    );
  });

  it('does not apply text-encoding findings to unknown binary artifacts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'surfaceguard-unknown-binary-'));
    temporary.push(root);
    await writeFile(join(root, 'image.png'), Buffer.from([0x00, 0xff, 0x00, 0xff]));
    const result = await scanArtifacts({ root, policy: { schemaVersion: 1 } });
    expect(result.findings).toEqual([]);
    expect(result.completeness.textInspection).toBe('complete');
  });

  it.each([
    ['control-heavy', Buffer.from('\0INTERNAL_ONLY\0', 'utf8')],
    [
      'invalid UTF-8',
      Buffer.concat([Buffer.from([0xff]), Buffer.from('INTERNAL_ONLY', 'utf8')]),
    ],
    [
      'UTF-32 BOM',
      Buffer.concat([
        Buffer.from([0xff, 0xfe, 0x00, 0x00]),
        Buffer.from('INTERNAL_ONLY', 'utf8'),
      ]),
    ],
  ] as const)(
    'fails closed for %s while continuing best-effort matching',
    async (_, body) => {
      const root = await mkdtemp(join(tmpdir(), 'surfaceguard-ambiguous-text-'));
      temporary.push(root);
      await writeFile(join(root, 'bundle.js'), body);
      const result = await scanArtifacts({
        root,
        policy: {
          schemaVersion: 1,
          forbidden: { text: [{ id: 'private-copy', pattern: 'INTERNAL_ONLY' }] },
        },
      });
      expect(result.failed).toBe(true);
      expect(result.findings).toContainEqual(expect.objectContaining({ ruleId: 'SG1003' }));
      expect(result.findings).toContainEqual(
        expect.objectContaining({ ruleId: 'private-copy' }),
      );
    },
  );

  it('fails closed for a detectable unsupported document charset', async () => {
    const root = await mkdtemp(join(tmpdir(), 'surfaceguard-declared-charset-'));
    temporary.push(root);
    await writeFile(
      join(root, 'index.html'),
      '<meta charset="UTF-7"><main>INTERNAL_ONLY</main>',
      'utf8',
    );
    const result = await scanArtifacts({
      root,
      policy: {
        schemaVersion: 1,
        forbidden: { text: [{ id: 'private-copy', pattern: 'INTERNAL_ONLY' }] },
      },
    });
    expect(result.failed).toBe(true);
    expect(result.completeness.textInspection).toBe('incomplete');
    expect(result.findings).toContainEqual(expect.objectContaining({ ruleId: 'SG1003' }));
    expect(result.findings).toContainEqual(
      expect.objectContaining({ ruleId: 'private-copy' }),
    );
  });

  it('does not treat BOMless UTF-16 as a clean text artifact', async () => {
    const root = await mkdtemp(join(tmpdir(), 'surfaceguard-bomless-utf16-'));
    temporary.push(root);
    await writeFile(join(root, 'bundle.js'), Buffer.from('INTERNAL_ONLY', 'utf16le'));
    const result = await scanArtifacts({ root, policy: { schemaVersion: 1 } });
    expect(result.failed).toBe(true);
    expect(result.completeness.textInspection).toBe('incomplete');
    expect(result.findings).toContainEqual(expect.objectContaining({ ruleId: 'SG1003' }));
  });

  it('does not let a full finding report hide a late ambiguous encoding error', async () => {
    const root = await mkdtemp(join(tmpdir(), 'surfaceguard-late-encoding-'));
    temporary.push(root);
    await writeFile(join(root, 'a.js'), 'xxxxx', 'utf8');
    await writeFile(join(root, 'z.js'), Buffer.from([0x00, 0x00, 0x00, 0x00]));
    const result = await scanArtifacts({
      root,
      policy: {
        schemaVersion: 1,
        limits: { maxFindings: 1 },
        forbidden: { text: [{ id: 'bait', pattern: 'x', severity: 'note' }] },
      },
    });
    expect(result.failed).toBe(true);
    expect(result.findings).toEqual([expect.objectContaining({ ruleId: 'SG1003' })]);
  });

  it('preserves evidence spans after astral Unicode characters', async () => {
    const root = await mkdtemp(join(tmpdir(), 'surfaceguard-unicode-'));
    temporary.push(root);
    await writeFile(join(root, 'bundle.js'), '😀INTERNAL_ONLY', 'utf8');
    const result = await scanArtifacts({
      root,
      policy: {
        schemaVersion: 1,
        forbidden: { text: [{ id: 'private-copy', pattern: 'INTERNAL_ONLY' }] },
      },
    });
    const finding = result.findings.find((item) => item.ruleId === 'private-copy');
    expect(finding).toMatchObject({ ruleId: 'private-copy', evidence: 'INTERNAL_ONLY' });
    expect(finding?.location?.offset).toBe(2);
  });

  it('keeps case-insensitive literal evidence aligned after Unicode folding', async () => {
    const root = await mkdtemp(join(tmpdir(), 'surfaceguard-case-fold-'));
    temporary.push(root);
    await writeFile(join(root, 'bundle.js'), 'İSECRET', 'utf8');
    const result = await scanArtifacts({
      root,
      policy: {
        schemaVersion: 1,
        forbidden: {
          text: [{ id: 'case-folded-copy', pattern: 'secret', caseSensitive: false }],
        },
      },
    });
    const finding = result.findings.find((item) => item.ruleId === 'case-folded-copy');
    expect(finding).toMatchObject({ evidence: 'SECRET' });
    expect(finding?.location?.offset).toBe(1);
  });

  it('continues matching after an invalid percent-encoded byte', async () => {
    const root = await mkdtemp(join(tmpdir(), 'surfaceguard-invalid-percent-'));
    temporary.push(root);
    await writeFile(join(root, 'bundle.js'), '%FF%49NTERNAL_ONLY', 'utf8');
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
        evidence: '%49NTERNAL_ONLY',
        transform: 'raw+percent',
      }),
    );
  });

  it('continues matching before an invalid percent-encoded byte', async () => {
    const root = await mkdtemp(join(tmpdir(), 'surfaceguard-invalid-percent-tail-'));
    temporary.push(root);
    const encoded = [...Buffer.from('INTERNAL_ONLY')]
      .map((byte) => `%${byte.toString(16).padStart(2, '0')}`)
      .join('');
    await writeFile(join(root, 'bundle.js'), `${encoded}%FF`, 'utf8');
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
        evidence: encoded,
        transform: 'raw+percent',
      }),
    );
  });

  it('advances zero-width Unicode regex matches by a complete code point', async () => {
    const root = await mkdtemp(join(tmpdir(), 'surfaceguard-zero-width-'));
    temporary.push(root);
    await writeFile(join(root, 'bundle.js'), '😀x', 'utf8');
    const result = await scanArtifacts({
      root,
      policy: {
        schemaVersion: 1,
        limits: { maxFindings: 2 },
        forbidden: {
          text: [{ id: 'code-point-start', pattern: '(?=.)', match: 'regex' }],
        },
      },
    });
    expect(result.findings.map((finding) => finding.evidence)).toEqual(['', '']);
    expect(result.findings.map((finding) => finding.location?.offset)).toEqual([0, 2]);
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

  it('bounds source-map directive details with linear location tracking', async () => {
    const root = await mkdtemp(join(tmpdir(), 'surfaceguard-map-directives-'));
    temporary.push(root);
    await writeFile(
      join(root, 'bundle.js'),
      Array.from(
        { length: 100 },
        (_value, index) => `//# sourceMappingURL=chunk-${index}.map`,
      ).join('\n'),
      'utf8',
    );
    const result = await scanArtifacts({
      root,
      policy: {
        schemaVersion: 1,
        limits: { maxFindings: 2 },
        sourceMaps: { mode: 'forbid', inline: 'forbid' },
      },
    });
    expect(result.findings).toHaveLength(2);
    expect(result.findings.map((finding) => finding.location?.line)).toEqual([1, 2]);
    expect(result.completeness.findingDetails).toBe('truncated');
    expect(result.failed).toBe(true);
  });

  it.each(['sitemap.xml.gz', 'sitemap_index.xml.gz', 'sitemap1.xml.gz'])(
    'inspects gzip sitemap %s within the configured expansion limit',
    async (filename) => {
      const root = await mkdtemp(join(tmpdir(), 'surfaceguard-gzip-sitemap-'));
      temporary.push(root);
      await writeFile(
        join(root, filename),
        gzipSync('<urlset><url><loc>https://example.test/private</loc></url></urlset>'),
      );
      const result = await scanArtifacts({
        root,
        policy: {
          schemaVersion: 1,
          routes: { deny: ['/private'] },
          sitemap: { mode: 'required', forbidDisallowedRoutes: true },
        },
      });
      expect(result.findings).toContainEqual(
        expect.objectContaining({ ruleId: 'SG4004', evidence: '/private' }),
      );
    },
  );

  it.each([
    'https%3A%2F%2Fexample.test%2Fprivate',
    'https%3A%252F%252Fexample.test%252Fprivate',
  ])('evaluates encoded sitemap URL %s as a public route', async (encodedUrl) => {
    const root = await mkdtemp(join(tmpdir(), 'surfaceguard-encoded-sitemap-url-'));
    temporary.push(root);
    await writeFile(
      join(root, 'sitemap.xml'),
      `<urlset><url><loc>${encodedUrl}</loc></url></urlset>`,
      'utf8',
    );
    const result = await scanArtifacts({
      root,
      policy: {
        schemaVersion: 1,
        routes: { deny: ['/private'] },
        sitemap: { mode: 'required', forbidDisallowedRoutes: true },
      },
    });
    expect(result.findings).toContainEqual(
      expect.objectContaining({ ruleId: 'SG4004', evidence: '/private' }),
    );
  });

  it('reconciles sitemap path and query values with robots matching semantics', async () => {
    const root = await mkdtemp(join(tmpdir(), 'surfaceguard-robots-rules-'));
    temporary.push(root);
    await writeFile(
      join(root, 'robots.txt'),
      [
        'User-agent: *',
        'Disallow: /private',
        'Disallow: /exact$',
        'Disallow: /%70ercent',
        'Disallow: /search?private=1',
        'Disallow: /wild*end$',
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      join(root, 'sitemap.xml'),
      [
        '<urlset>',
        '<url><loc>https://example.test/privateer</loc></url>',
        '<url><loc>https://example.test/exact</loc></url>',
        '<url><loc>https://example.test/percent</loc></url>',
        '<url><loc>https://example.test/search?private=1</loc></url>',
        '<url><loc>https://example.test/wild/nested/end</loc></url>',
        '</urlset>',
      ].join(''),
      'utf8',
    );
    const result = await scanArtifacts({
      root,
      policy: { schemaVersion: 1, sitemap: { mode: 'required' } },
    });
    expect(
      new Set(
        result.findings
          .filter((finding) => finding.ruleId === 'SG4003')
          .map((finding) => finding.evidence),
      ),
    ).toEqual(
      new Set([
        '/privateer',
        '/exact',
        '/percent',
        '/search?private=1',
        '/wild/nested/end',
      ]),
    );
  });

  it('reconciles sitemap routes after bare CR robots line endings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'surfaceguard-robots-bare-cr-'));
    temporary.push(root);
    await writeFile(join(root, 'robots.txt'), 'User-agent: *\rDisallow: /private', 'utf8');
    await writeFile(
      join(root, 'sitemap.xml'),
      '<urlset><url><loc>https://example.test/private</loc></url></urlset>',
      'utf8',
    );

    const result = await scanArtifacts({
      root,
      policy: { schemaVersion: 1, sitemap: { mode: 'required' } },
    });

    expect(result.findings).toContainEqual(
      expect.objectContaining({ ruleId: 'SG4003', evidence: '/private' }),
    );
  });

  it('preserves reserved sitemap octets for exact robots rules', async () => {
    const root = await mkdtemp(join(tmpdir(), 'surfaceguard-robots-reserved-'));
    temporary.push(root);
    await writeFile(join(root, 'robots.txt'), 'Disallow: /encoded%2Fslash');
    await writeFile(
      join(root, 'sitemap.xml'),
      '<urlset><url><loc>https://example.test/encoded%2Fslash</loc></url></urlset>',
      'utf8',
    );
    const result = await scanArtifacts({
      root,
      policy: { schemaVersion: 1, sitemap: { mode: 'required' } },
    });
    expect(result.findings).toContainEqual(
      expect.objectContaining({ ruleId: 'SG4003', evidence: '/encoded%2Fslash' }),
    );
  });

  it('uses only the root robots file for sitemap reconciliation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'surfaceguard-root-robots-'));
    temporary.push(root);
    await mkdir(join(root, 'a'));
    await writeFile(join(root, 'a/robots.txt'), 'User-agent: *\nDisallow:', 'utf8');
    await writeFile(join(root, 'robots.txt'), 'User-agent: *\nDisallow: /private', 'utf8');
    await writeFile(
      join(root, 'sitemap.xml'),
      '<urlset><url><loc>https://example.test/private</loc></url></urlset>',
      'utf8',
    );
    const result = await scanArtifacts({
      root,
      policy: { schemaVersion: 1, sitemap: { mode: 'required' } },
    });
    expect(result.findings).toContainEqual(
      expect.objectContaining({ ruleId: 'SG4003', evidence: '/private' }),
    );
  });

  it('decodes a BOM-tagged UTF-16 gzip sitemap before policy evaluation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'surfaceguard-gzip-utf16-'));
    temporary.push(root);
    const xml = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from(
        '<urlset><url><loc>https://example.test/private</loc></url></urlset>',
        'utf16le',
      ),
    ]);
    await writeFile(join(root, 'sitemap.xml.gz'), gzipSync(xml));
    const result = await scanArtifacts({
      root,
      policy: {
        schemaVersion: 1,
        routes: { deny: ['/private'] },
        sitemap: { mode: 'required', forbidDisallowedRoutes: true },
      },
    });
    expect(result.findings).toContainEqual(
      expect.objectContaining({ ruleId: 'SG4004', evidence: '/private' }),
    );
    expect(result.findings).not.toContainEqual(
      expect.objectContaining({ ruleId: 'SG1003' }),
    );
  });

  it('keeps unsupported gzip XML names outside sitemap handling', async () => {
    const root = await mkdtemp(join(tmpdir(), 'surfaceguard-gzip-lookalike-'));
    temporary.push(root);
    await writeFile(
      join(root, 'sitemapping.xml.gz'),
      gzipSync('<urlset><url><loc>https://example.test/private</loc></url></urlset>'),
    );
    const result = await scanArtifacts({
      root,
      policy: { schemaVersion: 1, sitemap: { mode: 'required' } },
    });
    expect(result.findings).toContainEqual(expect.objectContaining({ ruleId: 'SG4001' }));
  });

  it('rejects gzip sitemap expansion beyond maxFileBytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'surfaceguard-gzip-limit-'));
    temporary.push(root);
    await writeFile(join(root, 'sitemap.xml.gz'), gzipSync('x'.repeat(1_024)));
    await expect(
      scanArtifacts({
        root,
        policy: {
          schemaVersion: 1,
          sitemap: { mode: 'required' },
          limits: { maxFileBytes: 128 },
        },
      }),
    ).rejects.toMatchObject({ code: 'SG_RESOURCE_LIMIT' });
  });

  it('bounds total expanded bytes across gzip sitemaps', async () => {
    const root = await mkdtemp(join(tmpdir(), 'surfaceguard-gzip-total-'));
    temporary.push(root);
    const compressed = gzipSync(`<urlset>${' '.repeat(80)}</urlset>`);
    await writeFile(join(root, 'sitemap-a.xml.gz'), compressed);
    await writeFile(join(root, 'sitemap-b.xml.gz'), compressed);
    await expect(
      scanArtifacts({
        root,
        policy: {
          schemaVersion: 1,
          sitemap: { mode: 'required' },
          limits: { maxFileBytes: 128, maxTotalBytes: 150 },
        },
      }),
    ).rejects.toMatchObject({ code: 'SG_RESOURCE_LIMIT' });
  });

  it('reports malformed gzip input as an I/O error', async () => {
    const root = await mkdtemp(join(tmpdir(), 'surfaceguard-gzip-malformed-'));
    temporary.push(root);
    await writeFile(join(root, 'sitemap.xml.gz'), Buffer.from([31, 139, 8, 0]));
    await expect(
      scanArtifacts({
        root,
        policy: { schemaVersion: 1, sitemap: { mode: 'required' } },
      }),
    ).rejects.toMatchObject({ code: 'SG_IO_ERROR' });
  });

  it('streams fixture text without changing its bytes', async () => {
    const value = await readFile(
      join(project, 'fixtures/next-passing/build/static/chunks/app.js'),
      'utf8',
    );
    expect(Buffer.byteLength(value)).toBeGreaterThan(80);
  });
});
