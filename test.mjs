// node test.mjs   (needs GH_TOKEN: the release-gate cases hit the real API)
import assert from 'node:assert/strict';
import { parseDeclarations } from './src/declarations.mjs';
import { classify } from './src/ci.mjs';
import { accountWithheld, buildGroups, decorateEdge, isMineFor, resolveStatus } from './build.mjs';
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

console.log('roots are mine');
const mine = isMineFor('tony8713');
const pr = (number, author, deps = []) => ({
  repo: 'snapshot-labs/sx-monorepo',
  number,
  author,
  deps: deps.map(d => ({
    repo: 'snapshot-labs/sx-monorepo',
    number: d,
    crossRepo: false,
    satisfied: false
  }))
});

await t('a PR by another author is never a root', () => {
  // The shape of today's data: #2222 is mine and sits on wa0x6e's #2219.
  const g = buildGroups([pr(2222, 'tony8713', [2219]), pr(2219, 'wa0x6e')], mine);
  assert.deepEqual(g[0].roots, [2222]);
  assert.deepEqual(g.pruned, ['snapshot-labs/sx-monorepo#2219']);
});
await t('...and it is not a node either, so it cannot head a subtree', () => {
  const g = buildGroups([pr(2222, 'tony8713', [2219]), pr(2219, 'wa0x6e')], mine);
  assert.equal(g[0].nodes.has(2219), false);
  assert.equal(g[0].count, 1);
});
await t('the dependency on it survives -- it is not filtered away', () => {
  const p = pr(2222, 'tony8713', [2219]);
  buildGroups([p, pr(2219, 'wa0x6e')], mine);
  assert.equal(p.deps.length, 1);
  assert.equal(p.deps[0].number, 2219);
});
await t('a foreign PR nothing of mine depends on is pruned entirely', () => {
  const g = buildGroups([pr(1, 'tony8713'), pr(999, 'someone-else')], mine);
  assert.deepEqual(g[0].roots, [1]);
  assert.deepEqual(g.pruned, ['snapshot-labs/sx-monorepo#999']);
});
await t('my own stack still nests: #491 under #504', () => {
  const stamp = n => ({ ...pr(n, 'tony8713'), repo: 'snapshot-labs/stamp' });
  const p491 = { ...stamp(491), deps: [{ repo: 'snapshot-labs/stamp', number: 504, crossRepo: false, satisfied: false }] };
  const g = buildGroups([p491, stamp(504), stamp(457)], mine);
  assert.deepEqual(g[0].roots, [457, 504]);
  assert.deepEqual(g[0].nodes.get(504).children, [491]);
});
await t('case-insensitive author match', () => {
  assert.equal(isMineFor('tony8713')('Tony8713'), true);
  assert.equal(isMineFor('tony8713')(null), false);
});

console.log('edge authorship marking');
await t('another author is flagged foreign', () => {
  assert.equal(decorateEdge({ author: 'wa0x6e' }, mine, false).foreign, true);
});
await t('my own PR is not flagged foreign', () => {
  assert.equal(decorateEdge({ author: 'tony8713' }, mine, false).foreign, false);
});
await t('NEGATIVE: an unreadable target is not accused of being someone else', () => {
  assert.equal(decorateEdge({ author: null }, mine, false).foreign, false);
});
await t('a private target keeps its link but loses title and author', () => {
  const e = decorateEdge({ author: 'wa0x6e', title: 'secret', targetPrivate: true }, mine, false);
  assert.equal(e.title, null);
  assert.equal(e.author, null);
  assert.equal(e.hidden, true);
});

console.log('withheld accounting');
const wh = (repo, number, author) => ({ repo, number, author, private: true });
await t('withheld PRs of mine are counted, and none blocks anything', () => {
  const r = accountWithheld(
    [wh('snapshot-labs/laser', 86, 'tony8713'), wh('snapshot-labs/nickai-app-fork', 8, 'tony8713')],
    [pr(2222, 'tony8713', [2219])],
    mine
  );
  assert.deepEqual([r.count, r.referenced, r.blocking], [2, 0, 0]);
});
await t('a withheld PR that blocks a visible one is counted as blocking', () => {
  const dependent = {
    repo: 'snapshot-labs/stamp',
    number: 491,
    author: 'tony8713',
    deps: [{ repo: 'snapshot-labs/laser', number: 86, crossRepo: true, satisfied: false }]
  };
  const r = accountWithheld([wh('snapshot-labs/laser', 86, 'tony8713')], [dependent], mine);
  assert.deepEqual([r.count, r.referenced, r.blocking], [1, 1, 1]);
});
await t('a withheld PR by another author that nothing depends on is NOT counted', () => {
  // It would not be rendered even if the repo were public, so calling it
  // "withheld" would overstate what privacy is hiding.
  const r = accountWithheld([wh('snapshot-labs/laser', 90, 'someone-else')], [pr(1, 'tony8713')], mine);
  assert.equal(r.count, 0);
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
