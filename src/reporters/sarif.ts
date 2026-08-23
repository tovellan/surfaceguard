import { createHash } from 'node:crypto';

import {
  boundFindingEvidence,
  MAX_RETAINED_EVIDENCE_BYTES,
  relativeSarifUri,
} from '../output-safety.js';
import type { Finding, ScanResult } from '../types.js';

function fingerprint(finding: Finding): string {
  return createHash('sha256')
    .update(
      [
        finding.ruleId,
        finding.artifactPath,
        finding.location?.offset ?? '',
        finding.evidenceSha256
          ? `sha256:${finding.evidenceSha256}`
          : (finding.evidence ?? ''),
      ].join('\0'),
    )
    .digest('hex');
}

export function toSarif(result: ScanResult): Record<string, unknown> {
  const findings = result.findings.map(boundFindingEvidence);
  const truncatedEvidence = Math.max(
    result.completeness.truncatedEvidence ?? 0,
    findings.filter((finding) => finding.evidenceTruncated).length,
  );
  const ruleIds = [...new Set(findings.map((finding) => finding.ruleId))].sort();
  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        properties: {
          textInspection: result.completeness.textInspection,
          findingDetails: result.completeness.findingDetails,
          findingLimit: result.completeness.findingLimit,
          retainedFindings: result.completeness.retainedFindings,
          observedFindingsAtLeast: result.completeness.observedFindingsAtLeast,
          evidenceDetails: truncatedEvidence === 0 ? 'complete' : 'truncated',
          evidenceLimit: result.completeness.evidenceLimit ?? MAX_RETAINED_EVIDENCE_BYTES,
          truncatedEvidence,
          unsupportedTextArtifacts: result.completeness.unsupportedTextArtifacts,
        },
        tool: {
          driver: {
            name: 'SurfaceGuard',
            semanticVersion: result.tool.version,
            informationUri: 'https://github.com/tovellan/surfaceguard',
            rules: ruleIds.map((ruleId) => ({ id: ruleId, name: ruleId })),
          },
        },
        results: findings.map((finding) => ({
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
                artifactLocation: { uri: relativeSarifUri(finding.artifactPath) },
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
            evidenceTruncated: finding.evidenceTruncated,
            evidenceBytes: finding.evidenceBytes,
            evidenceSha256: finding.evidenceSha256,
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
