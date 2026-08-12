// node test.mjs   (needs GH_TOKEN: the release-gate cases hit the real API)
import assert from 'node:assert/strict';
import { parseDeclarations } from './src/declarations.mjs';
import { classify } from './src/ci.mjs';
import { resolveStatus } from './build.mjs';
import { getPr } from './src/github.mjs';

let pass = 0;
const t = async (name, fn) => {
  try {
    await fn();
    pass++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`FAIL  ${name}\n      ${e.message}`);
    process.exitCode = 1;
  }
};

console.log('declaration parsing');
await t('same-repo', () => {
  const [d] = parseDeclarations('Depends on #504', 'o/r');
  assert.deepEqual([d.repo, d.number, d.needsRelease, d.crossRepo], ['o/r', 504, false, false]);
});
await t('cross-repo', () => {
  const [d] = parseDeclarations('Depends on snapshot-labs/snapshot.js#1225', 'o/r');
  assert.deepEqual([d.repo, d.number, d.crossRepo, d.needsRelease], [
    'snapshot-labs/snapshot.js', 1225, true, false
  ]);
});
await t('release-gated', () => {
  const [d] = parseDeclarations('Depends on release of snapshot-labs/snapshot.js#1225', 'o/r');
  assert.equal(d.needsRelease, true);
  assert.equal(d.crossRepo, true);
});
await t('reason is captured', () => {
  const [d] = parseDeclarations('Depends on #504 — because reasons', 'o/r');
  assert.equal(d.reason, 'because reasons');
});
await t('bullet form', () => {
  assert.equal(parseDeclarations('- Depends on #7', 'o/r').length, 1);
});
await t('NEGATIVE: blockquote declares nothing', () => {
  assert.deepEqual(parseDeclarations('> Depends on #504', 'o/r'), []);
});
await t('NEGATIVE: fenced code declares nothing', () => {
  assert.deepEqual(parseDeclarations('```\nDepends on #504\n```', 'o/r'), []);
});
await t('NEGATIVE: mid-sentence prose declares nothing', () => {
  assert.deepEqual(parseDeclarations('This one depends on #504 landing first.', 'o/r'), []);
});
await t('NEGATIVE: a bare cross-reference declares nothing', () => {
  assert.deepEqual(parseDeclarations('See #504 and snapshot-labs/stamp#12.', 'o/r'), []);
});
await t('dedupe keeps the release-gated variant', () => {
  const d = parseDeclarations('Depends on o/r#1\nDepends on release of o/r#1', 'o/r');
  assert.equal(d.length, 1);
  assert.equal(d[0].needsRelease, true);
});

console.log('CI attribution');
const chk = (name, conclusion) => ({ name, status: 'completed', conclusion });
await t('base red on the same check -> base-red', () => {
  assert.equal(classify([chk('Test', 'failure')], [chk('Test', 'failure')]).state, 'base-red');
});
await t('base green on the same check -> own-red', () => {
  assert.equal(classify([chk('Test', 'failure')], [chk('Test', 'success')]).state, 'own-red');
});
await t('check absent from base -> own-red', () => {
  assert.equal(classify([chk('Test', 'failure')], []).state, 'own-red');
});
await t('one of each -> mixed', () => {
  const r = classify(
    [chk('Test', 'failure'), chk('Lint', 'failure')],
    [chk('Test', 'failure'), chk('Lint', 'success')]
  );
  assert.equal(r.state, 'mixed');
  assert.deepEqual(r.ownFailures.map(f => f.name), ['Lint']);
});
await t('all green -> green', () => {
  assert.equal(classify([chk('Test', 'success')], []).state, 'green');
});
await t('still running -> pending', () => {
  assert.equal(classify([{ name: 'Test', status: 'in_progress' }], []).state, 'pending');
});

if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN) {
  console.log('release gating (live API)');
  const RJS = 'snapshot-labs/snapshot.js';
  await t('open PR is not satisfied', async () => {
    const r = await resolveStatus({ repo: RJS, needsRelease: true }, await getPr(RJS, 1225));
    assert.equal(r.satisfied, false);
    assert.equal(r.status, 'open');
  });
  await t('merged BEFORE a release -> satisfied, names the release', async () => {
    const r = await resolveStatus({ repo: RJS, needsRelease: true }, await getPr(RJS, 1223));
    assert.equal(r.satisfied, true);
    assert.match(r.status, /^released in v/);
  });
  await t('merged AFTER the last release -> merged, awaiting release', async () => {
    const r = await resolveStatus({ repo: RJS, needsRelease: true }, await getPr(RJS, 1222));
    assert.equal(r.satisfied, false);
    assert.equal(r.status, 'merged, awaiting release');
  });
  await t('same PR without the release gate IS satisfied by the merge', async () => {
    const r = await resolveStatus({ repo: RJS, needsRelease: false }, await getPr(RJS, 1222));
    assert.equal(r.satisfied, true);
    assert.equal(r.status, 'merged');
  });
} else {
  console.log('release gating (live API)  SKIPPED - no GH_TOKEN');
}

console.log(`\n${pass} passed${process.exitCode ? ', SOME FAILED' : ''}`);
