# Policy reference

SurfaceGuard policies are JSON documents. `schemaVersion` is required and must be `1`. Unknown properties are rejected.

## Top-level properties

| Property        | Type                                         | Behavior                                                             |
| --------------- | -------------------------------------------- | -------------------------------------------------------------------- |
| `schemaVersion` | `1`                                          | Selects the policy contract.                                         |
| `adapter`       | `auto`, `astro`, `generic`, `nextjs`, `vite` | Selects or detects a framework adapter.                              |
| `failOn`        | `error`, `warning`, `note`                   | Sets the lowest severity that returns exit code 1. Default: `error`. |
| `exclude`       | string array                                 | Glob patterns excluded before file accounting and scanning.          |
| `routes`        | object                                       | Route allow, deny, and required assertions.                          |
| `sourceMaps`    | object                                       | Source-map file and directive behavior.                              |
| `forbidden`     | object                                       | Text, endpoint, metadata, and filename rules.                        |
| `sitemap`       | object                                       | Sitemap and robots consistency behavior.                             |
| `limits`        | object                                       | Resource ceilings.                                                   |

Glob matching uses slash-separated artifact paths. Route patterns match normalized URL paths.
Automatic adapter selection fails with `SG_CONFIG_INVALID` when an artifact tree has
conflicting strong Next.js, Astro, Vite, or generic route-manifest signals. Set `adapter`
explicitly when scanning an intentionally mixed tree.

## Route assertions

```json
{
  "routes": {
    "allow": ["/", "/docs", "/docs/**"],
    "deny": ["/staff", "/staff/**"],
    "require": ["/docs"]
  }
}
```

When `allow` is present, every discovered route must match at least one pattern. `deny` is evaluated independently. A route matching both lists fails. Each `require` pattern must match at least one produced route.

Route evidence comes from produced manifests. Source directories and route declarations are not read.
A trailing `/**` matches descendants, not the exact prefix, so list both `/docs` and
`/docs/**` when both surfaces are intended. Absolute and relative route evidence is
canonicalized with the configured percent-decoding pass limit; fragments are removed.
Route assertions compare the normalized path without its query string.

## Source maps

```json
{
  "sourceMaps": {
    "mode": "forbid",
    "inline": "forbid"
  }
}
```

`mode: forbid` reports `.map` artifacts and source-map directives. `inline: allow` permits only `data:` directives while continuing to reject map files and external directives.

## Pattern rules

The `text`, `endpoints`, and `metadata` lists share one rule format:

```json
{
  "id": "private-endpoint",
  "pattern": "/internal-api/",
  "match": "literal",
  "caseSensitive": true,
  "severity": "error",
  "scopes": ["client-chunk", "server-bundle"],
  "message": "Private endpoint present in a bundle"
}
```

`id` must begin with a lowercase letter and contain only lowercase letters, digits, dots, underscores, and hyphens. `match` defaults to `literal`. `caseSensitive` defaults to `true`. `severity` defaults to `error`. Omitted scopes mean every text artifact.

Metadata rules run only on HTML and web manifest artifacts. Endpoint rules use the same bounded decoding engine as text rules but retain an endpoint category in reports.

The scanner evaluates raw text, JavaScript hexadecimal escapes, and repeated percent-decoded variants. A finding reports the exact source bytes that produced the decoded match.

Applicable text and endpoint rules also inspect valid text in extensionless or otherwise
unknown artifacts. Ambiguous content emits `SG1003`, receives best-effort matching, and
marks text inspection incomplete when explicitly scoped to `unknown` or still
predominantly textual. Other unrecognized ambiguous content still receives best-effort
matching and marks inspection incomplete without an encoding finding. Recognized binary
extensions remain uninterpreted unless explicitly scoped to `unknown`.

## File rules

```json
{
  "id": "environment-file",
  "glob": "**/.env*",
  "severity": "error"
}
```

File rules apply before text classification, so they also cover binary and otherwise unknown artifacts.

## Sitemap and robots checks

```json
{
  "sitemap": {
    "mode": "required",
    "requireRobotsReference": true,
    "requireRoutes": true,
    "forbidDisallowedRoutes": true
  }
}
```

- `mode` is `off`, `if-present`, or `required`.
- `requireRobotsReference` requires at least one `Sitemap:` directive.
- `requireRoutes` requires non-dynamic, non-API public manifest routes in the sitemap.
- `forbidDisallowedRoutes` rejects sitemap paths matched by route deny assertions.
- Sitemap paths disallowed by robots rules are always reported when sitemap checks run.
- Sitemap paths missing from route manifests are warnings.

Sitemap `<loc>` elements are recognized by namespace-local name. Normal text, CDATA,
predefined and numeric XML entities are combined, while comments and processing
instructions are ignored. Parsing is one pass and the cumulative `<loc>` count is bounded
by `maxSitemapEntries`. `DOCTYPE` declarations are rejected with `SG_IO_ERROR` because
external and custom XML entities are not expanded. Gzip sitemaps are expanded while
streaming. Both the compressed file and expanded output are bounded by `maxFileBytes`,
and total expanded sitemap output is bounded by `maxTotalBytes`.

Only the exact root artifact `robots.txt` participates in consistency checks. SurfaceGuard
conservatively applies every eligible `Disallow:` value it reads. Matching uses the
sitemap URL's canonical path and query and follows RFC 9309 octet comparison: percent
encodings of unreserved bytes are normalized, `*` is a wildcard (including across `/`), a
terminal `$` anchors the end, and an unanchored rule is a prefix. Route policy checks
continue to use the path without its query.

## Limits

| Property               |     Default |
| ---------------------- | ----------: |
| `maxEntries`           |     100,000 |
| `maxDirectories`       |      10,000 |
| `maxDepth`             |          64 |
| `maxFiles`             |      50,000 |
| `maxFileBytes`         |  16,777,216 |
| `maxTotalBytes`        | 536,870,912 |
| `maxRoutes`            |      50,000 |
| `maxManifestEntries`   |     100,000 |
| `maxSitemapEntries`    |      50,000 |
| `maxRobotsRules`       |      50,000 |
| `maxRobotsComparisons` |   1,000,000 |
| `maxRobotsWork`        |  67,108,864 |
| `maxFindings`          |       1,000 |
| `maxDecodePasses`      |           3 |
| `maxPatternLength`     |       1,024 |

Every override must be a positive safe integer. `maxEntries` and `maxDirectories` bound filesystem discovery before its work queues can grow without limit. `maxDepth` bounds both nested directories and JSON-manifest traversal. `maxRoutes` bounds retained adapter route evidence, `maxManifestEntries` bounds cumulative JSON-manifest traversal, and `maxSitemapEntries` bounds cumulative sitemap `<loc>` entries. `maxRobotsRules` bounds retained `Disallow:` and `Sitemap:` directives; `maxRobotsComparisons` bounds the cumulative sitemap-location-by-`Disallow` comparison product; `maxRobotsWork` bounds total path and pattern characters examined. `maxPatternLength` applies to policy patterns, globs, and retained robots directive values. Reaching a resource limit returns machine-readable exit code 2. Finding details are capped at `maxFindings`; failure evaluation continues independently. Retained evidence and policy-controlled messages are capped at 2,048 UTF-8 bytes, while rule identifiers are capped at 255 bytes. Shortened evidence carries its original byte count and SHA-256 digest. `ScanResult.completeness` reports retained and observed finding counts, finding and evidence truncation, and text-inspection state. `statistics.findingsTruncated` is the convenience finding-row truncation flag.

Recognized text accepts valid UTF-8 or BOM-tagged UTF-16LE/BE. Invalid sequences,
control bytes, unsupported BOMs, and detectable unsupported HTML, XML, SVG, or CSS
charset declarations produce `SG1003`. Best-effort matching continues, but the result
marks text inspection incomplete.

## Built-in rule IDs

| Rule     | Meaning                                            |
| -------- | -------------------------------------------------- |
| `SG1001` | Path escaped the root.                             |
| `SG1002` | Nested symlink was not followed.                   |
| `SG1003` | Text used an unsupported or ambiguous encoding.    |
| `SG1004` | Known route manifest was malformed.                |
| `SG2001` | Route was outside the allow list.                  |
| `SG2002` | Route matched a deny assertion.                    |
| `SG2003` | Required route was missing.                        |
| `SG3001` | Source-map file was forbidden.                     |
| `SG3002` | Inline source map was forbidden.                   |
| `SG3003` | External source-map directive was forbidden.       |
| `SG4001` | Required sitemap was missing.                      |
| `SG4002` | robots.txt lacked a sitemap reference.             |
| `SG4003` | Sitemap exposed a robots-disallowed route.         |
| `SG4004` | Sitemap exposed a policy-denied route.             |
| `SG4005` | Sitemap route was absent from route manifests.     |
| `SG4006` | Required public route was absent from the sitemap. |
