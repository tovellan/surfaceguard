# Changelog

All notable changes are recorded here. The project follows Semantic Versioning.

## Unreleased

- Added streaming gzip sitemap expansion bounded by file and total-byte limits.

## 0.3.0 - 2026-08-24

- Added a Vite adapter for default build manifests and produced HTML entry routes.

## 0.2.0 - 2026-08-24

- Bounded repeated literal and regular expression matching before collecting findings.
- Enforced the individual file-size limit before artifact classification.
- Preserved raw evidence spans when artifact text contains astral Unicode characters.
- Preserved raw evidence spans when invalid percent-encoded bytes precede a match.
- Kept case-insensitive literal evidence aligned when Unicode folding changes length.
- Advanced zero-width regular expression matches by complete Unicode code points.
- Rejected unsupported compressed sitemaps when a sitemap is required.
- Aligned file-rule message validation with the published policy schema.
- Normalized Next.js App Router manifest paths to their public route forms.
- Aligned release-note lookup with the versioned release-note filenames.

## 0.1.1 - 2026-08-24

- Fixed nested XML entities being decoded more than once during sitemap parsing.
- Added a regression test for single-pass XML entity handling.

## 0.1.0 - 2026-08-24

- Added the version 1 JSON policy schema and strict runtime validation.
- Added bounded, symlink-safe artifact discovery and repeated URL decoding.
- Added generic and Next.js adapters for route manifests and bundle classification.
- Added route, text, endpoint, metadata, file, source map, sitemap, and robots checks.
- Added JSON, Markdown, SARIF, CLI, library, and GitHub Action interfaces.
- Added synthetic safe and vulnerable Next.js fixtures, tests, coverage, and benchmarks.
