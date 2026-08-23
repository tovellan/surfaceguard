import { describe, expect, it } from 'vitest';

import {
  renderJson,
  renderMarkdown,
  renderSarif,
  toSarif,
} from '../src/reporters/index.js';
import { MAX_MARKDOWN_REPORT_BYTES } from '../src/output-safety.js';
import type { Finding, ScanResult } from '../src/types.js';

const sampleFinding: Finding = {
  ruleId: 'sample-rule',
  severity: 'error',
  category: 'text',
  artifactPath: 'static/app.js',
  message: 'Synthetic match',
  evidence: 'private|text',
  location: { line: 2, column: 4, offset: 12 },
};

const result: ScanResult = {
  schemaVersion: 1,
  tool: { name: 'surfaceguard', version: '0.1.0' },
  root: '.',
  adapter: 'generic',
  findings: [sampleFinding],
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
    evidenceDetails: 'complete',
    evidenceLimit: 2_048,
    truncatedEvidence: 0,
    unsupportedTextArtifacts: 0,
  },
  failed: true,
};

describe('reporters', () => {
  it('renders deterministic JSON', () => {
    expect(renderJson(result)).toBe(`${JSON.stringify(result, null, 2)}\n`);
  });

  it('escapes Markdown table content', () => {
    expect(renderMarkdown(result)).toContain('private&#x7C;text');
    expect(renderMarkdown({ ...result, findings: [], failed: false })).toContain(
      'No findings.',
    );
  });

  it('renders untrusted Markdown cells as printable inert text', () => {
    const hostile = {
      ...result,
      findings: [
        {
          ...sampleFinding,
          artifactPath: 'bad\\|name\r<img>.js',
          evidence:
            '\\| </td><img src="https://example.invalid/pixel">\r![fake](https://example.invalid)\u001b[2J\u202E',
        },
      ],
    };
    const markdown = renderMarkdown(hostile);
    expect(markdown).not.toContain('\r');
    expect(markdown).not.toContain('\u001b');
    expect(markdown).not.toContain('\u202E');
    expect(markdown).not.toContain('<img');
    expect(markdown).not.toContain('![fake]');
    expect(markdown).toContain('&#x5C;&#x7C;');
    expect(markdown).toContain('&#x5C;r');
    expect(markdown).toContain('&#x5C;u&#x7B;001B&#x7D;');
    expect(markdown).toContain('&#x5C;u&#x7B;202E&#x7D;');
  });

  it('bounds Markdown output and discloses omitted retained rows', () => {
    const findings = Array.from({ length: 1_000 }, (_, index) => ({
      ...sampleFinding,
      artifactPath: `static/${index}.js`,
      evidence: '😀<|\\\u001b\u202E'.repeat(256),
    }));
    const markdown = renderMarkdown({
      ...result,
      findings,
      completeness: {
        ...result.completeness,
        retainedFindings: findings.length,
        observedFindingsAtLeast: findings.length,
      },
    });
    expect(Buffer.byteLength(markdown, 'utf8')).toBeLessThanOrEqual(
      MAX_MARKDOWN_REPORT_BYTES,
    );
    expect(markdown).toMatch(/Markdown output omitted [1-9][0-9]* retained finding row/u);
    expect(markdown).not.toContain('\u001b');
    expect(markdown).not.toContain('\u202E');
  });

  it('bounds and escapes a hostile adapter even when no findings exist', () => {
    const markdown = renderMarkdown({
      ...result,
      adapter: `${'x'.repeat(MAX_MARKDOWN_REPORT_BYTES + 1)}\n# injected`,
      findings: [],
      failed: false,
    });
    expect(Buffer.byteLength(markdown, 'utf8')).toBeLessThanOrEqual(
      MAX_MARKDOWN_REPORT_BYTES,
    );
    expect(markdown).not.toContain('\n# injected');
    expect(markdown).toContain('truncated sha256');
    expect(markdown).toContain('No findings.');
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
      evidenceDetails: 'complete',
    });
    expect(renderSarif(result)).toBe(renderSarif(result));
  });

  it('encodes artifact paths as relative SARIF URIs', () => {
    const hostilePath = {
      ...result,
      findings: [
        {
          ...sampleFinding,
          artifactPath: 'https:bad #file?.js',
        },
      ],
    };
    const sarif = toSarif(hostilePath) as {
      runs: {
        results: {
          locations: { physicalLocation: { artifactLocation: { uri: string } } }[];
        }[];
      }[];
    };
    expect(
      sarif.runs[0]?.results[0]?.locations[0]?.physicalLocation.artifactLocation.uri,
    ).toBe('https%3Abad%20%23file%3F.js');
  });

  it('fingerprints full evidence even when retained prefixes are identical', () => {
    const findings = ['x', 'y'].map((suffix) => ({
      ...sampleFinding,
      evidence: `${'a'.repeat(2_048)}${suffix}`,
    }));
    const sarif = toSarif({
      ...result,
      findings,
      completeness: {
        ...result.completeness,
        retainedFindings: findings.length,
        observedFindingsAtLeast: findings.length,
      },
    }) as {
      runs: { results: { partialFingerprints: { primaryLocationLineHash: string } }[] }[];
    };
    expect(sarif.runs[0]?.results[0]?.partialFingerprints.primaryLocationLineHash).not.toBe(
      sarif.runs[0]?.results[1]?.partialFingerprints.primaryLocationLineHash,
    );
  });
});
