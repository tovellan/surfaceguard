# SurfaceGuard

SurfaceGuard verifies produced web build artifacts against an explicit public-surface policy. It checks what a deployment would contain instead of trusting source folders, route declarations, or framework conventions.

The 0.5 series provides a framework-neutral TypeScript library and command line
interface, plus Next.js, Vite, and static Astro adapters and a GitHub Action. It scans
route manifests, client chunks, server bundles, static assets, source maps, plain or gzip
sitemaps, and robots files. Findings are available as JSON, Markdown, or SARIF.

SurfaceGuard is not published to npm. Install a released version directly from GitHub:

```sh
npm install --save-dev github:tovellan/surfaceguard#v0.5.2
```

Node.js 20 or newer is required.

## Quick start

Create a policy:

```sh
npx surfaceguard init --output surfaceguard.policy.json
```

Build the application, then scan its artifact directory:

```sh
npm run build
npx surfaceguard scan .next --policy surfaceguard.policy.json
```

A minimal policy looks like this:

```json
{
  "schemaVersion": 1,
  "adapter": "nextjs",
  "routes": {
    "allow": ["/**"],
    "deny": ["/staff", "/staff/**"]
  },
  "sourceMaps": {
    "mode": "forbid",
    "inline": "forbid"
  },
  "forbidden": {
    "text": [
      {
        "id": "internal-copy",
        "pattern": "INTERNAL_ONLY",
        "match": "literal"
      }
    ],
    "endpoints": [
      {
        "id": "private-endpoint",
        "pattern": "/internal-api/",
        "match": "literal"
      }
    ],
    "files": [
      {
        "id": "environment-file",
        "glob": "**/.env*"
      }
    ]
  }
}
```

The complete schema is in [`schemas/policy-v1.schema.json`](schemas/policy-v1.schema.json). Policy behavior is documented in [`docs/reference/policy.md`](docs/reference/policy.md).

## Reports and exit codes

Use `--format json`, `--format markdown`, or `--format sarif`. Use `--output <path>` to write a report without mixing it with console output.

```sh
npx surfaceguard scan .next \
  --policy surfaceguard.policy.json \
  --format sarif \
  --output surfaceguard.sarif
```

Exit code `0` means the configured threshold passed. Exit code `1` means findings met the threshold. Exit code `2` is a configuration, input, resource, or runtime error. Runtime errors are emitted as one JSON object on stderr.

Retained findings contain a stable rule ID, severity, category, relative artifact path,
evidence, and source location when available. Matches found after repeated URL or
JavaScript escape decoding retain the exact raw artifact evidence and name the transform
used. Each retained evidence value is limited to 2,048 UTF-8 bytes; a shortened value
includes its original byte count and SHA-256 digest. Completeness fields distinguish
bounded finding rows, bounded evidence, and incomplete text inspection, while failure
evaluation remains independent from retained details.

## GitHub Action

The action scans an artifact after the application build. Pin a release tag or, for stronger supply-chain control, the release commit SHA.

```yaml
- name: Build
  run: npm run build

- name: Scan public artifacts
  uses: tovellan/surfaceguard@v0.5.2
  with:
    artifact: .next
    policy: surfaceguard.policy.json
    sarif: surfaceguard.sarif
```

The action writes at most ten annotations per severity level and a Markdown job summary
bounded to 900 KiB, with exact omission notices when either output is shortened. Its
outputs include the retained finding count, finding and evidence truncation state,
observed-finding lower bound, text-inspection state, and policy failure state. SARIF uses
encoded relative artifact URIs. Uploading SARIF is a separate repository choice because
it needs `security-events: write` permission.

## Library API

```ts
import { loadPolicy, scanArtifacts } from '@tovellan/surfaceguard';

const policy = await loadPolicy('surfaceguard.policy.json');
const result = await scanArtifacts({ root: '.next', policy });

if (result.failed) {
  process.exitCode = 1;
}
```

The core library does not require application source code or network access. Built-in
framework adapters implement artifact classification and route extraction. Adapter
contract types are exported, but `scanArtifacts` currently accepts only the built-in
adapter names; it does not accept a custom adapter instance.

## Security properties

- Artifact paths are sorted before scanning for stable output.
- Symlink roots are rejected and nested symlinks are reported without being followed.
- Artifact entries, directories, depth, files, bytes, routes, manifest entries, sitemap
  entries, robots directives and comparisons, finding details, decoding passes, and
  pattern length are bounded.
- Recognized text accepts valid UTF-8 or BOM-tagged UTF-16LE/BE. Detectable unsupported
  or ambiguous encodings fail closed as `SG1003` while best-effort matching continues.
- Valid extensionless text is eligible for unscoped text and endpoint rules. Ambiguous
  unknown content still receives best-effort matching; it emits `SG1003` when explicitly
  scoped to `unknown` or still predominantly textual. Recognized binary extensions remain
  uninterpreted unless explicitly scoped to `unknown`.
- Automatic adapter selection rejects conflicting strong framework or route-manifest
  signals; select an adapter explicitly for a mixed artifact tree.
- Invalid policies and malformed route manifests produce machine-readable errors or findings.
- Literal and regex rules can be scoped to artifact kinds.
- Regex rules with obvious nested quantifiers are rejected.
- Reports use relative paths and do not include the workstation artifact root.

See [`docs/threat-model.md`](docs/threat-model.md) for trust boundaries and limitations.

## Development

```sh
npm ci
npm run check
npm run bench
npm run release:gate
```

The release gate includes format, lint, type, tests, coverage, build, text policy, boundary review, dependency licenses, dependency audit, complete-history secret scanning, package creation, clean installation, library example execution, and passing and vulnerable fixture scans.

## Project policy

SurfaceGuard uses the Apache License 2.0. Security reports follow [`SECURITY.md`](SECURITY.md). Contribution, governance, support, and conduct policies are in the repository root. The current roadmap is in [`ROADMAP.md`](ROADMAP.md).
