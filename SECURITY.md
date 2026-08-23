# Security policy

## Supported versions

Security fixes are provided for the latest minor release. Before version 1.0, incompatible security hardening may require a minor version update.

| Version | Supported |
| ------- | --------- |
| 0.2.x   | Yes       |
| 0.1.x   | No        |

## Reporting a vulnerability

Use the repository's private vulnerability reporting feature under the Security tab. Do not open a public issue for a possible vulnerability or include sensitive artifact evidence in a public report.

Include the affected version, operating system, Node.js version, policy, minimal synthetic artifact, observed result, and expected result. Remove credentials and private application material.

Maintainers will acknowledge a report within five business days and provide a status update after initial triage. Timelines depend on severity and reproducibility. Coordinated disclosure is preferred.

## Scanner output

SurfaceGuard findings intentionally contain exact matched evidence. Treat JSON, Markdown, SARIF, action annotations, and logs as potentially sensitive. Apply appropriate retention and access controls. SurfaceGuard does not transmit scan inputs or results.
