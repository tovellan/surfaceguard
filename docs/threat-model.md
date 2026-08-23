# Threat model

## Protected assets

SurfaceGuard helps keep policy-controlled routes, text, endpoints, metadata, filenames, and source maps out of a public web artifact. It also identifies disagreements between route manifests, sitemaps, and robots files.

## Trust boundaries

The artifact directory is untrusted. It may contain malformed files, symlinks, unexpectedly large files, deep trees, minified bundles, or encoded strings.

The policy is trusted configuration controlled by the team running the scan. SurfaceGuard validates its shape, bounds pattern length, and rejects obvious nested regex quantifiers. It does not attempt to prove every regular expression has linear runtime.

Reports are sensitive outputs. Exact evidence is necessary for remediation, but it can repeat material that policy intended to exclude. Store reports and CI logs accordingly.

## Controls

- The root must be a real directory.
- Nested symlinks are reported and never followed.
- Containment uses resolved absolute paths and rejects escapes.
- File traversal is sorted and bounded by file and byte counts.
- Reads are streamed and capped per file.
- URL decoding stops after a configured number of passes.
- Malformed manifests become findings.
- Binary-looking content is not interpreted as text.
- The library performs no network requests.

## Out of scope and limitations

- SurfaceGuard does not prove that a deployment contains only the scanned directory.
- It does not crawl a live site or test access control.
- It does not inspect application source code.
- It expands gzip sitemaps under strict output limits. It does not expand other archives or compressed assets.
- It does not execute JavaScript or recover dynamically assembled strings.
- It can miss custom, encrypted, unsupported compressed, or novel encodings.
- It cannot determine whether arbitrary text is private without an explicit policy.
- A clean scan is not a general security assessment.

Run SurfaceGuard after the final production build and before upload or deployment. Scan the exact directory or bundle that the deployment system will publish.
