import { describe, expect, it } from 'vitest';

import {
  renderJson,
  renderMarkdown,
  renderSarif,
  toSarif,
} from '../src/reporters/index.js';
import type { ScanResult } from '../src/types.js';

const result: ScanResult = {
  schemaVersion: 1,
  tool: { name: 'surfaceguard', version: '0.1.0' },
  root: '.',
  adapter: 'generic',
  findings: [
    {
      ruleId: 'sample-rule',
      severity: 'error',
      category: 'text',
      artifactPath: 'static/app.js',
      message: 'Synthetic match',
      evidence: 'private|text',
      location: { line: 2, column: 4, offset: 12 },
    },
  ],
  statistics: {
    filesVisited: 1,
    filesScanned: 1,
    bytesVisited: 100,
    routesFound: 0,
    findingsTruncated: false,
  },
  completeness: {
    textInspection: 'complete',
    findingDetails: 'complete',
    findingLimit: 1_000,
    retainedFindings: 1,
    observedFindingsAtLeast: 1,
    unsupportedTextArtifacts: 0,
  },
  failed: true,
};

describe('reporters', () => {
  it('renders deterministic JSON', () => {
    expect(renderJson(result)).toBe(`${JSON.stringify(result, null, 2)}\n`);
  });

  it('escapes Markdown table content', () => {
    expect(renderMarkdown(result)).toContain('private\\|text');
    expect(renderMarkdown({ ...result, findings: [], failed: false })).toContain(
      'No findings.',
    );
  });

  it('reports finding-detail and text-inspection completeness independently', () => {
    const incomplete: ScanResult = {
      ...result,
      statistics: { ...result.statistics, findingsTruncated: true },
      completeness: {
        ...result.completeness,
        textInspection: 'incomplete',
        findingDetails: 'truncated',
        observedFindingsAtLeast: 3,
        unsupportedTextArtifacts: 1,
      },
    };
    const markdown = renderMarkdown(incomplete);
    expect(markdown).toContain('text inspection is incomplete');
    expect(markdown).toContain('at least 3 finding(s) were observed');
  });

  it('emits GitHub-compatible SARIF with stable fingerprints', () => {
    const sarif = toSarif(result) as {
      runs: {
        properties: Record<string, unknown>;
        results: Record<string, unknown>[];
      }[];
    };
    expect(sarif.runs[0]?.results[0]).toMatchObject({
      ruleId: 'sample-rule',
      level: 'error',
    });
    expect(sarif.runs[0]?.properties).toMatchObject({
      textInspection: 'complete',
      findingDetails: 'complete',
      retainedFindings: 1,
    });
    expect(renderSarif(result)).toBe(renderSarif(result));
  });
});
