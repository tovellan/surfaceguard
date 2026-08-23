# Compatibility

## Runtime

SurfaceGuard supports maintained Node.js release lines from Node.js 20 onward. CI tests Node.js 20, 22, and 24 on Linux. Development also checks current macOS behavior.

The library is ESM. The bundled GitHub Action targets the Node.js 24 action runtime.

## Artifact formats

The generic adapter recognizes common route-manifest names and JavaScript, JSON, HTML, CSS, XML, text, source-map, sitemap, and robots artifacts.

The Next.js adapter supports produced Pages Router and App Router manifests with these known names:

- `pages-manifest.json`
- `app-paths-manifest.json`
- `build-manifest.json`
- `prerender-manifest.json`
- `routes-manifest.json`

Unknown manifest fields are ignored. Framework releases can change private build formats, so every supported shape has synthetic tests. Report a minimal synthetic fixture when a maintained Next.js release produces a different shape.

App Router paths are normalized before policy evaluation. Route groups and parallel slots are removed, interception markers are resolved, `page` and `route` leaf markers are stripped, and the framework's not-found entry is omitted. Pages Router paths remain unchanged.

The Vite adapter recognizes the default `.vite/manifest.json` build manifest and produced HTML entry points. HTML route evidence preserves Vite's output path contract: `index.html` maps to `/`, while other HTML files retain their relative filename under a leading slash. Manifest source keys and asset filenames are not treated as public routes.

Gzip sitemaps are expanded while streaming under the configured file and total-byte limits. Recognized names include `sitemap.xml.gz`, numbered forms such as `sitemap1.xml.gz`, and index forms such as `sitemap_index.xml.gz`. Other compressed assets and archives are not expanded.
