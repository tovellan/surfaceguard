import { execFileSync } from 'node:child_process';

const output = execFileSync('npm', ['query', ':not(:root)', '--json'], {
  encoding: 'utf8',
});
const packages = JSON.parse(output);
const allowed = [
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'BlueOak-1.0.0',
  'ISC',
  'MIT',
  'MPL-2.0',
];
const violations = [];
for (const item of packages) {
  if (typeof item.license !== 'string') {
    violations.push(`${item.name}@${item.version}: missing license metadata`);
    continue;
  }
  const expressions = item.license
    .split(/\s+(?:OR|AND)\s+/u)
    .map((value) => value.replace(/[()]/gu, ''));
  if (!expressions.every((license) => allowed.includes(license))) {
    violations.push(`${item.name}@${item.version}: ${item.license}`);
  }
}

if (violations.length > 0) {
  process.stderr.write(`Dependency license review failed:\n${violations.join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Dependency license review: ${packages.length} packages passed\n`);
}
