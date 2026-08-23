import { appendFile, writeFile } from 'node:fs/promises';

import { SurfaceGuardError } from './errors.js';
import { loadPolicy } from './policy.js';
import { renderMarkdown, renderSarif } from './reporters/index.js';
import { scanArtifacts } from './scan.js';
import type { Finding } from './types.js';

function input(name: string, required = false): string {
  const key = `INPUT_${name.toUpperCase().replaceAll(' ', '_')}`;
  const value = process.env[key]?.trim() ?? '';
  if (required && !value) {
    throw new SurfaceGuardError('SG_CONFIG_INVALID', `Action input ${name} is required`);
  }
  return value;
}

function commandData(value: string): string {
  return value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
}

function commandProperty(value: string): string {
  return commandData(value).replaceAll(':', '%3A').replaceAll(',', '%2C');
}

function annotation(finding: Finding): void {
  const level =
    finding.severity === 'error'
      ? 'error'
      : finding.severity === 'warning'
        ? 'warning'
        : 'notice';
  const properties = [
    `title=${commandProperty(`${finding.ruleId}: ${finding.message}`)}`,
    `file=${commandProperty(finding.artifactPath)}`,
  ];
  if (finding.location) {
    properties.push(`line=${finding.location.line}`, `col=${finding.location.column}`);
  }
  process.stdout.write(
    `::${level} ${properties.join(',')}::${commandData(finding.evidence ?? finding.message)}\n`,
  );
}

async function setOutput(name: string, value: string): Promise<void> {
  const path = process.env.GITHUB_OUTPUT;
  if (path) await appendFile(path, `${name}=${value}\n`, 'utf8');
  else
    process.stdout.write(
      `::set-output name=${commandProperty(name)}::${commandData(value)}\n`,
    );
}

async function run(): Promise<void> {
  const root = input('artifact', true);
  const policyPath = input('policy', true);
  const adapterValue = input('adapter') || 'auto';
  if (
    adapterValue !== 'auto' &&
    adapterValue !== 'generic' &&
    adapterValue !== 'nextjs' &&
    adapterValue !== 'vite'
  ) {
    throw new SurfaceGuardError(
      'SG_CONFIG_INVALID',
      `Unsupported adapter: ${adapterValue}`,
    );
  }
  const sarifPath = input('sarif');
  const policy = await loadPolicy(policyPath);
  const result = await scanArtifacts({ root, policy, adapter: adapterValue });
  if (sarifPath) await writeFile(sarifPath, renderSarif(result), 'utf8');
  await setOutput('findings', result.findings.length.toString());
  await setOutput('failed', String(result.failed));
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) await appendFile(summaryPath, renderMarkdown(result), 'utf8');
  result.findings.forEach(annotation);
  if (result.failed) {
    throw new SurfaceGuardError(
      'SG_IO_ERROR',
      `SurfaceGuard found ${result.findings.length} policy finding(s).`,
    );
  }
}

run().catch((error: unknown) => {
  const message =
    error instanceof SurfaceGuardError
      ? JSON.stringify(error.toJSON())
      : error instanceof Error
        ? error.message
        : String(error);
  process.stdout.write(`::error::${commandData(message)}\n`);
  process.exitCode = 1;
});
