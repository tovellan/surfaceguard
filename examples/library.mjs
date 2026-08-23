import { loadPolicy, scanArtifacts } from '@tovellan/surfaceguard';

const [root, policyPath] = process.argv.slice(2);
if (!root || !policyPath) {
  process.stderr.write('Usage: node library.mjs <artifact-dir> <policy.json>\n');
  process.exitCode = 2;
} else {
  const policy = await loadPolicy(policyPath);
  const result = await scanArtifacts({ root, policy });
  process.stdout.write(
    `${JSON.stringify({ adapter: result.adapter, findings: result.findings.length, failed: result.failed })}\n`,
  );
  if (result.failed) process.exitCode = 1;
}
