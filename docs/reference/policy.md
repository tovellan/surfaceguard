# Policy reference

SurfaceGuard policies are JSON documents. `schemaVersion` is required and must be `1`. Unknown properties are rejected.

## Top-level properties

| Property        | Type                                | Behavior                                                             |
| --------------- | ----------------------------------- | -------------------------------------------------------------------- |
| `schemaVersion` | `1`                                 | Selects the policy contract.                                         |
| `adapter`       | `auto`, `generic`, `nextjs`, `vite` | Selects or detects a framework adapter.                              |
| `failOn`        | `error`, `warning`, `note`          | Sets the lowest severity that returns exit code 1. Default: `error`. |
| `exclude`       | string array                        | Glob patterns excluded before file accounting and scanning.          |
| `routes`        | object                              | Route allow, deny, and required assertions.                          |
| `sourceMaps`    | object                              | Source-map file and directive behavior.                              |
| `forbidden`     | object                              | Text, endpoint, metadata, and filename rules.                        |
| `sitemap`       | object                              | Sitemap and robots consistency behavior.                             |
| `limits`        | object                              | Resource ceilings.                                                   |

Glob matching uses slash-separated artifact paths. Route patterns match normalized URL paths.

## Route assertions

```json
{
  "routes": {
    "allow": ["/", "/docs/**"],
    "deny": ["/staff/**"],
    "require": ["/docs"]
  }
}
```

When `allow` is present, every discovered route must match at least one pattern. `deny` is evaluated independently. A route matching both lists fails. Each `require` pattern must match at least one produced route.

Route evidence comes from produced manifests. Source directories and route declarations are not read.

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

Gzip sitemaps are expanded while streaming. Both the compressed file and expanded output are bounded by `maxFileBytes`, and total expanded sitemap output is bounded by `maxTotalBytes`.

## Limits

| Property           |     Default |
| ------------------ | ----------: |
| `maxFiles`         |      50,000 |
| `maxFileBytes`     |  16,777,216 |
| `maxTotalBytes`    | 536,870,912 |
| `maxFindings`      |       1,000 |
| `maxDecodePasses`  |           3 |
| `maxPatternLength` |       1,024 |

Every override must be a positive safe integer. Reaching a byte or file limit returns machine-readable exit code 2. Findings are capped at `maxFindings`.

## Built-in rule IDs

| Rule     | Meaning                                            |
| -------- | -------------------------------------------------- |
| `SG1001` | Path escaped the root.                             |
| `SG1002` | Nested symlink was not followed.                   |
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
