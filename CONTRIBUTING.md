# Contributing

Contributions that improve deterministic artifact verification are welcome.

## Before opening a change

Use an issue for behavior changes, new policy semantics, or adapter support. Security reports belong in a private security advisory as described in `SECURITY.md`.

Keep changes focused. New detections need:

- a documented policy or built-in rule contract;
- a passing synthetic fixture;
- a vulnerable synthetic fixture;
- tests for malformed and adversarial input;
- stable evidence and exit-code behavior;
- documentation of false-positive and false-negative boundaries.

Fixtures must use synthetic identities, organizations, hosts, endpoints, and content. Do not contribute production build artifacts, source maps, credentials, private routes, or customer data.

## Local checks

Node.js 20 or newer is required.

```sh
npm ci
npm run check
npm run bench
npm run release:gate
```

The full release gate creates a package tarball in a temporary directory, installs it without lifecycle scripts, and executes the documented library and CLI examples.

## Commit and review expectations

- Explain why the behavior changes.
- Do not include generated authorship trailers.
- Do not use Unicode en dash or em dash characters in tracked text.
- Keep dependencies minimal and justify runtime additions.
- Preserve relative paths and bounded resource use in reports.
- Update `CHANGELOG.md` for user-visible changes.

All commits require review and passing CI. Configure both the author and committer as the generic organization identity `Tovellan <tovellan@users.noreply.github.com>`. Use that identity as the sole author, and do not add authorship, co-author, generator, or sign-off trailers.
