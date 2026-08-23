# Clean-room research record

Research date: 2026-08-24.

SurfaceGuard was designed independently for pre-deployment inspection of produced public web artifacts. No private application source, benchmark material, build artifact, route list, policy marker, or internal repository history was used.

## Primary sources reviewed

- [Next.js production browser source maps](https://nextjs.org/docs/pages/api-reference/config/next-config-js/productionBrowserSourceMaps) documents that enabled production browser maps are emitted beside JavaScript and served automatically.
- [Next.js adapter output types](https://nextjs.org/docs/app/api-reference/adapters/output-types) documents current categories for pages, API routes, app routes, prerenders, static files, and middleware.
- [Next.js shared output constants](https://github.com/vercel/next.js/blob/canary/packages/next/src/shared/lib/constants.ts) names the current Pages, App Router, build, prerender, and routes manifest files, including `app-path-routes-manifest.json`.
- [Next.js output file tracing](https://nextjs.org/docs/15/app/api-reference/config/next-config-js/output) explains how production dependencies are represented in output tracing files.
- [Vite HTML features](https://vite.dev/guide/features.html#html) defines HTML entry points and their directly accessible URL paths.
- [Vite backend integration](https://vite.dev/guide/backend-integration.html) defines the default `.vite/manifest.json` production shape and distinguishes entry chunks from assets and dynamic imports.
- [Astro configuration](https://docs.astro.build/en/reference/configuration-reference/) defines static output, the default `dist` output directory, the reserved `_astro` asset directory, and the `directory`, `file`, and `preserve` HTML output formats.
- [Astro routing](https://docs.astro.build/en/guides/routing/) defines the static page routes represented by generated HTML output and identifies `_astro/` as a reserved route.
- [GitHub SARIF support](https://docs.github.com/en/code-security/reference/code-scanning/sarif-files/sarif-support) defines the supported SARIF subset, relative artifact locations, and stable fingerprints.
- [GitHub Actions workflow commands](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-commands) defines annotation escaping and the 1 MiB per-step job-summary limit.
- [RFC 9309](https://www.rfc-editor.org/rfc/rfc9309.html) defines robots path-prefix matching, reserved and unreserved percent-octet comparison, `*`, `$`, and the exact root lowercase `/robots.txt` location.
- [Gitleaks](https://github.com/gitleaks/gitleaks) establishes the maintained secret-scanning category and its directory, Git, and SARIF workflows.
- [JS Recon](https://github.com/js-recon/js-recon) demonstrates live-site JavaScript enumeration, endpoint extraction, and source-map reconstruction.
- [Sitemap Validator](https://github.com/trybyte-app/sitemap-validator) documents standards-focused XML validation, robots auditing, and bounded live checks.

## Differentiation decision

The adjacent projects solve useful but different problems. Secret scanners focus on credential patterns. JavaScript reconnaissance tools start from a live target and map attack surface. Sitemap validators focus on XML and published-site behavior. Next.js documents its output shapes but does not provide an organization policy verifier.

SurfaceGuard therefore stayed narrow: scan the exact local artifact intended for publication, apply explicit route and content policy, reconcile framework manifests with sitemap and robots evidence, map encoded matches back to raw bytes, and produce CI-native deterministic reports. It does not crawl, probe endpoints, recover source, or replace secret scanning.

## Independent implementation notes

The implementation uses Node.js filesystem streams, path containment checks, JSON parsing after byte limits, explicit field extraction for known Next.js manifests, and a custom source-span map for bounded decoding. The policy schema, finding model, rules, fixtures, and tests were written for this repository. All examples use synthetic hosts and content.
