import { constants as fileConstants } from 'node:fs';
import {
  appendFile,
  mkdtemp,
  mkdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

import { afterEach, describe, expect, it } from 'vitest';

import { astroAdapter } from '../src/adapters/astro.js';
import { genericAdapter } from '../src/adapters/generic.js';
import { nextjsAdapter } from '../src/adapters/nextjs.js';
import { viteAdapter } from '../src/adapters/vite.js';
import { DEFAULT_LIMITS } from '../src/constants.js';
import {
  discoverFiles,
  readFileStreaming,
  readGzipTextStreaming,
} from '../src/filesystem.js';
import { scanArtifacts } from '../src/scan.js';
import type {
  AdapterContext,
  ArtifactFile,
  ArtifactKind,
  FrameworkAdapter,
  ScanLimits,
} from '../src/types.js';

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function limits(overrides: Partial<ScanLimits>): ScanLimits {
  return { ...DEFAULT_LIMITS, ...overrides };
}

function file(relativePath: string, kind: ArtifactKind): ArtifactFile {
  return {
    absolutePath: `/${relativePath}`,
    relativePath,
    kind,
    size: 1,
  };
}

function adapterContext(
  files: ArtifactFile[],
  source: Readonly<Record<string, string>>,
  overrides: Partial<ScanLimits>,
  signal?: AbortSignal,
): AdapterContext {
  return {
    root: '/',
    files,
    limits: limits(overrides),
    readText: (candidate) => Promise.resolve(source[candidate.relativePath] ?? ''),
    ...(signal ? { signal } : {}),
  };
}

describe('resource ceilings', () => {
  it.each([
    {
      name: 'generic',
      adapter: genericAdapter,
      files: [file('route-manifest.json', 'route-manifest')],
      source: {
        'route-manifest.json': JSON.stringify({
          routes: [{ path: '/one' }, { path: '/two' }],
        }),
      },
    },
    {
      name: 'Next.js',
      adapter: nextjsAdapter,
      files: [file('pages-manifest.json', 'route-manifest')],
      source: {
        'pages-manifest.json': JSON.stringify({ '/one': 'one.js', '/two': 'two.js' }),
      },
    },
    {
      name: 'Vite',
      adapter: viteAdapter,
      files: [file('one.html', 'metadata'), file('two.html', 'metadata')],
      source: {},
    },
    {
      name: 'Astro',
      adapter: astroAdapter,
      files: [file('one.html', 'metadata'), file('two.html', 'metadata')],
      source: {},
    },
  ] as {
    name: string;
    adapter: FrameworkAdapter;
    files: ArtifactFile[];
    source: Record<string, string>;
  }[])('enforces maxRoutes in the $name adapter', async ({ adapter, files, source }) => {
    await expect(
      adapter.collectRoutes(adapterContext(files, source, { maxRoutes: 1 })),
    ).rejects.toMatchObject({ code: 'SG_RESOURCE_LIMIT' });
  });

  it.each([
    {
      name: 'generic',
      adapter: genericAdapter,
      path: 'route-manifest.json',
      kind: 'route-manifest' as const,
      source: JSON.stringify({ one: 1, two: 2 }),
    },
    {
      name: 'Next.js',
      adapter: nextjsAdapter,
      path: 'pages-manifest.json',
      kind: 'route-manifest' as const,
      source: JSON.stringify({ '/one': 'one.js', '/two': 'two.js' }),
    },
    {
      name: 'Vite',
      adapter: viteAdapter,
      path: '.vite/manifest.json',
      kind: 'metadata' as const,
      source: JSON.stringify({ one: { file: 'one.js' } }),
    },
  ])(
    'propagates maxManifestEntries from the $name adapter',
    async ({ adapter, path, kind, source }) => {
      const files = [file(path, kind)];
      await expect(
        adapter.collectRoutes(
          adapterContext(files, { [path]: source }, { maxManifestEntries: 1 }),
        ),
      ).rejects.toMatchObject({ code: 'SG_RESOURCE_LIMIT' });
    },
  );

  it('applies maxManifestEntries cumulatively across manifests', async () => {
    const files = [
      file('route-manifest-a.json', 'route-manifest'),
      file('route-manifest-b.json', 'route-manifest'),
    ];
    await expect(
      genericAdapter.collectRoutes(
        adapterContext(
          files,
          {
            'route-manifest-a.json': JSON.stringify({ path: '/one' }),
            'route-manifest-b.json': JSON.stringify({ path: '/two' }),
          },
          { maxManifestEntries: 1 },
        ),
      ),
    ).rejects.toMatchObject({ code: 'SG_RESOURCE_LIMIT' });
  });

  it('rejects manifest nesting beyond maxDepth before constructing route pointers', async () => {
    const manifest = file('route-manifest.json', 'route-manifest');
    await expect(
      genericAdapter.collectRoutes(
        adapterContext(
          [manifest],
          {
            'route-manifest.json': JSON.stringify({ one: { two: { path: '/deep' } } }),
          },
          { maxDepth: 2 },
        ),
      ),
    ).rejects.toMatchObject({
      code: 'SG_RESOURCE_LIMIT',
      details: { limit: 2, observed: 3 },
    });
  });

  it('propagates aborts instead of reporting a malformed manifest', async () => {
    const controller = new AbortController();
    controller.abort();
    const manifest = file('route-manifest.json', 'route-manifest');
    await expect(
      genericAdapter.collectRoutes(
        adapterContext(
          [manifest],
          { 'route-manifest.json': JSON.stringify({ path: '/one' }) },
          {},
          controller.signal,
        ),
      ),
    ).rejects.toMatchObject({ code: 'SG_ABORTED' });
  });

  it('bounds filesystem entries before retaining a directory listing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'surfaceguard-entry-limit-'));
    temporary.push(root);
    await writeFile(join(root, 'one.js'), '1');
    await writeFile(join(root, 'two.js'), '2');
    await expect(
      scanArtifacts({
        root,
        policy: { schemaVersion: 1, limits: { maxEntries: 1 } },
      }),
    ).rejects.toMatchObject({ code: 'SG_RESOURCE_LIMIT' });
  });

  it('bounds directory count and nesting depth independently', async () => {
    const root = await mkdtemp(join(tmpdir(), 'surfaceguard-directory-limit-'));
    temporary.push(root);
    await mkdir(join(root, 'one', 'two'), { recursive: true });
    await writeFile(join(root, 'one', 'two', 'bundle.js'), 'safe');
    await expect(
      scanArtifacts({
        root,
        policy: { schemaVersion: 1, limits: { maxDirectories: 1 } },
      }),
    ).rejects.toMatchObject({
      code: 'SG_RESOURCE_LIMIT',
      details: { limit: 1, observed: 2 },
    });
    await expect(
      scanArtifacts({
        root,
        policy: { schemaVersion: 1, limits: { maxDepth: 1 } },
      }),
    ).rejects.toMatchObject({
      code: 'SG_RESOURCE_LIMIT',
      details: { limit: 1, observed: 2 },
    });
  });

  it('honors a pre-aborted signal during discovery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'surfaceguard-discovery-abort-'));
    temporary.push(root);
    await writeFile(join(root, 'bundle.js'), 'safe');
    const controller = new AbortController();
    controller.abort();
    await expect(
      scanArtifacts({ root, policy: { schemaVersion: 1 }, signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'SG_ABORTED' });
  });

  it('bounds sitemap entries cumulatively across files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'surfaceguard-sitemap-entry-limit-'));
    temporary.push(root);
    const sitemap = '<urlset><url><loc>https://example.test/one</loc></url></urlset>';
    await writeFile(join(root, 'sitemap-a.xml'), sitemap);
    await writeFile(join(root, 'sitemap-b.xml'), sitemap);
    await expect(
      scanArtifacts({
        root,
        policy: {
          schemaVersion: 1,
          sitemap: { mode: 'if-present' },
          limits: { maxSitemapEntries: 1 },
        },
      }),
    ).rejects.toMatchObject({ code: 'SG_RESOURCE_LIMIT' });
  });

  it('bounds robots directives before retaining an oversized rule set', async () => {
    const root = await mkdtemp(join(tmpdir(), 'surfaceguard-robots-rule-limit-'));
    temporary.push(root);
    await writeFile(join(root, 'robots.txt'), 'Disallow: /one\nDisallow: /two');
    await writeFile(
      join(root, 'sitemap.xml'),
      '<urlset><url><loc>https://example.test/public</loc></url></urlset>',
    );
    await expect(
      scanArtifacts({
        root,
        policy: {
          schemaVersion: 1,
          sitemap: { mode: 'if-present' },
          limits: { maxRobotsRules: 1 },
        },
      }),
    ).rejects.toMatchObject({ code: 'SG_RESOURCE_LIMIT' });
  });

  it('bounds the sitemap-by-robots comparison product', async () => {
    const root = await mkdtemp(join(tmpdir(), 'surfaceguard-robots-product-limit-'));
    temporary.push(root);
    await writeFile(join(root, 'robots.txt'), 'Disallow: /never-one\nDisallow: /never-two');
    await writeFile(
      join(root, 'sitemap.xml'),
      [
        '<urlset>',
        '<url><loc>https://example.test/one</loc></url>',
        '<url><loc>https://example.test/two</loc></url>',
        '</urlset>',
      ].join(''),
    );
    await expect(
      scanArtifacts({
        root,
        policy: {
          schemaVersion: 1,
          sitemap: { mode: 'if-present' },
          limits: { maxRobotsComparisons: 2 },
        },
      }),
    ).rejects.toMatchObject({
      code: 'SG_RESOURCE_LIMIT',
      details: { limit: 2, observed: 3 },
    });
  });

  it('bounds cumulative characters examined by robots matching', async () => {
    const root = await mkdtemp(join(tmpdir(), 'surfaceguard-robots-work-limit-'));
    temporary.push(root);
    await writeFile(join(root, 'robots.txt'), 'Disallow: /never');
    await writeFile(
      join(root, 'sitemap.xml'),
      `<urlset><url><loc>https://example.test/${'x'.repeat(100)}</loc></url></urlset>`,
    );
    await expect(
      scanArtifacts({
        root,
        policy: {
          schemaVersion: 1,
          sitemap: { mode: 'if-present' },
          limits: { maxRobotsWork: 10 },
        },
      }),
    ).rejects.toMatchObject({ code: 'SG_RESOURCE_LIMIT' });
  });

  it('counts omitted filesystem findings in the completeness lower bound', async () => {
    const root = await mkdtemp(join(tmpdir(), 'surfaceguard-finding-count-'));
    temporary.push(root);
    await Promise.all(
      ['one.js', 'two.js', 'three.js'].map((name) =>
        symlink('/does-not-exist', join(root, name)),
      ),
    );
    const result = await scanArtifacts({
      root,
      policy: { schemaVersion: 1, limits: { maxFindings: 1 } },
    });
    expect(result.findings).toHaveLength(1);
    expect(result.failed).toBe(true);
    expect(result.completeness).toMatchObject({
      findingDetails: 'truncated',
      observedFindingsAtLeast: 3,
    });
  });

  it.runIf(Number.isInteger(fileConstants.O_NOFOLLOW) && fileConstants.O_NOFOLLOW !== 0)(
    'does not follow a file replaced by a symlink after discovery',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'surfaceguard-read-swap-'));
      temporary.push(root);
      const artifactPath = join(root, 'bundle.js');
      const targetPath = join(root, 'target.txt');
      await writeFile(artifactPath, 'safe');
      await writeFile(targetPath, 'sensitive');
      const discovered = await discoverFiles(root, DEFAULT_LIMITS, []);
      const artifact = discovered.files.find(
        (candidate) => candidate.relativePath === 'bundle.js',
      );
      if (!artifact) expect.fail('expected bundle.js to be discovered');
      await unlink(artifactPath);
      await symlink(targetPath, artifactPath);
      await expect(readFileStreaming(artifact, DEFAULT_LIMITS)).rejects.toMatchObject({
        code: 'SG_IO_ERROR',
      });
    },
  );

  it('rejects a regular file replaced after discovery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'surfaceguard-regular-swap-'));
    temporary.push(root);
    const artifactPath = join(root, 'bundle.js');
    await writeFile(artifactPath, 'safe');
    const discovered = await discoverFiles(root, DEFAULT_LIMITS, []);
    const artifact = discovered.files.find(
      (candidate) => candidate.relativePath === 'bundle.js',
    );
    if (!artifact) expect.fail('expected bundle.js to be discovered');
    await unlink(artifactPath);
    await writeFile(artifactPath, 'same');
    await expect(readFileStreaming(artifact, DEFAULT_LIMITS)).rejects.toMatchObject({
      code: 'SG_IO_ERROR',
    });
  });

  it.runIf(Number.isInteger(fileConstants.O_NOFOLLOW) && fileConstants.O_NOFOLLOW !== 0)(
    'rejects compressed input that grows after discovery',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'surfaceguard-gzip-growth-'));
      temporary.push(root);
      const artifactPath = join(root, 'sitemap.xml.gz');
      await writeFile(artifactPath, gzipSync('<urlset></urlset>'));
      const discovered = await discoverFiles(root, DEFAULT_LIMITS, []);
      const artifact = discovered.files.find(
        (candidate) => candidate.relativePath === 'sitemap.xml.gz',
      );
      if (!artifact) expect.fail('expected sitemap.xml.gz to be discovered');
      await appendFile(artifactPath, Buffer.from([0]));
      try {
        await readGzipTextStreaming(artifact, DEFAULT_LIMITS.maxFileBytes);
        expect.fail('expected changed compressed input to be rejected');
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect(['SG_IO_ERROR', 'SG_RESOURCE_LIMIT']).toContain(
          (error as { code?: string }).code,
        );
      }
    },
  );
});
