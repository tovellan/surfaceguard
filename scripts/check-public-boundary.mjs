import { stat } from 'node:fs/promises';

import { repositoryFiles, readText } from './file-list.mjs';

const forbidden = [
  ['/Users' + '/', 'workstation path'],
  ['startup' + '-idea', 'private checkout name'],
  ['gst' + '-bench', 'protected product term'],
  ['held' + '-out', 'protected split term'],
  ['tovellan-' + 'platform', 'private repository name'],
  ['tovellan-' + 'trust', 'private repository name'],
  ['tovellan-' + 'web', 'private repository name'],
  ['localhost' + ':', 'local URL'],
  ['127.' + '0.0.1', 'loopback URL'],
];
const violations = [];

for (const path of repositoryFiles()) {
  const info = await stat(path);
  if (info.size > 1024 * 1024)
    violations.push(`${path}: exceeds the 1 MiB tracked-file limit`);
  if (/\.(?:wav|mp3|mp4|mov)$/iu.test(path))
    violations.push(`${path}: media is not allowed`);
  const text = await readText(path);
  if (text === undefined) {
    violations.push(`${path}: binary or invalid UTF-8 tracked file`);
    continue;
  }
  const lower = text.toLowerCase();
  for (const [term, label] of forbidden) {
    if (lower.includes(term.toLowerCase())) violations.push(`${path}: contains ${label}`);
  }
  if (path.startsWith('.github/workflows/')) {
    for (const match of text.matchAll(/^\s*uses:\s*([^\s#]+)/gmu)) {
      const reference = match[1] ?? '';
      if (reference.startsWith('./')) continue;
      if (!/@[0-9a-f]{40}$/u.test(reference)) {
        violations.push(`${path}: external action is not pinned to an immutable commit`);
      }
    }
  }
}

if (violations.length > 0) {
  process.stderr.write(`${violations.join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('Public boundary review: passed\n');
}
