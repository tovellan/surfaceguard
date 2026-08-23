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
  statistics: { filesVisited: 1, filesScanned: 1, bytesVisited: 100, routesFound: 0 },
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

  it('emits GitHub-compatible SARIF with stable fingerprints', () => {
    const sarif = toSarif(result) as {
      runs: { results: Record<string, unknown>[] }[];
    };
    expect(sarif.runs[0]?.results[0]).toMatchObject({
      ruleId: 'sample-rule',
      level: 'error',
    });
    expect(renderSarif(result)).toBe(renderSarif(result));
  });
});
