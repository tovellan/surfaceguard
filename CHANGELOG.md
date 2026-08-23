# Changelog

All notable changes are recorded here. The project follows Semantic Versioning.

## Unreleased

## 0.5.2 - 2026-08-24

- Included every repository document linked from the packaged README and verified those
  relative links during clean-install testing.
- Rejected an empty route allow list instead of silently disabling allow-list checks.
- Collected direct string entries from generic `routes` arrays without admitting
  unrelated manifest strings.
- Kept sitemap-index and extension namespace locations out of page-route and robots
  reconciliation.
- Excluded framework-owned Astro and Next.js error documents from sitemap completeness
  requirements.
- Split release verification from publication so repository code runs with read-only
  permissions and no persisted Git credential.
- Required release dispatches to run from the protected main workflow and resolve an
  exact annotated semantic-version tag at the current main commit.
- Required the generic public tagger identity and an exact attribution-free tag message.
- Made draft creation, asset upload, digest verification, and immutable publication
  restart-safe under a tested fail-closed release-state contract.
- Required the repository immutable-release setting before draft creation and
  rechecked it immediately before publication.

## 0.5.1 - 2026-08-24

- Rejected ambiguous automatic adapter signals and recognized the current Next.js App Router route manifest.
- Validated known Next.js manifest containers and required route fields before collection.
- Canonicalized mixed and repeatedly encoded absolute URLs without losing raw evidence spans.
- Parsed namespace-qualified sitemap locations, CDATA, comments, processing instructions, and XML entities in one bounded pass.
- Preserved reserved percent octets for RFC 9309-style robots matching and added directive, comparison, and character-work ceilings.
- Rejected sitemap `DOCTYPE` declarations instead of silently ignoring custom or external entities.
- Scanned valid extensionless text and failed closed on explicitly scoped or predominantly textual ambiguous unknown artifacts.
- Eagerly rejected unusable globs, regular expressions, duplicate list values, oversized output fields, and unsafe integers.
- Generated both exact and descendant starter route denials so `surfaceguard init` matches documented glob semantics.
- Preserved exact empty evidence and raw boundaries for zero-width decoded matches and added JavaScript code-point escape decoding.
- Bounded evidence, messages, Markdown summaries, Action annotations, and SARIF artifact URIs while retaining digest-backed omission evidence.
- Kept additive robots limits and evidence-completeness fields optional in exported interfaces for patch-level TypeScript compatibility.
- Staged release notes and package assets in a draft so publication exposes the notes and complete archive together.

## 0.5.0 - 2026-08-24

- Recognized common numbered and index gzip sitemap filenames.
- Added an Astro adapter for produced static HTML routes and client assets.
- Made finding caps severity-aware without allowing omitted findings to hide failure.
- Reported finding-detail and text-inspection completeness in JSON, Markdown, and SARIF.
- Scanned valid BOM-tagged UTF-16 and failed closed on ambiguous or unsupported text.
- Decoded valid percent-encoded segments in linear work even beside malformed bytes.
- Decoded valid decimal and hexadecimal XML references in sitemap locations.
- Bounded artifact entries, directories, depth, routes, manifests, and sitemap entries.
- Rejected artifact identity, size, and symlink changes between discovery and reading.
- Preserved literal percent signs and URL delimiters in Astro and Vite filesystem routes.

## 0.4.0 - 2026-08-24

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
