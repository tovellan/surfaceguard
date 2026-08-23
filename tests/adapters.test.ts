import { describe, expect, it } from 'vitest';

import { astroAdapter } from '../src/adapters/astro.js';
import { classifyGeneric, genericAdapter } from '../src/adapters/generic.js';
import { selectAdapter } from '../src/adapters/index.js';
import { nextjsAdapter } from '../src/adapters/nextjs.js';
import { viteAdapter } from '../src/adapters/vite.js';
import { DEFAULT_LIMITS } from '../src/constants.js';
import { SurfaceGuardError } from '../src/errors.js';
import type { ArtifactFile, ArtifactKind } from '../src/types.js';

function file(relativePath: string, kind: ArtifactKind = 'route-manifest'): ArtifactFile {
  return {
    absolutePath: `/${relativePath}`,
    relativePath,
    kind,
    size: 10,
  };
}

describe('framework adapters', () => {
  it.each([
    ['robots.txt', 'robots'],
    ['sitemap.xml', 'sitemap'],
    ['sitemap.xml.gz', 'sitemap'],
    ['sitemap_index.xml.gz', 'sitemap'],
    ['sitemap1.xml.gz', 'sitemap'],
    ['sitemap_1.xml', 'sitemap'],
    ['sitemapindex.xml', 'sitemap'],
    ['sitemapping.xml.gz', 'unknown'],
    ['sitemap_foo.xml.gz', 'unknown'],
    ['sitemap1.xml.zip', 'unknown'],
    ['static/app.js.map', 'source-map'],
    ['routes-manifest.json', 'route-manifest'],
    ['static/manifest.webmanifest', 'metadata'],
    ['server/pages/a.js', 'server-bundle'],
    ['static/chunks/a.js', 'client-chunk'],
    ['public/data.json', 'static-asset'],
    ['public/image.png', 'unknown'],
  ])('classifies %s as %s', (path, kind) => {
    expect(classifyGeneric(path)).toBe(kind);
  });

  it('collects semantic routes from supported Next.js manifests', async () => {
    const content: Record<string, unknown> = {
      'server/pages-manifest.json': {
        '/': 'index.js',
        '/docs': 'docs.js',
        '/page': 'page.js',
      },
      'server/app-paths-manifest.json': {
        '/(marketing)/catalog/page': 'catalog.js',
        '/api/status/route': 'status.js',
        '/feed/@modal/(..)photo/[id]/page': 'photo.js',
        '/feed/@modal/(.)item/[id]/page': 'item.js',
        '/one/two/@modal/(..)(..)archive/page': 'archive.js',
        '/one/@modal/(...)root/page': 'root.js',
        '/_not-found/page': 'not-found.js',
        '/_global-error/page': 'global-error.js',
      },
      'app-path-routes-manifest.json': {
        '/page': '/',
        '/docs/page': '/docs',
        '/favicon.ico/route': '/favicon.ico',
        '/_not-found/page': '/_not-found',
        '/_global-error/page': '/_global-error',
      },
      'build-manifest.json': { pages: { '/pricing': ['pricing.js'] } },
      'prerender-manifest.json': {
        routes: { '/about': {} },
        dynamicRoutes: { '/items/[id]': {} },
      },
      'routes-manifest.json': {
        staticRoutes: [{ page: '/static' }],
        dynamicRoutes: [{ page: '/dynamic/[slug]' }],
        dataRoutes: [{ page: '/data' }],
        redirects: [{ source: '/old' }],
        rewrites: { beforeFiles: [{ source: '/legacy' }] },
      },
    };
    const files = Object.keys(content).map((relativePath) => file(relativePath));
    const result = await nextjsAdapter.collectRoutes({
      root: '/',
      files,
      limits: DEFAULT_LIMITS,
      readText: (candidate) =>
        Promise.resolve(JSON.stringify(content[candidate.relativePath])),
    });
    expect(new Set(result.routes.map((item) => item.route))).toEqual(
      new Set([
        '/',
        '/docs',
        '/page',
        '/catalog',
        '/api/status',
        '/photo/[id]',
        '/feed/item/[id]',
        '/archive',
        '/root',
        '/pricing',
        '/about',
        '/items/[id]',
        '/static',
        '/dynamic/[slug]',
        '/data',
        '/old',
        '/legacy',
        '/favicon.ico',
      ]),
    );
    expect(result.findings).toEqual([]);
    expect(result.routes.map((item) => item.route)).not.toContain('/_not-found');
    expect(result.routes.map((item) => item.route)).not.toContain('/_global-error');
    expect(nextjsAdapter.detect(files)).toBeGreaterThan(10);
  });

  it.each<[string, unknown, string]>([
    ['build-manifest.json', { pages: ['/private'] }, 'pages must be an object'],
    ['prerender-manifest.json', { routes: ['/private'] }, 'routes must be an object'],
    [
      'routes-manifest.json',
      { staticRoutes: { '/private': {} } },
      'staticRoutes must be an array of objects',
    ],
    [
      'routes-manifest.json',
      { rewrites: '/private' },
      'rewrites must be an array or grouped object',
    ],
    [
      'routes-manifest.json',
      { rewrites: { beforeFiles: { source: '/private' } } },
      'rewrites.beforeFiles must be an array of objects',
    ],
    [
      'routes-manifest.json',
      { staticRoutes: [{ page: 42 }] },
      'staticRoutes[0] must name a non-empty absolute route string',
    ],
    [
      'routes-manifest.json',
      { redirects: [{}] },
      'redirects[0] must name a non-empty absolute route string',
    ],
    [
      'routes-manifest.json',
      { rewrites: [{ source: '' }] },
      'rewrites[0] must name a non-empty absolute route string',
    ],
    [
      'routes-manifest.json',
      { rewrites: { fallback: [{ source: 42 }] } },
      'rewrites.fallback[0] must name a non-empty absolute route string',
    ],
    [
      'app-path-routes-manifest.json',
      { '/page': 42 },
      '/page must name a non-empty absolute route string',
    ],
  ])('reports malformed known fields in %s', async (relativePath, content, evidence) => {
    const manifest = file(relativePath);
    const result = await nextjsAdapter.collectRoutes({
      root: '/',
      files: [manifest],
      limits: DEFAULT_LIMITS,
      readText: () => Promise.resolve(JSON.stringify(content)),
    });
    expect(result.routes).toEqual([]);
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        ruleId: 'SG1004',
        artifactPath: relativePath,
      }),
    );
    expect(result.findings[0]?.evidence).toContain(evidence);
  });

  it('keeps optional and unknown Next manifest fields compatible', async () => {
    const manifest = file('routes-manifest.json');
    const result = await nextjsAdapter.collectRoutes({
      root: '/',
      files: [manifest],
      limits: DEFAULT_LIMITS,
      readText: () =>
        Promise.resolve(
          JSON.stringify({
            version: 3,
            staticRoutes: [{ page: '/public', extra: true }],
            rewrites: { beforeFiles: [{ source: '/legacy' }], futureGroup: 'ignored' },
            futureSection: { enabled: true },
          }),
        ),
    });
    expect(result.findings).toEqual([]);
    expect(result.routes.map((route) => route.route)).toEqual(['/public', '/legacy']);
  });

  it('collects generic nested route keys without treating unrelated strings as routes', async () => {
    const manifest = file('route-manifest.json');
    const result = await genericAdapter.collectRoutes({
      root: '/',
      files: [manifest],
      limits: DEFAULT_LIMITS,
      readText: () =>
        Promise.resolve(
          JSON.stringify({
            routes: ['/direct', { pathname: '/one' }, { route: '/two' }],
            label: '/not-a-route',
          }),
        ),
    });
    expect(result.routes.map((item) => item.route)).toEqual(['/direct', '/one', '/two']);
  });

  it('propagates operational read errors instead of calling a manifest malformed', async () => {
    const manifest = file('route-manifest.json');
    const error = new SurfaceGuardError('SG_IO_ERROR', 'synthetic read failure');
    await expect(
      genericAdapter.collectRoutes({
        root: '/',
        files: [manifest],
        limits: DEFAULT_LIMITS,
        readText: () => Promise.reject(error),
      }),
    ).rejects.toBe(error);
  });

  it('collects exact routes from Astro static HTML output', async () => {
    const files = [
      file('index.html', 'metadata'),
      file('about/index.html', 'metadata'),
      file('blog/post/index.html', 'metadata'),
      file('contact.html', 'metadata'),
      file('404.html', 'metadata'),
      file('docs/a#b.html', 'metadata'),
      file('docs/a?b.html', 'metadata'),
      file('docs/a%23b.html', 'metadata'),
      file('_astro/page.abc123.js', 'client-chunk'),
    ];
    const result = await astroAdapter.collectRoutes({
      root: '/',
      files,
      limits: DEFAULT_LIMITS,
      readText: () => Promise.resolve(''),
    });
    expect(result.routes).toEqual([
      {
        route: '/',
        artifactPath: 'index.html',
        pointer: '/',
        routeKind: 'artifact-path',
      },
      {
        route: '/about/',
        artifactPath: 'about/index.html',
        pointer: '/',
        routeKind: 'artifact-path',
      },
      {
        route: '/blog/post/',
        artifactPath: 'blog/post/index.html',
        pointer: '/',
        routeKind: 'artifact-path',
      },
      {
        route: '/contact.html',
        artifactPath: 'contact.html',
        pointer: '/',
        routeKind: 'artifact-path',
      },
      {
        route: '/404.html',
        artifactPath: '404.html',
        pointer: '/',
        routeKind: 'artifact-path',
      },
      {
        route: '/docs/a%23b.html',
        artifactPath: 'docs/a#b.html',
        pointer: '/',
        routeKind: 'artifact-path',
      },
      {
        route: '/docs/a%3Fb.html',
        artifactPath: 'docs/a?b.html',
        pointer: '/',
        routeKind: 'artifact-path',
      },
      {
        route: '/docs/a%2523b.html',
        artifactPath: 'docs/a%23b.html',
        pointer: '/',
        routeKind: 'artifact-path',
      },
    ]);
    expect(result.findings).toEqual([]);
  });

  it('detects and classifies default Astro static output', () => {
    const files = [
      file('index.html', 'metadata'),
      file('_astro/page.abc123.js', 'client-chunk'),
    ];
    expect(astroAdapter.detect(files)).toBeGreaterThan(viteAdapter.detect(files));
    expect(selectAdapter('auto', files).name).toBe('astro');
    expect(selectAdapter('astro', files)).toBe(astroAdapter);
    expect(astroAdapter.classify('index.html')).toBe('metadata');
    expect(astroAdapter.classify('_astro/page.abc123.js')).toBe('client-chunk');
    expect(astroAdapter.classify('_astro/page.abc123.js.map')).toBe('source-map');
    expect(astroAdapter.classify('_astro/styles.abc123.css')).toBe('static-asset');
    expect(astroAdapter.classify('custom/chunks/page.abc123.mjs')).toBe('client-chunk');
    expect(astroAdapter.classify('server/render.mjs')).toBe('server-bundle');
    expect(astroAdapter.detect([file('_astro/page.abc123.js', 'client-chunk')])).toBe(0);
    expect(astroAdapter.detect([file('index.html', 'metadata')])).toBe(0);
  });

  it('fails closed when auto detection sees conflicting framework signals', () => {
    const files = [
      file('server/pages-manifest.json'),
      file('index.html', 'metadata'),
      file('_astro/page.js', 'client-chunk'),
    ];
    expect(() => selectAdapter('auto', files)).toThrow(
      /conflicting adapter signals \(nextjs, astro\).*explicitly/u,
    );
    expect(selectAdapter('nextjs', files)).toBe(nextjsAdapter);
    expect(selectAdapter('astro', files)).toBe(astroAdapter);
  });

  it.each<[string, ArtifactFile[], string[]]>([
    [
      'Astro and Vite',
      [
        file('index.html', 'metadata'),
        file('_astro/page.js', 'client-chunk'),
        file('.vite/manifest.json', 'metadata'),
      ],
      ['astro', 'vite'],
    ],
    [
      'a generic route manifest and Vite',
      [file('route-manifest.json'), file('.vite/manifest.json', 'metadata')],
      ['vite', 'generic-route-manifest'],
    ],
  ])('reports conflict details for %s', (_label, files, signals) => {
    try {
      selectAdapter('auto', files);
      throw new Error('Expected auto adapter selection to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(SurfaceGuardError);
      expect((error as SurfaceGuardError).code).toBe('SG_CONFIG_INVALID');
      expect((error as SurfaceGuardError).details).toEqual({ signals });
    }
  });

  it('selects generic for an unambiguous generic route manifest', () => {
    expect(selectAdapter('auto', [file('server/route-manifest.json')])).toBe(
      genericAdapter,
    );
  });

  it('treats modern App Router route output as a Next signal, not a generic conflict', () => {
    const files = [file('routes-manifest.json'), file('app-path-routes-manifest.json')];
    expect(selectAdapter('auto', files)).toBe(nextjsAdapter);
  });

  it('collects Vite HTML entry routes without treating manifest keys as URLs', async () => {
    const files = [
      file('index.html', 'metadata'),
      file('about.html', 'metadata'),
      file('blog/index.html', 'metadata'),
      file('docs/a#b.html', 'metadata'),
      file('docs/a?b.html', 'metadata'),
      file('docs/a%23b.html', 'metadata'),
      file('.vite/manifest.json', 'metadata'),
      file('assets/main.js', 'client-chunk'),
    ];
    const result = await viteAdapter.collectRoutes({
      root: '/',
      files,
      limits: DEFAULT_LIMITS,
      readText: () =>
        Promise.resolve(
          JSON.stringify({
            'src/main.ts': {
              file: 'assets/main.js',
              src: 'src/main.ts',
              isEntry: true,
            },
          }),
        ),
    });
    expect(result.routes.map((item) => item.route)).toEqual([
      '/',
      '/about.html',
      '/blog/index.html',
      '/docs/a%23b.html',
      '/docs/a%3Fb.html',
      '/docs/a%2523b.html',
    ]);
    expect(result.findings).toEqual([]);
    expect(viteAdapter.classify('.vite/manifest.json')).toBe('metadata');
    expect(viteAdapter.classify('assets/main.js')).toBe('client-chunk');
    expect(selectAdapter('auto', files).name).toBe('vite');
  });

  it('reports a malformed Vite manifest without discarding HTML route evidence', async () => {
    const files = [file('index.html', 'metadata'), file('.vite/manifest.json', 'metadata')];
    const result = await viteAdapter.collectRoutes({
      root: '/',
      files,
      limits: DEFAULT_LIMITS,
      readText: () => Promise.resolve('{'),
    });
    expect(result.routes.map((item) => item.route)).toEqual(['/']);
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        ruleId: 'SG1004',
        artifactPath: '.vite/manifest.json',
      }),
    );
  });

  it('rejects Vite manifest chunks without output files', async () => {
    const manifest = file('.vite/manifest.json', 'metadata');
    const result = await viteAdapter.collectRoutes({
      root: '/',
      files: [manifest],
      limits: DEFAULT_LIMITS,
      readText: () => Promise.resolve(JSON.stringify({ 'src/main.ts': { isEntry: true } })),
    });
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        ruleId: 'SG1004',
        evidence: 'Manifest chunks must name an output file',
      }),
    );
  });
});
