import { describe, expect, it } from 'vitest';

import { classifyGeneric, genericAdapter } from '../src/adapters/generic.js';
import { nextjsAdapter } from '../src/adapters/nextjs.js';
import type { ArtifactFile } from '../src/types.js';

function file(relativePath: string): ArtifactFile {
  return {
    absolutePath: `/${relativePath}`,
    relativePath,
    kind: 'route-manifest',
    size: 10,
  };
}

describe('framework adapters', () => {
  it.each([
    ['robots.txt', 'robots'],
    ['sitemap.xml', 'sitemap'],
    ['sitemap.xml.gz', 'unknown'],
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
    const files = Object.keys(content).map(file);
    const result = await nextjsAdapter.collectRoutes({
      root: '/',
      files,
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
      ]),
    );
    expect(result.findings).toEqual([]);
    expect(result.routes.map((item) => item.route)).not.toContain('/_not-found');
    expect(nextjsAdapter.detect(files)).toBeGreaterThan(10);
  });

  it('collects generic nested route keys without treating unrelated strings as routes', async () => {
    const manifest = file('route-manifest.json');
    const result = await genericAdapter.collectRoutes({
      root: '/',
      files: [manifest],
      readText: () =>
        Promise.resolve(
          JSON.stringify({
            routes: [{ pathname: '/one' }, { route: '/two' }],
            label: '/not-a-route',
          }),
        ),
    });
    expect(result.routes.map((item) => item.route)).toEqual(['/one', '/two']);
  });
});
