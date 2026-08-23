# SurfaceGuard engineering brief

Read this brief before changing the repository. More specific instructions may narrow a task but must not weaken these rules.

## Scope

SurfaceGuard scans produced web artifacts against a versioned policy. It must remain deterministic, bounded, offline, and independent of application source code. The artifact directory is untrusted. The policy is trusted configuration, but invalid policy shapes must fail with a machine-readable error.

## Compatibility

- Support Node.js 20, 22, and 24 on Linux. Keep Node.js 20 as the minimum runtime.
- Keep the library and command line interface ESM. The bundled GitHub Action uses the Node.js 24 action runtime.
- Treat the version 1 policy schema, finding model, exit codes, report shapes, and exported TypeScript types as contracts.
- Keep external GitHub Actions pinned to full commit hashes.
- Do not accept a dependency update outside an existing peer range or the supported runtime matrix.

## Repository boundaries

- This is an intentionally public open-source repository with public releases. Do not change its visibility without explicit user direction.
- Use synthetic fixtures only. Never commit production artifacts, source maps, credentials, customer data, private route names, personal data, or personal names.
- Do not add Unicode en dash or em dash characters to tracked text.
- Configure both the commit author and committer as `Tovellan <tovellan@users.noreply.github.com>`.
- Do not add authorship, co-author, generator, or sign-off trailers. The configured Git identity is the sole author.
- Do not weaken symlink containment, resource limits, evidence mapping, or deterministic ordering.
- Keep package contents restricted by the `files` allow list in `package.json`.

## Change protocol

- Work on a branch and use a pull request. Never force-push.
- Keep generated files in `dist/` synchronized with their sources. Run the build and confirm that a second build leaves `dist/` unchanged.
- Add passing, failing, malformed, and adversarial synthetic cases when behavior changes.
- Update the policy reference, compatibility notes, and changelog when a public contract changes.

Run these checks before declaring a change ready:

```sh
npm ci
npm run check
npm run check:licenses
npm audit --audit-level=low
npm run check:secrets
npm run test:integration
gitleaks git --no-banner --redact --log-opts=--all
```

Run `npm run bench` when decoding, matching, traversal, or finding collection changes. A release also requires `npm run release:gate`, reviewed notes, a matching existing version tag, and a clean package-content inspection.
