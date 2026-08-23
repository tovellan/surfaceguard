import { execFileSync, spawnSync } from 'node:child_process';
import {
  access,
  copyFile,
  cp,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';

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

function isContained(root, target) {
  const child = relative(root, target);
  return (
    child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child))
  );
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
  const installedRoot = await realpath(
    join(temporary, 'node_modules', '@tovellan', 'surfaceguard'),
  );
  const installedReadme = await readFile(join(installedRoot, 'README.md'), 'utf8');
  const relativeLinks = [
    ...installedReadme.matchAll(
      /\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/gu,
    ),
  ]
    .map((match) => match[1] ?? match[2])
    .filter(
      (destination) =>
        destination !== undefined &&
        !/^[a-z][a-z\d+.-]*:/iu.test(destination) &&
        !destination.startsWith('//') &&
        !destination.startsWith('#'),
    );
  for (const relativeLink of relativeLinks) {
    if (!relativeLink) continue;
    const linkPath = relativeLink.split(/[?#]/u, 1)[0];
    if (!linkPath) continue;
    const target = resolve(installedRoot, decodeURIComponent(linkPath));
    if (!isContained(installedRoot, target)) {
      throw new Error(
        `Packaged README link escapes the installed package: ${relativeLink}`,
      );
    }
    await access(target);
    if (!isContained(installedRoot, await realpath(target))) {
      throw new Error(
        `Packaged README link resolves outside the installed package: ${relativeLink}`,
      );
    }
  }
  await cp(join(project, 'fixtures'), join(temporary, 'fixtures'), { recursive: true });
  await copyFile(join(project, 'examples/library.mjs'), join(temporary, 'library.mjs'));

  run('node', ['node_modules/.bin/surfaceguard', '--version']);
  run('node', [
    'node_modules/.bin/surfaceguard',
    'init',
    '--output',
    'generated.policy.json',
  ]);
  const generatedPolicy = JSON.parse(
    await readFile(join(temporary, 'generated.policy.json'), 'utf8'),
  );
  if (
    JSON.stringify(generatedPolicy.routes?.deny) !== JSON.stringify(['/staff', '/staff/**'])
  ) {
    throw new Error(
      'Generated starter policy did not preserve exact and descendant route denial',
    );
  }
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
