import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  annotationCommand,
  annotationCommands,
  MAX_ANNOTATIONS_PER_LEVEL,
} from '../src/action-output.js';
import {
  boundFindingEvidence,
  MAX_RETAINED_EVIDENCE_BYTES,
  MAX_RETAINED_MESSAGE_BYTES,
  MAX_RETAINED_RULE_ID_BYTES,
} from '../src/output-safety.js';
import { renderMarkdown, renderSarif } from '../src/reporters/index.js';
import { scanArtifacts } from '../src/scan.js';
import type { Finding, Severity } from '../src/types.js';

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function finding(severity: Severity, index = 0): Finding {
  return {
    ruleId: `synthetic-${index}`,
    severity,
    category: 'text',
    artifactPath: `static/${index}.js`,
    message: 'Synthetic finding',
    evidence: `evidence-${index}`,
  };
}

describe('output boundaries', () => {
  it('retains a UTF-8-bounded evidence prefix with stable truncation metadata', () => {
    const bounded = boundFindingEvidence({
      ...finding('error'),
      evidence: '😀'.repeat(2_000),
    });
    expect(Buffer.byteLength(bounded.evidence ?? '', 'utf8')).toBeLessThanOrEqual(
      MAX_RETAINED_EVIDENCE_BYTES,
    );
    expect(bounded.evidenceTruncated).toBe(true);
    expect(bounded.evidenceBytes).toBe(8_000);
    expect(bounded.evidenceSha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('bounds policy-controlled identifiers and messages across retained outputs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'surfaceguard-output-policy-text-'));
    temporary.push(root);
    await writeFile(join(root, 'bundle.js'), 'MATCH', 'utf8');
    const result = await scanArtifacts({
      root,
      policy: {
        schemaVersion: 1,
        forbidden: {
          text: [
            {
              id: 'synthetic-output',
              pattern: 'MATCH',
              message: 'Synthetic output',
            },
          ],
        },
      },
    });
    const retained = result.findings[0];
    if (!retained) expect.fail('expected a retained finding');
    const unsafeFinding = {
      ...retained,
      ruleId: `a${'b'.repeat(10_000)}`,
      message: 'message'.repeat(10_000),
    };
    const bounded = boundFindingEvidence(unsafeFinding);
    const unsafeResult = { ...result, findings: [unsafeFinding] };
    expect(Buffer.byteLength(bounded.ruleId, 'utf8')).toBeLessThanOrEqual(
      MAX_RETAINED_RULE_ID_BYTES,
    );
    expect(Buffer.byteLength(bounded.message, 'utf8')).toBeLessThanOrEqual(
      MAX_RETAINED_MESSAGE_BYTES,
    );
    expect(bounded.ruleId).toContain('truncated sha256:');
    expect(bounded.message).toContain('truncated sha256:');
    expect(Buffer.byteLength(annotationCommand(unsafeFinding), 'utf8')).toBeLessThan(5_000);
    expect(Buffer.byteLength(renderMarkdown(unsafeResult), 'utf8')).toBeLessThan(10_000);
    expect(Buffer.byteLength(renderSarif(unsafeResult), 'utf8')).toBeLessThan(20_000);
  });

  it('makes annotation text printable and inert', () => {
    const command = annotationCommand({
      ...finding('error'),
      artifactPath: 'bad\r\u001b[2J\u202E.js',
      evidence: 'value\n::error::fake\u001b]8;;https://example.invalid\u0007',
    });
    const body = command.slice(0, -1);
    let containsUnsafeControl = false;
    for (const character of body) {
      const codePoint = character.codePointAt(0) ?? 0;
      if (
        codePoint <= 0x1f ||
        (codePoint >= 0x7f && codePoint <= 0x9f) ||
        (codePoint >= 0x202a && codePoint <= 0x202e) ||
        (codePoint >= 0x2066 && codePoint <= 0x2069)
      ) {
        containsUnsafeControl = true;
        break;
      }
    }
    expect(containsUnsafeControl).toBe(false);
    expect(body).toContain('\\r');
    expect(body).toContain('\\n');
    expect(body).toContain('\\u{001B}');
    expect(body).toContain('\\u{202E}');
  });

  it('caps annotations per level and emits one omitted-count notice', () => {
    const findings = (['error', 'warning', 'note'] as const).flatMap((severity) =>
      Array.from({ length: 15 }, (_, index) => finding(severity, index)),
    );
    const commands = annotationCommands(findings);
    expect(commands.filter((command) => command.startsWith('::error '))).toHaveLength(
      MAX_ANNOTATIONS_PER_LEVEL,
    );
    expect(commands.filter((command) => command.startsWith('::warning '))).toHaveLength(
      MAX_ANNOTATIONS_PER_LEVEL,
    );
    expect(commands.filter((command) => command.startsWith('::notice '))).toHaveLength(
      MAX_ANNOTATIONS_PER_LEVEL,
    );
    expect(commands.at(-1)).toContain('omitted 16 finding annotation(s)');
    expect(commands.at(-1)).toContain('errors: 5');
    expect(commands.at(-1)).toContain('warnings: 5');
    expect(commands.at(-1)).toContain('notices: 6');
  });

  it('bounds scan evidence without changing failure evaluation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'surfaceguard-output-bound-'));
    temporary.push(root);
    await writeFile(
      join(root, 'bundle.js'),
      `//# sourceMappingURL=${'A'.repeat(10_000)}`,
      'utf8',
    );
    const result = await scanArtifacts({
      root,
      policy: { schemaVersion: 1, sourceMaps: { mode: 'forbid', inline: 'forbid' } },
    });
    const sourceMap = result.findings.find((item) => item.ruleId === 'SG3003');
    expect(result.failed).toBe(true);
    expect(sourceMap?.evidenceTruncated).toBe(true);
    expect(Buffer.byteLength(sourceMap?.evidence ?? '', 'utf8')).toBeLessThanOrEqual(
      MAX_RETAINED_EVIDENCE_BYTES,
    );
    expect(result.completeness).toMatchObject({
      evidenceDetails: 'truncated',
      truncatedEvidence: 1,
      evidenceLimit: MAX_RETAINED_EVIDENCE_BYTES,
    });
  });

  it('reports CR-only source coordinates consistently', async () => {
    const root = await mkdtemp(join(tmpdir(), 'surfaceguard-output-location-'));
    temporary.push(root);
    await writeFile(join(root, 'a.js'), 'first\rMATCH', 'utf8');
    await writeFile(join(root, 'b.js'), 'first\r//# sourceMappingURL=map.js', 'utf8');
    const result = await scanArtifacts({
      root,
      policy: {
        schemaVersion: 1,
        sourceMaps: { mode: 'forbid', inline: 'forbid' },
        forbidden: { text: [{ id: 'synthetic-match', pattern: 'MATCH' }] },
      },
    });
    expect(
      result.findings.find((item) => item.ruleId === 'synthetic-match')?.location,
    ).toMatchObject({ line: 2, column: 1 });
    expect(
      result.findings.find((item) => item.ruleId === 'SG3003')?.location,
    ).toMatchObject({ line: 2, column: 3 });
  });

  it('locates many late matches without rescanning their shared prefix', async () => {
    const root = await mkdtemp(join(tmpdir(), 'surfaceguard-output-many-locations-'));
    temporary.push(root);
    await writeFile(
      join(root, 'bundle.js'),
      `${'a'.repeat(1_000_000)}${'x'.repeat(1_000)}`,
      'utf8',
    );
    const started = performance.now();
    const result = await scanArtifacts({
      root,
      policy: {
        schemaVersion: 1,
        limits: { maxFindings: 1_000 },
        forbidden: { text: [{ id: 'late-match', pattern: 'x' }] },
      },
    });
    const elapsed = performance.now() - started;
    expect(result.findings).toHaveLength(1_000);
    expect(result.findings[0]?.location).toMatchObject({
      line: 1,
      column: 1_000_001,
    });
    expect(elapsed).toBeLessThan(2_000);
  });
});
