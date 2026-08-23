# Compatibility

## Runtime

SurfaceGuard supports maintained Node.js release lines from Node.js 20 onward. CI tests Node.js 20, 22, and 24 on Linux. Development also checks current macOS behavior.

The library is ESM. The bundled GitHub Action targets the Node.js 24 action runtime.

## Artifact formats

The generic adapter recognizes common route-manifest names and JavaScript, JSON, HTML, CSS, XML, text, source-map, sitemap, and robots artifacts.

Automatic selection uses strong produced-artifact signals. It returns
`SG_CONFIG_INVALID` when more than one of Next.js, Astro, Vite, or a generic route
manifest is strongly indicated; select the intended built-in adapter explicitly for a
mixed artifact directory.

The Next.js adapter supports produced Pages Router and App Router manifests with these known names:

- `app-path-routes-manifest.json`
- `pages-manifest.json`
- `app-paths-manifest.json`
- `build-manifest.json`
- `prerender-manifest.json`
- `routes-manifest.json`

Unknown manifest fields are ignored. Framework releases can change private build formats, so every supported shape has synthetic tests. Report a minimal synthetic fixture when a maintained Next.js release produces a different shape.

App Router paths are normalized before policy evaluation. Route groups and parallel slots are removed, interception markers are resolved, `page` and `route` leaf markers are stripped, and the framework's not-found and global-error entries are omitted. Pages Router paths remain unchanged.

The Vite adapter recognizes the default `.vite/manifest.json` build manifest and produced HTML entry points. HTML route evidence preserves Vite's output path contract: `index.html` maps to `/`, while other HTML files retain their relative filename under a leading slash. Manifest source keys and asset filenames are not treated as public routes.

Vite and Astro filesystem route segments are percent-encoded before policy
normalization. Literal `%`, `?`, and `#` characters therefore remain part of the
produced path instead of becoming a second decoding pass, query, or fragment.

The Astro adapter supports static output directories. It maps root `index.html` to `/`, nested `index.html` files to directory routes with a trailing slash, and other HTML files to their exact output path under a leading slash. This covers Astro's `directory`, `file`, and `preserve` build formats from produced artifacts without reading source routes. JavaScript in default or customized asset directories is classified as a client chunk, while server-directory JavaScript keeps its server-bundle classification.

Automatic Astro detection requires both produced HTML and a file under Astro's default reserved `_astro/` asset directory. Select `adapter: astro` explicitly when `build.assets` is customized or a static build has no generated client assets. Server-adapter output and non-HTML endpoint inference are outside this adapter's static-output contract.

Sitemap XML recognizes namespace-qualified page `<loc>` elements directly under
`<urlset>/<url>`, along with CDATA, comments, processing instructions, and predefined or
numeric entities in one bounded pass. Sitemap-index references are not page routes, and
extension locations such as `<image:loc>` are ignored. `DOCTYPE` declarations fail
closed because custom and external entities are not expanded. Gzip sitemaps are expanded
while streaming under the configured file and total-byte limits.
Recognized names include `sitemap.xml.gz`, numbered forms such as `sitemap1.xml.gz`, and
index forms such as `sitemap_index.xml.gz`. Other compressed assets and archives are not
expanded.

Sitemap locations are canonicalized through the bounded percent-decoding engine. Route
policy compares paths, while robots consistency compares the path plus query. `Disallow`
patterns use RFC 9309 percent-octet normalization, prefix matching, `*` wildcards, and a
terminal `$` end anchor. Only an exact root `robots.txt` is authoritative for this check.
Directive retention and the cumulative sitemap-location-by-`Disallow` comparison product
have separate configurable ceilings.

Sitemap route completeness omits exact Astro `404.html` and `500.html` error documents
and exact `/404` and `/500` routes from the Next.js pages manifest. Other similarly named
user pages remain ordinary public routes.

An extensionless or unrecognized file remains kind `unknown`. Valid text is inspected by
applicable text, endpoint, and source-map rules. Ambiguous content produces fail-closed
`SG1003` reporting when explicitly scoped to `unknown` or still predominantly textual;
other unrecognized ambiguous content receives best-effort matching and marks inspection
incomplete without turning binary-looking bytes into an encoding finding. Recognized
binary extensions remain uninterpreted unless explicitly scoped to `unknown`.
