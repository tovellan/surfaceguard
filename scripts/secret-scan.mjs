import { execFileSync } from 'node:child_process';

import { repositoryFiles, readText } from './file-list.mjs';

const patterns = [
  ['cloud access key', new RegExp('AK' + 'IA[0-9A-Z]{16}', 'gu')],
  ['GitHub token', new RegExp('gh' + '[pousr]_[A-Za-z0-9]{36,255}', 'gu')],
  ['private key', new RegExp('BEGIN [A-Z ]*PRI' + 'VATE KEY', 'gu')],
  ['package registry token', new RegExp('npm' + '_[A-Za-z0-9]{36,}', 'gu')],
];
const violations = [];

async function scan(label, text) {
  for (const [name, expression] of patterns) {
    expression.lastIndex = 0;
    if (expression.test(text)) violations.push(`${label}: possible ${name}`);
  }
}

for (const path of repositoryFiles()) {
  const text = await readText(path);
  if (text !== undefined) await scan(path, text);
}

let history = '';
try {
  history = execFileSync('git', ['log', '--all', '-p', '--no-ext-diff', '--no-textconv'], {
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  });
} catch (error) {
  if (error.status !== 0) throw error;
}
await scan('Git history', history);

if (violations.length > 0) {
  process.stderr.write(`${violations.join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('Secret scan of files and complete Git history: passed\n');
}
