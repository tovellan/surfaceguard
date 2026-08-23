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
inspection was complete, whether finding rows or evidence were truncated, the configured
and retained counts, a lower bound on observed findings, and the number of text artifacts
with unsupported or ambiguous encodings. Evidence is retained as a UTF-8 prefix of at
most 2,048 bytes; shortened evidence sets `evidenceTruncated`, `evidenceBytes`, and
`evidenceSha256`. `result.statistics.findingsTruncated` remains an equivalent convenience
flag for finding-row truncation.

## Policy

- `loadPolicy(path)` reads and validates a JSON policy.
- `validatePolicy(value)` validates an in-memory value.
- `resolveLimits(policy)` returns defaults merged with policy overrides.

## Reports

- `renderJson(result)` returns formatted JSON.
- `renderMarkdown(result)` returns a severity-prioritized table bounded to 900 KiB with
  an exact omitted-row notice.
- `toSarif(result)` returns a SARIF object with encoded relative artifact URIs and
  evidence-digest-based fingerprints for shortened evidence.
- `renderSarif(result)` returns formatted SARIF JSON.

The GitHub Action emits at most ten annotations for each of `error`, `warning`, and
`notice`; when findings remain, it reserves an annotation for an exact omitted-count
notice. The Markdown summary and SARIF retain the bounded finding details independently.

## Utilities

- `repeatedlyDecodeUrl(value, maxPasses)` performs bounded percent decoding.
- `canonicalizeUrl(value, maxPasses)` normalizes a path or independently parsed absolute
  URL, reveals bounded percent-encoding layers, preserves its query, and removes its
  fragment.
- `decodeTextVariants(text, maxPasses)` returns decoded text and raw source-span maps.

## Extension points

`FrameworkAdapter`, `AdapterContext`, and related artifact and finding types are exported
for contract inspection and experimental integrations. The public `ScanOptions.adapter`
field accepts only `auto`, `astro`, `generic`, `nextjs`, or `vite`; `scanArtifacts` does
not currently accept or register a custom `FrameworkAdapter` instance.

The pre-1.0 adapter interface can change in a minor release. Changes will be documented
in `CHANGELOG.md`.
