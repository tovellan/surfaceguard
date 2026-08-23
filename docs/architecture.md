# Architecture

SurfaceGuard separates artifact discovery, framework interpretation, policy evaluation, and reporting.

## Scan lifecycle

1. Validate the versioned policy and resolve resource limits.
2. Resolve the artifact root, reject a symlink root, and walk regular files in sorted order.
3. Select an explicit adapter or detect one from artifact filenames.
4. Classify files and collect routes from produced manifests.
5. Evaluate route assertions and scan eligible text artifacts one file at a time.
6. Reconcile sitemap, robots, route manifest, and route policy evidence.
7. Sort findings and evaluate the configured failure threshold.
8. Render the immutable scan result as JSON, Markdown, or SARIF.

The scanner holds at most one bounded artifact text plus findings and route evidence in memory. It reads files through 64 KiB stream chunks. Route manifests are parsed only after the file-size gate passes.

## Core modules

- `filesystem.ts` owns containment, ordering, symlink handling, and byte limits.
- `decode.ts` owns bounded URL and JavaScript escape decoding with source-span maps.
- `matcher.ts` applies literal and regex policy rules to raw and decoded variants.
- `adapters/` classifies artifacts and extracts route evidence.
- `scan.ts` evaluates cross-artifact policy and produces a stable `ScanResult`.
- `reporters/` contains output-only transformations.

## Adapter contract

A `FrameworkAdapter` has three operations:

- `detect(files)` returns a relative confidence score;
- `classify(relativePath)` assigns an artifact kind;
- `collectRoutes(context)` returns routes and malformed-manifest findings.

Adapters receive only produced files and a bounded text reader. They must not depend on source folders or network access.

The Next.js adapter reads known output manifest shapes by field name. The Vite adapter reads produced HTML entry paths and validates the default build manifest without treating source keys as routes. Unknown fields are ignored. A malformed known manifest produces `SG1004` and does not terminate the full scan.

## Determinism

File paths, findings, rule lists, and SARIF fingerprints are sorted or content-derived. Reports contain no timestamp, absolute artifact root, random identifier, or measured duration. Resource limits turn unbounded work into stable errors.
