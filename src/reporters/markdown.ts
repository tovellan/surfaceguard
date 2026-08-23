import {
  boundFindingEvidence,
  boundOutputText,
  displayEvidence,
  markdownCell,
  MAX_MARKDOWN_REPORT_BYTES,
  MAX_RETAINED_EVIDENCE_BYTES,
  MAX_RETAINED_MESSAGE_BYTES,
} from '../output-safety.js';
import type { Finding, ScanResult, Severity } from '../types.js';

const SEVERITY_RANK: Readonly<Record<Severity, number>> = {
  error: 2,
  warning: 1,
  note: 0,
};

function location(finding: Finding): string {
  if (!finding.location) return finding.artifactPath;
  return `${finding.artifactPath}:${finding.location.line}:${finding.location.column}`;
}

function row(finding: Finding): string {
  return `| ${finding.severity} | ${markdownCell(finding.ruleId)} | ${markdownCell(location(finding))} | ${markdownCell(displayEvidence(finding))} |`;
}

function omittedRowsNotice(count: number): string {
  return `Markdown output omitted ${count} retained finding row(s) to keep this report within ${MAX_MARKDOWN_REPORT_BYTES} UTF-8 bytes.`;
}

export function renderMarkdown(result: ScanResult): string {
  const status = result.failed ? 'failed' : 'passed';
  const adapter = markdownCell(boundOutputText(result.adapter, MAX_RETAINED_MESSAGE_BYTES));
  const findings = result.findings.map(boundFindingEvidence);
  const truncatedEvidence = Math.max(
    result.completeness.truncatedEvidence ?? 0,
    findings.filter((finding) => finding.evidenceTruncated).length,
  );
  const lines = [
    '# SurfaceGuard report',
    '',
    `Status: **${status}**`,
    '',
    `Adapter: ${adapter}`,
    '',
    `Scanned ${result.statistics.filesScanned} text artifacts (${result.statistics.bytesVisited} bytes) and discovered ${result.statistics.routesFound} routes.`,
    '',
  ];
  if (result.completeness.textInspection === 'incomplete') {
    lines.push(
      `${result.completeness.unsupportedTextArtifacts} text artifact(s) used an unsupported or ambiguous encoding. Best-effort matching continued, but text inspection is incomplete.`,
      '',
    );
  }
  if (result.completeness.findingDetails === 'truncated') {
    lines.push(
      `Finding rows were truncated at ${result.completeness.findingLimit} retained item(s); at least ${result.completeness.observedFindingsAtLeast} finding(s) were observed.`,
      '',
    );
  }
  if (truncatedEvidence > 0) {
    lines.push(
      `${truncatedEvidence} retained finding evidence value(s) exceeded ${result.completeness.evidenceLimit ?? MAX_RETAINED_EVIDENCE_BYTES} UTF-8 bytes and are shown as bounded prefixes.`,
      '',
    );
  }
  if (findings.length === 0) {
    lines.push('No findings.', '');
    return `${lines.join('\n')}\n`;
  }

  const tableHeader = [
    '| Severity | Rule | Artifact | Evidence |',
    '| --- | --- | --- | --- |',
  ];
  const rows = findings.map((finding, index) => ({
    finding,
    index,
    text: row(finding),
  }));
  const complete = [...lines, ...tableHeader, ...rows.map((item) => item.text), ''];
  const completeReport = `${complete.join('\n')}\n`;
  if (Buffer.byteLength(completeReport, 'utf8') <= MAX_MARKDOWN_REPORT_BYTES) {
    return completeReport;
  }

  const prefix = `${[...lines, ...tableHeader].join('\n')}\n`;
  const maximumNotice = `${omittedRowsNotice(rows.length)}\n`;
  let available =
    MAX_MARKDOWN_REPORT_BYTES -
    Buffer.byteLength(prefix, 'utf8') -
    Buffer.byteLength(maximumNotice, 'utf8') -
    2;
  const selected = new Set<number>();
  const prioritized = [...rows].sort(
    (left, right) =>
      SEVERITY_RANK[right.finding.severity] - SEVERITY_RANK[left.finding.severity] ||
      left.index - right.index,
  );
  for (const item of prioritized) {
    const bytes = Buffer.byteLength(`${item.text}\n`, 'utf8');
    if (bytes > available) continue;
    selected.add(item.index);
    available -= bytes;
  }

  const retainedRows = rows
    .filter((item) => selected.has(item.index))
    .map((item) => item.text);
  const omitted = rows.length - retainedRows.length;
  return `${[
    ...lines,
    ...tableHeader,
    ...retainedRows,
    '',
    omittedRowsNotice(omitted),
    '',
  ].join('\n')}\n`;
}
