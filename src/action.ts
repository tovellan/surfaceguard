import { appendFile, writeFile } from 'node:fs/promises';

import { annotationCommands, commandData, commandProperty } from './action-output.js';
import { SurfaceGuardError } from './errors.js';
import { boundOutputText, MAX_RETAINED_MESSAGE_BYTES } from './output-safety.js';
import { loadPolicy } from './policy.js';
import { renderMarkdown, renderSarif } from './reporters/index.js';
import { scanArtifacts } from './scan.js';

function input(name: string, required = false): string {
  const key = `INPUT_${name.toUpperCase().replaceAll(' ', '_')}`;
  const value = process.env[key]?.trim() ?? '';
  if (required && !value) {
    throw new SurfaceGuardError('SG_CONFIG_INVALID', `Action input ${name} is required`);
  }
  return value;
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
    adapterValue !== 'astro' &&
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
  await setOutput(
    'findings-truncated',
    String(result.completeness.findingDetails === 'truncated'),
  );
  await setOutput(
    'observed-findings-at-least',
    result.completeness.observedFindingsAtLeast.toString(),
  );
  await setOutput('text-inspection', result.completeness.textInspection);
  await setOutput(
    'evidence-truncated',
    String((result.completeness.truncatedEvidence ?? 0) > 0),
  );
  await setOutput(
    'truncated-evidence',
    (result.completeness.truncatedEvidence ?? 0).toString(),
  );
  await setOutput('failed', String(result.failed));
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) await appendFile(summaryPath, renderMarkdown(result), 'utf8');
  for (const command of annotationCommands(result.findings)) {
    process.stdout.write(command);
  }
  if (result.failed) process.exitCode = 1;
}

run().catch((error: unknown) => {
  const message =
    error instanceof SurfaceGuardError
      ? JSON.stringify(error.toJSON())
      : error instanceof Error
        ? error.message
        : String(error);
  process.stdout.write(
    `::error::${commandData(boundOutputText(message, MAX_RETAINED_MESSAGE_BYTES))}\n`,
  );
  process.exitCode = 1;
});
