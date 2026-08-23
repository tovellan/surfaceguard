import { boundFindingEvidence, displayEvidence, printableText } from './output-safety.js';
import type { Finding } from './types.js';

type AnnotationLevel = 'error' | 'warning' | 'notice';

export const MAX_ANNOTATIONS_PER_LEVEL = 10;

function annotationLevel(finding: Finding): AnnotationLevel {
  return finding.severity === 'error'
    ? 'error'
    : finding.severity === 'warning'
      ? 'warning'
      : 'notice';
}

export function commandData(value: string): string {
  return printableText(value)
    .replaceAll('%', '%25')
    .replaceAll('\r', '%0D')
    .replaceAll('\n', '%0A');
}

export function commandProperty(value: string): string {
  return commandData(value).replaceAll(':', '%3A').replaceAll(',', '%2C');
}

export function annotationCommand(finding: Finding): string {
  const bounded = boundFindingEvidence(finding);
  const level = annotationLevel(bounded);
  const properties = [
    `title=${commandProperty(bounded.ruleId)}`,
    `file=${commandProperty(bounded.artifactPath)}`,
  ];
  if (bounded.location) {
    properties.push(`line=${bounded.location.line}`, `col=${bounded.location.column}`);
  }
  return `::${level} ${properties.join(',')}::${commandData(`${bounded.message}: ${displayEvidence(bounded)}`)}\n`;
}

export function annotationCommands(findings: readonly Finding[]): string[] {
  const used: Record<AnnotationLevel, number> = { error: 0, warning: 0, notice: 0 };
  const omitted: Record<AnnotationLevel, number> = { error: 0, warning: 0, notice: 0 };
  const selected: { finding: Finding; level: AnnotationLevel }[] = [];

  for (const finding of findings) {
    const level = annotationLevel(finding);
    if (used[level] < MAX_ANNOTATIONS_PER_LEVEL) {
      used[level] += 1;
      selected.push({ finding, level });
    } else {
      omitted[level] += 1;
    }
  }

  let omittedTotal = omitted.error + omitted.warning + omitted.notice;
  if (omittedTotal > 0 && used.notice === MAX_ANNOTATIONS_PER_LEVEL) {
    for (let index = selected.length - 1; index >= 0; index -= 1) {
      if (selected[index]?.level !== 'notice') continue;
      selected.splice(index, 1);
      used.notice -= 1;
      omitted.notice += 1;
      omittedTotal += 1;
      break;
    }
  }

  const commands = selected.map((item) => annotationCommand(item.finding));
  if (omittedTotal > 0) {
    const message =
      `SurfaceGuard omitted ${omittedTotal} finding annotation(s) to bound log output ` +
      `(errors: ${omitted.error}, warnings: ${omitted.warning}, notices: ${omitted.notice}). ` +
      'See the job summary or SARIF for retained details.';
    commands.push(
      `::notice title=${commandProperty('SurfaceGuard annotation limit')}::${commandData(message)}\n`,
    );
  }
  return commands;
}
