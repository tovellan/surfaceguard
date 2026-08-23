# Governance

SurfaceGuard uses a maintainer-led governance model.

## Maintainers

The Tovellan organization appoints maintainers. Maintainers review changes, manage releases, handle security reports, and preserve the project's scope and security properties. Current maintainers are represented by the repository's organization permissions rather than a public list of personal names.

## Decisions

Routine decisions use reviewed pull requests. Material changes to policy semantics, trust boundaries, report compatibility, licensing, or governance require a public design issue and documented maintainer consensus.

If consensus is not available, maintainers prefer the choice that keeps behavior deterministic, bounded, explainable, and backward compatible. A maintainer with a direct conflict of interest must not make the final decision alone.

## Releases

Releases follow Semantic Versioning. A release requires passing CI, the local release gate, reviewed release notes, and a signed or GitHub-verified tag when available. Package registries are not part of the 0.1 release process.

## Changes to governance

Governance changes use the same review process as other material changes. The change and its rationale must remain in Git history.
