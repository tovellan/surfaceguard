import { execFileSync, spawnSync } from 'node:child_process';
import { copyFile, cp, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

const project = resolve(import.meta.dirname, '..');
const temporary = await mkdtemp(join(tmpdir(), 'surfaceguard-install-'));

function run(command, args, expected = 0) {
  const result = spawnSync(command, args, {
    cwd: temporary,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
  if (result.status !== expected) {
    throw new Error(
      `${command} ${args.join(' ')} exited ${result.status}; expected ${expected}\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result;
}

try {
  execFileSync('npm', ['pack', '--silent', '--pack-destination', temporary], {
    cwd: project,
    stdio: 'ignore',
  });
  const packed = (await readdir(temporary)).find((path) => path.endsWith('.tgz'));
  if (!packed) throw new Error('npm pack did not create an archive');
  const archive = join(temporary, basename(packed));
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', archive]);
  await cp(join(project, 'fixtures'), join(temporary, 'fixtures'), { recursive: true });
  await copyFile(join(project, 'examples/library.mjs'), join(temporary, 'library.mjs'));

  run('node', ['node_modules/.bin/surfaceguard', '--version']);
  run('node', [
    'node_modules/.bin/surfaceguard',
    'scan',
    'fixtures/next-passing/build',
    '--policy',
    'fixtures/policy.json',
    '--format',
    'json',
  ]);
  run(
    'node',
    [
      'node_modules/.bin/surfaceguard',
      'scan',
      'fixtures/next-vulnerable/build',
      '--policy',
      'fixtures/policy.json',
      '--format',
      'sarif',
    ],
    1,
  );
  const example = run('node', [
    'library.mjs',
    'fixtures/next-passing/build',
    'fixtures/policy.json',
  ]);
  if (!example.stdout.includes('"failed":false'))
    throw new Error('Library example did not pass');
  process.stdout.write('Clean package install and documented examples: passed\n');
} finally {
  await rm(temporary, { recursive: true, force: true });
}
