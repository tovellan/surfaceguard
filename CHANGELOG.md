# Changelog

All notable changes are recorded here. The project follows Semantic Versioning.

## Unreleased

- Bounded repeated literal and regular expression matching before collecting findings.
- Enforced the individual file-size limit before artifact classification.
- Preserved raw evidence spans when artifact text contains astral Unicode characters.
- Kept case-insensitive literal evidence aligned when Unicode folding changes length.
- Rejected unsupported compressed sitemaps when a sitemap is required.
- Aligned file-rule message validation with the published policy schema.

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
