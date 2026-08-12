// node test.mjs   (needs GH_TOKEN: the release-gate cases hit the real API)
import assert from 'node:assert/strict';
import { parseDeclarations } from './src/declarations.mjs';
import { classify } from './src/ci.mjs';
import { accountWithheld, buildGroups, decorateEdge, isMineFor, resolveStatus } from './build.mjs';
import { render } from './src/render.mjs';
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

// buildGroups now returns node OBJECTS -- roots are nodes, children are nodes --
// because the inverted tree needs per-copy state (which edge placed a node,
// whether it is a repeat) that a bare number cannot carry.
const nums = roots => roots.map(r => r.number);
const kids = n => n.children.map(c => c.key);
const find = (n, key) => (n.key === key ? n : n.children.map(c => find(c, key)).find(Boolean));

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
  assert.deepEqual(nums(g[0].roots), [2222]);
  assert.deepEqual(g.pruned, ['snapshot-labs/sx-monorepo#2219']);
});
await t('...it is a marked LEAF beneath mine, and counts as none of my PRs', () => {
  // Inverted, a prerequisite is a child, so #2219 IS drawn -- underneath
  // #2222, flagged as somebody else's. What it must never be is a root.
  // The edge carries what decorateEdge() puts on it in the real build.
  const p2222 = pr(2222, 'tony8713', [2219]);
  Object.assign(p2222.deps[0], { kind: 'stack', author: 'wa0x6e', foreign: true });
  const g = buildGroups([p2222, pr(2219, 'wa0x6e')], mine);
  const child = g[0].roots[0].children[0];
  assert.equal(child.number, 2219);
  assert.equal(child.kind, 'dep');
  assert.equal(child.foreign, true);
  assert.equal(child.children.length, 0, 'a foreign leaf heads no subtree');
  assert.equal(g[0].count, 1, 'only #2222 counts as one of mine');
});
await t('the dependency on it survives -- it is not filtered away', () => {
  const p = pr(2222, 'tony8713', [2219]);
  buildGroups([p, pr(2219, 'wa0x6e')], mine);
  assert.equal(p.deps.length, 1);
  assert.equal(p.deps[0].number, 2219);
});
await t('a foreign PR nothing of mine depends on is pruned entirely', () => {
  const g = buildGroups([pr(1, 'tony8713'), pr(999, 'someone-else')], mine);
  assert.deepEqual(nums(g[0].roots), [1]);
  assert.deepEqual(g.pruned, ['snapshot-labs/sx-monorepo#999']);
});
await t('INVERTED: my own stack nests #504 under #491, not the other way round', () => {
  // This is the change. #491 needs #504, so #504 is drawn BENEATH #491 and
  // merges first; #491 is the root because nothing else waits on it.
  const stamp = n => ({ ...pr(n, 'tony8713'), repo: 'snapshot-labs/stamp' });
  const p491 = { ...stamp(491), deps: [{ repo: 'snapshot-labs/stamp', number: 504, crossRepo: false, satisfied: false }] };
  const g = buildGroups([p491, stamp(504), stamp(457)], mine);
  assert.deepEqual(nums(g[0].roots), [457, 491], '#504 is no longer a root');
  assert.deepEqual(kids(g[0].roots[1]), ['snapshot-labs/stamp#504']);
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


console.log('inverted tree: prerequisites are CHILDREN');
const S = 'snapshot-labs/stamp';
const sp = (number, deps = []) => ({
  repo: S,
  number,
  title: `pr ${number}`,
  url: `https://github.com/${S}/pull/${number}`,
  author: 'tony8713',
  draft: false,
  ci: { state: 'green', ownFailures: [], baseFailures: [], pending: [], total: 0, passed: 0 },
  deps
});
const edge = (repo, number, over = {}) => ({
  kind: 'implicit',
  repo,
  number,
  url: `https://github.com/${repo}/pull/${number}`,
  title: `pr ${number}`,
  author: 'tony8713',
  crossRepo: false,
  needsRelease: false,
  reason: null,
  satisfied: false,
  status: 'open',
  foreign: false,
  ...over
});
const page = groups =>
  render({
    groups,
    author: 'tony8713',
    org: 'snapshot-labs',
    generatedAt: '2026-01-01T00:00:00Z',
    withheld: { count: 0, referenced: 0, blocking: 0 },
    total: 2
  });

await t('two INDEPENDENT prerequisites become siblings, so no edge is dropped', () => {
  // The reason for inverting: as ancestors, #491 would need two parents.
  const [g] = buildGroups([
    sp(491, [edge(S, 504), edge('snapshot-labs/snapshot.js', 1225, { crossRepo: true, needsRelease: true })]),
    sp(504)
  ]);
  assert.deepEqual(nums(g.roots), [491]);
  assert.deepEqual(kids(g.roots[0]), [`${S}#504`, 'snapshot-labs/snapshot.js#1225']);
});
await t('cross-repo prerequisites sort after same-repo ones', () => {
  const [g] = buildGroups([
    sp(491, [edge('snapshot-labs/snapshot.js', 1225, { crossRepo: true }), edge(S, 504)]),
    sp(504)
  ]);
  assert.deepEqual(kids(g.roots[0]), [`${S}#504`, 'snapshot-labs/snapshot.js#1225']);
});
await t('a cross-repo prerequisite is a leaf, not expanded into this repo', () => {
  const groups = buildGroups([
    { ...sp(1225), repo: 'snapshot-labs/snapshot.js', deps: [edge('snapshot-labs/snapshot.js', 1200)] },
    { ...sp(1200), repo: 'snapshot-labs/snapshot.js' },
    sp(491, [edge('snapshot-labs/snapshot.js', 1225, { crossRepo: true })])
  ]);
  const stamp = groups.find(g => g.repo === S);
  assert.deepEqual(stamp.roots[0].children[0].children, [], 'the leaf carries no subtree');
});

console.log('the caveat: inverting MOVES duplication, so repeats are marked');
await t('a PR needed by two of mine is drawn under both, both copies labelled', () => {
  const [g] = buildGroups([sp(1, [edge(S, 3)]), sp(2, [edge(S, 3)]), sp(3)]);
  assert.deepEqual(nums(g.roots), [1, 2], '#3 is nobody\'s root');
  const a = find(g.roots[0], `${S}#3`);
  const b = find(g.roots[1], `${S}#3`);
  assert.ok(a && b, 'drawn twice');
  assert.equal(a.repeat.total, 2);
  // each copy points at where the OTHER copy is
  assert.deepEqual(a.repeat.others, ['under stamp#2']);
  assert.deepEqual(b.repeat.others, ['under stamp#1']);
  assert.equal(g.repeats, 2);
});
await t('NEGATIVE: a PR drawn once carries no repeat note', () => {
  const [g] = buildGroups([sp(491, [edge(S, 504)]), sp(504)]);
  assert.equal(find(g.roots[0], `${S}#504`).repeat, undefined);
});
await t('mine in another repo: a root there AND a leaf here, both marked', () => {
  const groups = buildGroups([
    { ...sp(1225), repo: 'snapshot-labs/snapshot.js' },
    sp(491, [edge('snapshot-labs/snapshot.js', 1225, { crossRepo: true, needsRelease: true })])
  ]);
  const js = groups.find(g => g.repo === 'snapshot-labs/snapshot.js');
  const stamp = groups.find(g => g.repo === S);
  assert.deepEqual(js.roots[0].repeat.others, ['under stamp#491']);
  assert.deepEqual(find(stamp.roots[0], 'snapshot-labs/snapshot.js#1225').repeat.others, [
    'at the top of snapshot.js'
  ]);
});

console.log('degenerate shapes');
await t('a dependency cycle stops and is flagged instead of recursing forever', () => {
  const a = sp(1, [edge(S, 2)]);
  const b = sp(2, [edge(S, 3)]);
  const c = sp(3, [edge(S, 2)]);
  const [g] = buildGroups([a, b, c]);
  const deep = find(g.roots[0], `${S}#3`);
  assert.ok(deep, '#3 is reached');
  assert.equal(find(deep, `${S}#2`).cycle, true);
  assert.deepEqual(find(deep, `${S}#2`).children, []);
});

console.log('the page says which way it points');
await t('direction is stated in the title, the heading and on every branch', () => {
  const html = page(buildGroups([sp(491, [edge(S, 504)]), sp(504)]));
  assert.match(html, /<title>Merge from the leaves up/);
  assert.match(html, /<h1>Open PRs — merge from the leaves up<\/h1>/);
  assert.match(html, /children are its prerequisites/);
  assert.match(html, /class="downto"/, 'every branch carries a direction label');
  assert.match(html, /merge this first/);
  assert.match(html, /read upward from the leaves/);
});
await t('#504 is rendered inside #491\'s subtree, not beside it', () => {
  const html = page(buildGroups([sp(491, [edge(S, 504)]), sp(504)]));
  const i491 = html.indexOf('>#491<');
  const idown = html.indexOf('class="downto"', i491);
  const i504 = html.indexOf('>#504<', i491);
  assert.ok(i491 < idown && idown < i504, '#504 comes after #491 and after the label');
});
await t("somebody else's PR is badged as such in the HTML", () => {
  const html = page(
    buildGroups([
      { ...sp(2222), repo: 'snapshot-labs/sx-monorepo', deps: [edge('snapshot-labs/sx-monorepo', 2219, { kind: 'stack', author: 'wa0x6e', foreign: true })] }
    ])
  );
  assert.match(html, /not yours · @wa0x6e/);
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
