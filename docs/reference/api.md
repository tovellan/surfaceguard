# Library API

The ESM package exports the following version 0.x entry points.

## Scanning

`scanArtifacts(options)` validates the policy, scans one artifact root, and returns `Promise<ScanResult>`.

```ts
const result = await scanArtifacts({
  root: '.next',
  policy,
  adapter: 'nextjs',
  signal: abortController.signal,
});
```

`adapter` and `signal` are optional. Aborts and invalid inputs throw `SurfaceGuardError`.
`result.findings` is a bounded, severity-prioritized subset. Failure evaluation remains
independent from retained report details. `result.completeness` reports whether text
inspection was complete, whether finding details were truncated, the configured and
retained counts, a lower bound on observed findings, and the number of text artifacts
with unsupported or ambiguous encodings. `result.statistics.findingsTruncated` remains
an equivalent convenience flag for finding-detail truncation.

## Policy

- `loadPolicy(path)` reads and validates a JSON policy.
- `validatePolicy(value)` validates an in-memory value.
- `resolveLimits(policy)` returns defaults merged with policy overrides.

## Reports

- `renderJson(result)` returns formatted JSON.
- `renderMarkdown(result)` returns a compact table report.
- `toSarif(result)` returns a SARIF object.
- `renderSarif(result)` returns formatted SARIF JSON.

## Utilities

- `repeatedlyDecodeUrl(value, maxPasses)` performs bounded percent decoding.
- `canonicalizeUrl(value, maxPasses)` normalizes a path or absolute URL.
- `decodeTextVariants(text, maxPasses)` returns decoded text and raw source-span maps.

## Extension points

`FrameworkAdapter`, `AdapterContext`, and related artifact and finding types are exported. Adapter authors must keep classification and route collection deterministic, use the provided bounded `readText` callback, observe `context.signal`, and enforce the route and manifest ceilings in `context.limits`.

The version 0.1 adapter interface can change in a minor release before version 1.0. Changes will be documented in `CHANGELOG.md`.
