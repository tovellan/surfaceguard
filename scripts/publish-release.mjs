import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

function assetMatches(asset, contract) {
  return (
    asset?.name === contract.archiveName &&
    asset?.state === 'uploaded' &&
    asset?.size === contract.archiveSize &&
    asset?.digest === contract.archiveDigest
  );
}

function assetAwaitsDigest(asset, contract) {
  return (
    asset?.name === contract.archiveName &&
    asset?.state === 'uploaded' &&
    asset?.size === contract.archiveSize &&
    (asset?.digest === null || asset?.digest === undefined)
  );
}

function metadataMatches(release, contract) {
  return (
    release?.tag_name === contract.tag &&
    release?.name === contract.title &&
    release?.body === contract.notes &&
    release?.prerelease === false
  );
}

export function classifyReleaseState(release, contract) {
  if (release === undefined) return 'create';
  if (!metadataMatches(release, contract)) return 'conflict';
  const assets = Array.isArray(release.assets) ? release.assets : [];
  if (release.draft === true) {
    if (assets.length === 0) return 'upload';
    if (assets.length === 1 && assetAwaitsDigest(assets[0], contract)) return 'wait';
    return assets.length === 1 && assetMatches(assets[0], contract)
      ? 'publish'
      : 'conflict';
  }
  if (release.draft === false && assets.length === 1 && assetMatches(assets[0], contract)) {
    return release.immutable === true ? 'complete' : 'wait';
  }
  return 'conflict';
}

export async function convergeRelease(driver, contract, maximumTransitions = 32) {
  for (let transition = 0; transition <= maximumTransitions; transition += 1) {
    const release = await driver.fetch();
    const state = classifyReleaseState(release, contract);
    if (state === 'complete') return release;
    if (state === 'conflict') {
      throw new Error(
        `Release ${contract.tag} does not match the expected release contract`,
      );
    }
    if (transition === maximumTransitions) break;
    await driver[state](release);
  }
  throw new Error(`Release ${contract.tag} did not converge to the immutable contract`);
}

function runGh(args) {
  return execFileSync('gh', args, {
    encoding: 'utf8',
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function selectRelease(pages, tag) {
  if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) {
    throw new Error('GitHub release listing returned an unexpected shape');
  }
  const matches = pages
    .flat()
    .filter((release) => release !== null && release?.tag_name === tag);
  if (matches.length > 1) {
    throw new Error(`Found multiple GitHub releases for ${tag}`);
  }
  return matches[0];
}

function fetchRelease(repository, tag) {
  const pages = JSON.parse(
    runGh(['api', '--paginate', '--slurp', `repos/${repository}/releases?per_page=100`]),
  );
  return selectRelease(pages, tag);
}

export function assertImmutableReleaseSetting(settings) {
  if (settings?.enabled !== true) {
    throw new Error('Repository immutable releases must be enabled');
  }
}

export async function guardedReleaseMutation(loadSettings, mutate) {
  const settings = await loadSettings();
  assertImmutableReleaseSetting(settings);
  return mutate();
}

function fetchImmutableReleaseSetting(repository) {
  return JSON.parse(runGh(['api', `repos/${repository}/immutable-releases`]));
}

export function assertTagContract(ref, annotatedTag, contract) {
  const valid =
    ref?.ref === `refs/tags/${contract.tag}` &&
    ref?.object?.type === 'tag' &&
    ref?.object?.sha === contract.tagObject &&
    annotatedTag?.sha === contract.tagObject &&
    annotatedTag?.tag === contract.tag &&
    annotatedTag?.message === `SurfaceGuard ${contract.tag}\n` &&
    annotatedTag?.tagger?.name === 'Tovellan' &&
    annotatedTag?.tagger?.email === 'tovellan@users.noreply.github.com' &&
    annotatedTag?.object?.type === 'commit' &&
    annotatedTag?.object?.sha === contract.releaseCommit;
  if (!valid) throw new Error(`Remote tag ${contract.tag} does not match the contract`);
}

function verifyRemoteTag(repository, contract) {
  const ref = JSON.parse(
    runGh(['api', `repos/${repository}/git/ref/tags/${contract.tag}`]),
  );
  const annotatedTag = JSON.parse(
    runGh(['api', `repos/${repository}/git/tags/${contract.tagObject}`]),
  );
  assertTagContract(ref, annotatedTag, contract);
}

export function assertPublishTarget(current, snapshot, contract) {
  if (
    !Number.isSafeInteger(snapshot?.id) ||
    snapshot.id <= 0 ||
    current?.id !== snapshot.id ||
    classifyReleaseState(current, contract) !== 'publish'
  ) {
    throw new Error(`Draft ${contract.tag} changed before publication`);
  }
}

async function publishRelease(repository, snapshot, contract) {
  const endpoint = `repos/${repository}/releases/${snapshot?.id}`;
  const current = JSON.parse(runGh(['api', endpoint]));
  assertPublishTarget(current, snapshot, contract);
  await guardedReleaseMutation(
    () => fetchImmutableReleaseSetting(repository),
    () => runGh(['api', '--method', 'PATCH', endpoint, '-F', 'draft=false']),
  );
}

async function archiveContract(directory) {
  const files = await readdir(directory);
  const archives = files.filter((file) => file.endsWith('.tgz'));
  if (archives.length !== 1) {
    throw new Error(`Expected exactly one release archive, found ${archives.length}`);
  }
  const archivePath = join(directory, archives[0]);
  const archive = await readFile(archivePath);
  const archiveStat = await stat(archivePath);
  if (!archiveStat.isFile()) throw new Error('Release archive is not a regular file');
  const notesPath = join(directory, 'release-notes.md');
  const notes = await readFile(notesPath, 'utf8');
  return {
    archivePath,
    notesPath,
    archiveName: basename(archivePath),
    archiveSize: archive.byteLength,
    archiveDigest: `sha256:${createHash('sha256').update(archive).digest('hex')}`,
    notes,
  };
}

async function main() {
  const tag = process.env.RELEASE_TAG ?? '';
  const repository = process.env.GITHUB_REPOSITORY ?? '';
  const tagObject = process.env.EXPECTED_TAG_OBJECT ?? '';
  const releaseCommit = process.env.EXPECTED_RELEASE_COMMIT ?? '';
  if (!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(tag)) {
    throw new Error('RELEASE_TAG must be a canonical vX.Y.Z version');
  }
  if (!/^[a-z\d_.-]+\/[a-z\d_.-]+$/iu.test(repository)) {
    throw new Error('GITHUB_REPOSITORY must be an owner/repository pair');
  }
  if (!/^[0-9a-f]{40}$/u.test(tagObject) || !/^[0-9a-f]{40}$/u.test(releaseCommit)) {
    throw new Error('Expected tag object and release commit must be full Git object IDs');
  }
  const directory = resolve(process.argv[2] ?? 'release-assets');
  const local = await archiveContract(directory);
  const contract = {
    tag,
    title: `SurfaceGuard ${tag}`,
    notes: local.notes,
    archiveName: local.archiveName,
    archiveSize: local.archiveSize,
    archiveDigest: local.archiveDigest,
    tagObject,
    releaseCommit,
  };

  verifyRemoteTag(repository, contract);

  const release = await convergeRelease(
    {
      fetch: () => fetchRelease(repository, tag),
      create: () => {
        verifyRemoteTag(repository, contract);
        return guardedReleaseMutation(
          () => fetchImmutableReleaseSetting(repository),
          () =>
            runGh([
              'release',
              'create',
              tag,
              '--repo',
              repository,
              '--draft',
              '--verify-tag',
              '--title',
              contract.title,
              '--notes-file',
              local.notesPath,
            ]),
        );
      },
      upload: () =>
        runGh(['release', 'upload', tag, local.archivePath, '--repo', repository]),
      wait: () => delay(1_000),
      publish: (snapshot) => {
        verifyRemoteTag(repository, contract);
        return publishRelease(repository, snapshot, contract);
      },
    },
    contract,
  );
  verifyRemoteTag(repository, contract);
  if (release.tag_name !== tag) throw new Error('Published release tag changed');
  process.stdout.write(
    `Verified immutable ${tag}: ${contract.archiveName} ${contract.archiveDigest}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
