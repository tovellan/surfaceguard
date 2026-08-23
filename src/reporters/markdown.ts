import type { Finding, ScanResult } from '../types.js';

function table(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', '<br>');
}

function location(finding: Finding): string {
  if (!finding.location) return finding.artifactPath;
  return `${finding.artifactPath}:${finding.location.line}:${finding.location.column}`;
}

export function renderMarkdown(result: ScanResult): string {
  const status = result.failed ? 'failed' : 'passed';
  const lines = [
    '# SurfaceGuard report',
    '',
    `Status: **${status}**`,
    '',
    `Adapter: \`${result.adapter}\``,
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
      `Finding details were truncated at ${result.completeness.findingLimit} retained item(s); at least ${result.completeness.observedFindingsAtLeast} finding(s) were observed.`,
      '',
    );
  }
  if (result.findings.length === 0) {
    lines.push('No findings.', '');
    return `${lines.join('\n')}\n`;
  }
  lines.push('| Severity | Rule | Artifact | Evidence |', '| --- | --- | --- | --- |');
  for (const finding of result.findings) {
    lines.push(
      `| ${finding.severity} | ${table(finding.ruleId)} | ${table(location(finding))} | ${table(finding.evidence ?? finding.message)} |`,
    );
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}
