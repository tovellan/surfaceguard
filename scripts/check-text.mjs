import { repositoryFiles, readText } from './file-list.mjs';

const violations = [];
for (const path of repositoryFiles()) {
  const text = await readText(path);
  if (text === undefined) continue;
  for (const [character, label] of [
    ['\u2013', 'en dash'],
    ['\u2014', 'em dash'],
  ]) {
    let offset = text.indexOf(character);
    while (offset >= 0) {
      const line = text.slice(0, offset).split('\n').length;
      violations.push(`${path}:${line}: forbidden ${label}`);
      offset = text.indexOf(character, offset + 1);
    }
  }
}

if (violations.length > 0) {
  process.stderr.write(`${violations.join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('Unicode dash policy: passed\n');
}
