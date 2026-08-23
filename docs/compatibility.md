# Compatibility

## Runtime

SurfaceGuard supports maintained Node.js release lines from Node.js 20 onward. CI tests Node.js 20, 22, and 24 on Linux. Development also checks current macOS behavior.

The library is ESM. The bundled GitHub Action targets the Node.js 20 action runtime.

## Artifact formats

The generic adapter recognizes common route-manifest names and JavaScript, JSON, HTML, CSS, XML, text, source-map, sitemap, and robots artifacts.

The Next.js adapter supports produced Pages Router and App Router manifests with these known names:

- `pages-manifest.json`
- `app-paths-manifest.json`
- `build-manifest.json`
- `prerender-manifest.json`
- `routes-manifest.json`

Unknown manifest fields are ignored. Framework releases can change private build formats, so every supported shape has synthetic tests. Report a minimal synthetic fixture when a maintained Next.js release produces a different shape.

Compressed sitemaps and archives are not expanded in 0.1.0.
