import assert from 'node:assert/strict';

import {
  assertImmutableReleaseSetting,
  assertPublishTarget,
  assertTagContract,
  classifyReleaseState,
  convergeRelease,
  guardedReleaseMutation,
  selectRelease,
} from './publish-release.mjs';

const contract = {
  tag: 'v0.5.2',
  title: 'SurfaceGuard v0.5.2',
  notes: '# SurfaceGuard 0.5.2\n',
  archiveName: 'tovellan-surfaceguard-0.5.2.tgz',
  archiveSize: 90_583,
  archiveDigest: `sha256:${'a'.repeat(64)}`,
  tagObject: 'b'.repeat(40),
  releaseCommit: 'c'.repeat(40),
};
const asset = {
  name: contract.archiveName,
  state: 'uploaded',
  size: contract.archiveSize,
  digest: contract.archiveDigest,
};
const draft = {
  id: 375_000_000,
  tag_name: contract.tag,
  name: contract.title,
  body: contract.notes,
  prerelease: false,
  draft: true,
  immutable: false,
  assets: [],
};

assert.equal(classifyReleaseState(undefined, contract), 'create');
assert.equal(classifyReleaseState(draft, contract), 'upload');
assert.equal(classifyReleaseState({ ...draft, assets: [asset] }, contract), 'publish');
assert.equal(
  classifyReleaseState({ ...draft, assets: [{ ...asset, digest: null }] }, contract),
  'wait',
);
assert.equal(
  classifyReleaseState(
    { ...draft, assets: [{ ...asset, digest: 'sha256:wrong' }] },
    contract,
  ),
  'conflict',
);
assert.equal(
  classifyReleaseState({ ...draft, body: 'partial notes', assets: [asset] }, contract),
  'conflict',
);
assert.equal(
  classifyReleaseState(
    { ...draft, draft: false, immutable: true, assets: [asset] },
    contract,
  ),
  'complete',
);
assert.equal(
  classifyReleaseState(
    { ...draft, draft: false, immutable: false, assets: [asset] },
    contract,
  ),
  'wait',
);
assert.equal(
  classifyReleaseState(
    { ...draft, draft: false, immutable: true, assets: [asset, asset] },
    contract,
  ),
  'conflict',
);

assert.equal(selectRelease([[draft]], contract.tag), draft);
assert.equal(selectRelease([[], []], contract.tag), undefined);
assert.equal(
  selectRelease([[{ ...draft, tag_name: 'v0.5.1' }], [draft]], contract.tag),
  draft,
);
assert.throws(() => selectRelease([draft], contract.tag), /unexpected shape/u);
assert.throws(() => selectRelease([[draft], [draft]], contract.tag), /multiple/u);

const tagRef = {
  ref: `refs/tags/${contract.tag}`,
  object: { type: 'tag', sha: contract.tagObject },
};
const annotatedTag = {
  sha: contract.tagObject,
  tag: contract.tag,
  message: `SurfaceGuard ${contract.tag}\n`,
  tagger: {
    name: 'Tovellan',
    email: 'tovellan@users.noreply.github.com',
  },
  object: { type: 'commit', sha: contract.releaseCommit },
};
assert.doesNotThrow(() => assertTagContract(tagRef, annotatedTag, contract));
assert.throws(
  () =>
    assertTagContract(
      tagRef,
      { ...annotatedTag, message: `${annotatedTag.message}Co-authored-by: Person\n` },
      contract,
    ),
  /does not match/u,
);
assert.throws(
  () =>
    assertTagContract(
      tagRef,
      { ...annotatedTag, tagger: { ...annotatedTag.tagger, name: 'Person' } },
      contract,
    ),
  /does not match/u,
);

const publishable = { ...draft, assets: [asset] };
assert.doesNotThrow(() => assertPublishTarget(publishable, publishable, contract));
assert.throws(
  () => assertPublishTarget({ ...publishable, id: draft.id + 1 }, publishable, contract),
  /changed/u,
);
assert.throws(
  () => assertPublishTarget({ ...publishable, body: 'changed' }, publishable, contract),
  /changed/u,
);

assert.doesNotThrow(() => assertImmutableReleaseSetting({ enabled: true }));
assert.throws(() => assertImmutableReleaseSetting({ enabled: false }), /must be enabled/u);

const disabledMutations = [];
await assert.rejects(
  guardedReleaseMutation(
    () => ({ enabled: false }),
    () => disabledMutations.push('create'),
  ),
  /must be enabled/u,
);
assert.deepEqual(disabledMutations, []);

const changingSettings = [{ enabled: true }, { enabled: false }];
const driftMutations = [];
await guardedReleaseMutation(
  () => changingSettings.shift(),
  () => driftMutations.push('create'),
);
await assert.rejects(
  guardedReleaseMutation(
    () => changingSettings.shift(),
    () => driftMutations.push('publish'),
  ),
  /must be enabled/u,
);
assert.deepEqual(driftMutations, ['create']);

function recoveryDriver(initialRelease, options = {}) {
  let release = initialRelease;
  let digestWaits = 0;
  let fetches = 0;
  const calls = [];
  const failures = { ...options.failures };

  function fail(operation, timing) {
    const key = `${operation}:${timing}`;
    const remaining = failures[key] ?? 0;
    if (remaining === 0) return;
    failures[key] = remaining - 1;
    throw new Error(`${operation} failed ${timing} remote mutation`);
  }

  return {
    calls,
    get fetches() {
      return fetches;
    },
    fetch: () => {
      fetches += 1;
      return Promise.resolve(release);
    },
    create: () => {
      calls.push('create');
      fail('create', 'before');
      release = { ...draft };
      fail('create', 'after');
    },
    upload: () => {
      calls.push('upload');
      fail('upload', 'before');
      release = { ...draft, assets: [asset] };
      fail('upload', 'after');
    },
    wait: () => {
      calls.push('wait');
      digestWaits += 1;
      if (digestWaits >= (options.digestReadyAfterWait ?? 1)) {
        release = { ...draft, assets: [asset] };
      }
    },
    publish: () => {
      calls.push('publish');
      fail('publish', 'before');
      release = { ...draft, draft: false, immutable: true, assets: [asset] };
      fail('publish', 'after');
    },
  };
}

const fresh = recoveryDriver(undefined);
await convergeRelease(fresh, contract);
assert.deepEqual(fresh.calls, ['create', 'upload', 'publish']);

const partialDraft = recoveryDriver(draft);
await convergeRelease(partialDraft, contract);
assert.deepEqual(partialDraft.calls, ['upload', 'publish']);

const wrongDraft = recoveryDriver({
  ...draft,
  assets: [{ ...asset, digest: 'sha256:wrong' }],
});
await assert.rejects(convergeRelease(wrongDraft, contract), /does not match/u);
assert.deepEqual(wrongDraft.calls, []);

const createResponseLoss = recoveryDriver(undefined, {
  failures: { 'create:after': 1 },
});
await assert.rejects(convergeRelease(createResponseLoss, contract), /create failed/u);
await convergeRelease(createResponseLoss, contract);
assert.deepEqual(createResponseLoss.calls, ['create', 'upload', 'publish']);

const uploadBeforeMutation = recoveryDriver(draft, {
  failures: { 'upload:before': 1 },
});
await assert.rejects(convergeRelease(uploadBeforeMutation, contract), /upload failed/u);
await convergeRelease(uploadBeforeMutation, contract);
assert.deepEqual(uploadBeforeMutation.calls, ['upload', 'upload', 'publish']);

const publishBeforeMutation = recoveryDriver(
  { ...draft, assets: [asset] },
  { failures: { 'publish:before': 1 } },
);
await assert.rejects(convergeRelease(publishBeforeMutation, contract), /publish failed/u);
await convergeRelease(publishBeforeMutation, contract);
assert.deepEqual(publishBeforeMutation.calls, ['publish', 'publish']);

const publishResponseLoss = recoveryDriver(
  { ...draft, assets: [asset] },
  { failures: { 'publish:after': 1 } },
);
await assert.rejects(convergeRelease(publishResponseLoss, contract), /publish failed/u);
await convergeRelease(publishResponseLoss, contract);
assert.deepEqual(publishResponseLoss.calls, ['publish']);

const delayedDigest = recoveryDriver(
  { ...draft, assets: [{ ...asset, digest: null }] },
  { digestReadyAfterWait: 3 },
);
await assert.rejects(convergeRelease(delayedDigest, contract, 2), /did not converge/u);
assert.equal(delayedDigest.fetches, 3);
await convergeRelease(delayedDigest, contract);
assert.deepEqual(delayedDigest.calls, ['wait', 'wait', 'wait', 'publish']);

const completed = recoveryDriver({
  ...draft,
  draft: false,
  immutable: true,
  assets: [asset],
});
await convergeRelease(completed, contract);
assert.deepEqual(completed.calls, []);

const publishedConflict = recoveryDriver({
  ...draft,
  draft: false,
  immutable: true,
  body: 'wrong',
  assets: [asset],
});
await assert.rejects(convergeRelease(publishedConflict, contract), /does not match/u);
assert.deepEqual(publishedConflict.calls, []);

process.stdout.write('Release draft recovery contract: passed\n');
