# Library API

The ESM package exports the following stable version 0.1 entry points.

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

`FrameworkAdapter`, `AdapterContext`, and related artifact and finding types are exported. Adapter authors must keep classification and route collection deterministic and must use the provided bounded `readText` callback.

The version 0.1 adapter interface can change in a minor release before version 1.0. Changes will be documented in `CHANGELOG.md`.
