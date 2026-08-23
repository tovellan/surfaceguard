import { createHash } from 'node:crypto';

import type { Finding, ScanResult } from '../types.js';

function fingerprint(finding: Finding): string {
  return createHash('sha256')
    .update(
      [
        finding.ruleId,
        finding.artifactPath,
        finding.location?.offset ?? '',
        finding.evidence ?? '',
      ].join('\0'),
    )
    .digest('hex');
}

export function toSarif(result: ScanResult): Record<string, unknown> {
  const ruleIds = [...new Set(result.findings.map((finding) => finding.ruleId))].sort();
  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'SurfaceGuard',
            semanticVersion: result.tool.version,
            informationUri: 'https://github.com/tovellan/surfaceguard',
            rules: ruleIds.map((ruleId) => ({ id: ruleId, name: ruleId })),
          },
        },
        results: result.findings.map((finding) => ({
          ruleId: finding.ruleId,
          level:
            finding.severity === 'error'
              ? 'error'
              : finding.severity === 'warning'
                ? 'warning'
                : 'note',
          message: { text: finding.message },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: finding.artifactPath },
                ...(finding.location
                  ? {
                      region: {
                        startLine: finding.location.line,
                        startColumn: finding.location.column,
                      },
                    }
                  : {}),
              },
            },
          ],
          partialFingerprints: { primaryLocationLineHash: fingerprint(finding) },
          properties: {
            category: finding.category,
            evidence: finding.evidence,
            transform: finding.transform,
          },
        })),
      },
    ],
  };
}

export function renderSarif(result: ScanResult): string {
  return `${JSON.stringify(toSarif(result), null, 2)}\n`;
}
