// node test.mjs   (needs GH_TOKEN: the release-gate cases hit the real API)
import assert from 'node:assert/strict';
import { parseDeclarations } from './src/declarations.mjs';
import { classify } from './src/ci.mjs';
import {
  accountWithheld,
  buildGraph,
  decorateEdge,
  duplicateNodes,
  groupNodes,
  isMineFor,
  resolveStatus
} from './build.mjs';
import { columnLabel, layoutGraph, NODE_H, NODE_W, rankCensus, RANK_GAP } from './src/graph.mjs';
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

// buildGraph returns nodes and edges, not a nested forest: `needs` are the edges
// arriving from a node's prerequisites, `neededBy` the edges leaving it toward
// the PRs that wait on it. A node is reachable by its key, once, from anywhere.
const at = (graph, key) => graph.byKey.get(key);
const needs = n => n.needs.map(e => e.from.key);
const neededBy = n => n.neededBy.map(e => e.to.key);
const copies = (graph, key) => graph.nodes.filter(n => n.key === key).length;
const occurrences = (haystack, needle) => haystack.split(needle).length - 1;

console.log('only my PRs are listed as mine');
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

await t('a PR by another author is never listed as one of mine', () => {
  // The shape of today's data: #2222 is mine and sits on wa0x6e's #2219.
  const g = buildGraph([pr(2222, 'tony8713', [2219]), pr(2219, 'wa0x6e')], mine);
  const [group] = groupNodes(g);
  assert.deepEqual(group.mine.map(n => n.number), [2222]);
  assert.deepEqual(group.referenced.map(n => n.number), [2219]);
  assert.deepEqual(g.pruned, ['snapshot-labs/sx-monorepo#2219']);
});
await t('...it is the TARGET of my edge, marked, and waits on nothing itself', () => {
  const p2222 = pr(2222, 'tony8713', [2219]);
  Object.assign(p2222.deps[0], { kind: 'stack', author: 'wa0x6e', foreign: true });
  const g = buildGraph([p2222, pr(2219, 'wa0x6e')], mine);
  const n = at(g, 'snapshot-labs/sx-monorepo#2219');
  assert.equal(n.kind, 'dep');
  assert.equal(n.foreign, true);
  assert.deepEqual(neededBy(n), ['snapshot-labs/sx-monorepo#2222']);
  assert.deepEqual(needs(n), [], 'a referenced PR heads no chain of its own');
  assert.equal(groupNodes(g)[0].count, 1, 'only #2222 counts as one of mine');
});
await t('the dependency on it survives -- it is not filtered away', () => {
  const p = pr(2222, 'tony8713', [2219]);
  const g = buildGraph([p, pr(2219, 'wa0x6e')], mine);
  assert.equal(p.deps.length, 1);
  assert.deepEqual(needs(at(g, 'snapshot-labs/sx-monorepo#2222')), [
    'snapshot-labs/sx-monorepo#2219'
  ]);
});
await t('a foreign PR nothing of mine depends on is absent from the graph entirely', () => {
  const g = buildGraph([pr(1, 'tony8713'), pr(999, 'someone-else')], mine);
  assert.deepEqual(g.nodes.map(n => n.number), [1]);
  assert.equal(at(g, 'snapshot-labs/sx-monorepo#999'), undefined);
  assert.deepEqual(g.pruned, ['snapshot-labs/sx-monorepo#999']);
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

const S = 'snapshot-labs/stamp';
const JS = 'snapshot-labs/snapshot.js';
const sp = (number, deps = [], repo = S) => ({
  repo,
  number,
  title: `pr ${number}`,
  url: `https://github.com/${repo}/pull/${number}`,
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
const page = graph =>
  render({
    graph,
    groups: groupNodes(graph),
    author: 'tony8713',
    org: 'snapshot-labs',
    generatedAt: '2026-01-01T00:00:00Z',
    withheld: { count: 0, referenced: 0, blocking: 0 },
    total: graph.nodes.filter(n => n.kind === 'own').length
  });

console.log('ONE node per PR, however many edges it is on');
await t('a PR that two of mine need is ONE node with two edges leaving it', () => {
  // This is the rework. In the nested list this PR had to be drawn twice, once
  // under each dependent, with a footnote on each copy naming the other.
  const g = buildGraph([sp(1, [edge(S, 3)]), sp(2, [edge(S, 3)]), sp(3)]);
  assert.equal(copies(g, `${S}#3`), 1, 'exactly one node for #3');
  assert.deepEqual(neededBy(at(g, `${S}#3`)), [`${S}#1`, `${S}#2`], 'two edges leave it');
  assert.deepEqual(duplicateNodes(g), []);
});
await t('...and it is drawn exactly once in the HTML, with no "also drawn" footnote', () => {
  const html = page(buildGraph([sp(1, [edge(S, 3)]), sp(2, [edge(S, 3)]), sp(3)]));
  assert.equal(occurrences(html, '>#3</a>'), 3, 'once as itself, once on each edge that names it');
  assert.equal(occurrences(html, 'class="num" href="https://github.com/snapshot-labs/stamp/pull/3">#3</a>'), 3);
  assert.doesNotMatch(html, /Also drawn/, 'no duplicate-copy footnote survives');
  assert.doesNotMatch(html, /not \d+ pieces of work/);
  assert.doesNotMatch(html, /class="note repeat"/);
});
await t('two INDEPENDENT prerequisites both point at the same dependent, no edge dropped', () => {
  const g = buildGraph([
    sp(491, [edge(S, 504), edge(JS, 1225, { crossRepo: true, needsRelease: true })]),
    sp(504)
  ]);
  assert.deepEqual(needs(at(g, `${S}#491`)), [`${S}#504`, `${JS}#1225`]);
  assert.equal(g.edges.length, 2);
});
await t('cross-repo prerequisites sort after same-repo ones', () => {
  const g = buildGraph([
    sp(491, [edge(JS, 1225, { crossRepo: true }), edge(S, 504)]),
    sp(504)
  ]);
  assert.deepEqual(needs(at(g, `${S}#491`)), [`${S}#504`, `${JS}#1225`]);
});
await t('a cross-repo prerequisite of mine is the SAME node as its own entry', () => {
  // The exact case that forced the rework: snapshot.js#1225 is one of mine AND a
  // prerequisite of stamp#491. One node, filed under its own repo, with an edge
  // that crosses the repo boundary.
  const g = buildGraph([
    sp(1225, [], JS),
    sp(491, [edge(JS, 1225, { crossRepo: true, needsRelease: true })])
  ]);
  assert.equal(copies(g, `${JS}#1225`), 1);
  const n = at(g, `${JS}#1225`);
  assert.equal(n.kind, 'own', 'it is my PR, not a leaf copy of it');
  assert.deepEqual(neededBy(n), [`${S}#491`]);
  const js = groupNodes(g).find(gr => gr.repo === JS);
  assert.deepEqual(js.mine.map(x => x.number), [1225]);
  assert.deepEqual(js.referenced, [], 'not also a referenced copy');
});
await t('...and the HTML has one row for it, plus a LINK to it on the edge', () => {
  const html = page(
    buildGraph([sp(1225, [], JS), sp(491, [edge(JS, 1225, { crossRepo: true, needsRelease: true })])])
  );
  assert.equal(occurrences(html, '>#1225</a>'), 1, 'one row of its own');
  assert.equal(occurrences(html, '>snapshot-labs/snapshot.js#1225</a>'), 1, 'named once on the edge');
  assert.match(html, /release-gated/);
});
await t('every node in the graph appears exactly once as a row of its own', () => {
  const g = buildGraph([sp(1, [edge(S, 3)]), sp(2, [edge(S, 3)]), sp(3), sp(1225, [], JS)]);
  const html = page(g);
  for (const n of g.nodes) {
    assert.equal(
      occurrences(html, `<div class="line1"><a class="num" href="${n.url}">#${n.number}</a>`),
      1,
      `${n.key} has one row`
    );
  }
});

console.log('rank = dependency depth');
await t('rank 0 is every PR with no prerequisites', () => {
  const g = buildGraph([sp(491, [edge(S, 504)]), sp(504), sp(457)]);
  assert.equal(at(g, `${S}#504`).rank, 0);
  assert.equal(at(g, `${S}#457`).rank, 0);
  assert.equal(at(g, `${S}#491`).rank, 1);
});
await t('rank is the LONGEST prerequisite chain, not the shortest', () => {
  // #1 needs #2 and #3; #2 needs #3. #1 must not be drawn level with #2.
  const g = buildGraph([sp(1, [edge(S, 2), edge(S, 3)]), sp(2, [edge(S, 3)]), sp(3)]);
  assert.deepEqual(
    [at(g, `${S}#3`).rank, at(g, `${S}#2`).rank, at(g, `${S}#1`).rank],
    [0, 1, 2]
  );
});
await t('a dependency cycle is broken and flagged instead of recursing forever', () => {
  const g = buildGraph([sp(1, [edge(S, 2)]), sp(2, [edge(S, 3)]), sp(3, [edge(S, 2)])]);
  const back = g.edges.filter(e => e.cycle);
  assert.equal(back.length, 1, 'exactly one edge is cut to break the cycle');
  assert.equal(back[0].from.key, `${S}#2`);
  assert.equal(back[0].to.key, `${S}#3`);
  assert.ok(g.nodes.every(n => typeof n.rank === 'number'), 'ranking terminated');
  assert.match(page(g), /in a dependency cycle/);
});
await t('a cut edge is still LISTED, so the declaration is not silently dropped', () => {
  const html = page(buildGraph([sp(1, [edge(S, 2)]), sp(2, [edge(S, 3)]), sp(3, [edge(S, 2)])]));
  assert.match(html, /cycle — not drawn/);
});

console.log('layered layout, left to right');
await t('rank 0 sits to the LEFT of rank 1 on the canvas', () => {
  const g = buildGraph([sp(491, [edge(S, 504)]), sp(504)]);
  g.layout = layoutGraph(g);
  assert.ok(
    at(g, `${S}#504`).x + NODE_W <= at(g, `${S}#491`).x,
    'the prerequisite is drawn further left, so merge order reads rightward'
  );
  assert.equal(at(g, `${S}#504`).col, 0);
  assert.equal(at(g, `${S}#491`).col, 1);
});
await t('one rank is one column: every member shares an x, exactly', () => {
  const g = buildGraph([sp(491, [edge(S, 504)]), sp(504), sp(457), sp(1225, [], JS)]);
  const layout = layoutGraph(g);
  const xs = new Map();
  for (const n of g.nodes) {
    if (!xs.has(n.rank)) xs.set(n.rank, new Set());
    xs.get(n.rank).add(n.x);
  }
  for (const [rank, set] of xs) assert.equal(set.size, 1, `rank ${rank} occupies one column`);
  assert.equal(xs.get(0).values().next().value, layout.left, 'rank 0 is at the left edge');
  assert.equal(
    xs.get(1).values().next().value,
    layout.left + NODE_W + RANK_GAP,
    'rank 1 is one column to its right'
  );
});
await t('a rank of any size is ONE column and is never folded into two', () => {
  // The folded shape is the thing to avoid: a second column reads as a second
  // rank, i.e. as an order between PRs that have none.
  const g = buildGraph(Array.from({ length: 20 }, (_, i) => sp(i + 1)));
  const layout = layoutGraph(g);
  assert.equal(layout.maxRank, 0);
  assert.equal(layout.columns.length, 1);
  assert.equal(new Set(g.nodes.map(n => n.x)).size, 1, 'twenty PRs, one column');
  assert.equal(new Set(g.nodes.map(n => n.y)).size, 20, 'stacked, none overlapping');
  assert.equal(layout.width, layout.left + NODE_W + 10, 'one rank deep is one column wide');
  const sorted = [...g.nodes].sort((a, b) => a.y - b.y);
  for (let i = 1; i < sorted.length; i++) {
    assert.ok(sorted[i].y >= sorted[i - 1].y + NODE_H, 'no two boxes overlap');
  }
});
await t('a deep graph gets WIDE rather than scaled down', () => {
  const chain = [sp(1)];
  for (let i = 2; i <= 8; i++) chain.push(sp(i, [edge(S, i - 1)]));
  const g = buildGraph(chain);
  const layout = layoutGraph(g);
  assert.equal(layout.maxRank, 7);
  assert.equal(layout.width, 10 + 8 * NODE_W + 7 * RANK_GAP + 10);
  assert.ok(layout.width > 940, 'wider than the text column, so it scrolls');
  const css = page(g);
  assert.match(css, /\.gwrap\{overflow-x:auto/, 'the canvas scrolls sideways');
  assert.match(css, new RegExp(`svg\\.depgraph\\{[^}]*width:${layout.width}px`));
  assert.match(css, /max-width:none/, 'and is never shrunk to fit');
});
await t('every arrow leaves the RIGHT edge of its tail and enters the LEFT edge of its head', () => {
  const g = buildGraph([sp(491, [edge(S, 504)]), sp(504)]);
  g.layout = layoutGraph(g);
  const html = page(g);
  const from = at(g, `${S}#504`);
  const to = at(g, `${S}#491`);
  const d = html.match(/marker-end="url\(#dep-arrow\)" d="M(\S+) (\S+) C [^"]*?(\S+) (\S+)"/);
  assert.ok(d, 'the edge path is drawn');
  const [sx, , tx] = [Number(d[1]), Number(d[2]), Number(d[3])];
  const ty = Number(d[4]);
  assert.ok(sx >= from.x + NODE_W, `starts at the tail's right edge (${sx})`);
  assert.ok(tx <= to.x, `ends at the head's left edge (${tx})`);
  assert.ok(sx < tx, 'and therefore points right');
  assert.equal(ty, to.cy, "and lands on the head's vertical centre");
});
await t('a shared prerequisite is centred beside the things that wait on it', () => {
  const g = buildGraph([
    sp(491, [edge(S, 504), edge(JS, 1225, { crossRepo: true })]),
    sp(504),
    sp(1225, [], JS)
  ]);
  g.layout = layoutGraph(g);
  const parent = at(g, `${S}#491`);
  const kids = [at(g, `${S}#504`), at(g, `${JS}#1225`)];
  const mid = (kids[0].cy + kids[1].cy) / 2;
  assert.ok(Math.abs(parent.cy - mid) <= 1, `${parent.cy} vs ${mid}`);
});
await t('one <g class="node"> per PR, and one arrow per drawn edge', () => {
  const g = buildGraph([sp(1, [edge(S, 3)]), sp(2, [edge(S, 3)]), sp(3)]);
  const html = page(g);
  assert.equal(occurrences(html, '<g class="node'), g.nodes.length);
  assert.equal(occurrences(html, 'marker-end="url(#dep-arrow)"'), g.edges.length);
});
await t('the nodes something waits on lead their column, nearest what needs them', () => {
  const many = Array.from({ length: 11 }, (_, i) => sp(i + 10));
  const g = buildGraph([...many, sp(1, [edge(S, 15)])]);
  layoutGraph(g);
  assert.equal(at(g, `${S}#15`).slot, 0, 'the prerequisite is at the top of its column');
});

// WITHIN a rank there is no order; BETWEEN ranks there is. The drawing used to
// leave that to a gap: ranks were stacked vertically and a wide rank wrapped onto
// extra rows, a wrapped row being the same shape as a rank, so twenty independent
// PRs at rank 0 read as four steps. The rotation makes the distinction
// categorical instead of measured -- same rank is the same COLUMN, and a
// different rank is a different column, with no wrapping to confuse the two.
// These pin it down at both ends.
console.log('same rank means NO order, and the page says so');

// The column a node is drawn in, found by geometry rather than by trusting the
// index -- which is what a reader does with their eyes.
const colOf = (L, n) => L.columns.find(c => n.x === c.x);

await t('no drawn edge ever joins two PRs of the same rank', () => {
  // The invariant the whole "same rank = no order" claim rests on.
  const g = buildGraph([
    sp(1, [edge(S, 2), edge(S, 3)]),
    sp(2, [edge(S, 3)]),
    sp(3),
    sp(4),
    sp(1225, [], JS)
  ]);
  for (const e of g.edges) {
    assert.notEqual(e.from.rank, e.to.rank, `${e.from.key} -> ${e.to.key} is within one rank`);
  }
  assert.deepEqual([...rankCensus(g).tangled], [], 'so no rank is tangled');
});
await t('two PRs at one rank never have an edge between them', () => {
  const g = buildGraph([sp(491, [edge(S, 504)]), sp(504), sp(457)]);
  const census = rankCensus(g);
  assert.deepEqual(census.counts, [2, 1]);
  assert.equal(census.unordered(0), true);
  for (const e of g.edges) assert.notEqual(e.from.rank, e.to.rank);
});
await t('twenty PRs at one rank get ONE rank label, not one per group of them', () => {
  // The reported defect, in its rotated form: nothing may split a rank into
  // parts that each look like a rank of their own.
  const html = page(buildGraph(Array.from({ length: 20 }, (_, i) => sp(i + 1))));
  assert.equal(occurrences(html, 'class="rk"'), 1, 'twenty PRs, ONE rank label');
  assert.equal(occurrences(html, 'class="colhead"'), 1, 'and ONE column header');
  assert.equal(occurrences(html, 'class="rknote"'), 1);
  assert.match(html, /<text class="rknote" [^>]*>20 PRs · any order<\/text>/);
});
await t('every member of a rank is in that rank\'s column, and a dependent is not', () => {
  const many = Array.from({ length: 12 }, (_, i) => sp(i + 10));
  const g = buildGraph([...many, sp(1, [edge(S, 15)])]);
  const L = layoutGraph(g);
  assert.equal(L.maxRank, 1);
  for (const m of many) {
    const c = colOf(L, at(g, `${S}#${m.number}`));
    assert.ok(c, `#${m.number} is inside a column`);
    assert.equal(c.rank, 0, `#${m.number} is in the rank-0 column wherever it stacked`);
  }
  assert.equal(colOf(L, at(g, `${S}#1`)).rank, 1, 'the dependent is in a DIFFERENT column');
});
await t('within a rank the separation is vertical; between ranks it is horizontal', () => {
  // Not a gap a reader has to measure: it is a different axis.
  const g = buildGraph([sp(1, [edge(S, 2)]), sp(2), sp(3), sp(4)]);
  const L = layoutGraph(g);
  const rank0 = g.nodes.filter(n => n.rank === 0);
  assert.equal(new Set(rank0.map(n => n.x)).size, 1, 'same rank: same x, different y');
  assert.equal(new Set(rank0.map(n => n.y)).size, rank0.length);
  const rank1 = g.nodes.filter(n => n.rank === 1);
  assert.notEqual(rank0[0].x, rank1[0].x, 'different rank: different x');
  assert.equal(occurrences(page(g), 'marker-end="url(#dep-arrow)"'), g.edges.length,
    'and the only arrows on the canvas are the dependency edges themselves');
});
await t('the note counts the PRs actually standing in the column', () => {
  const g = buildGraph(Array.from({ length: 7 }, (_, i) => sp(i + 1)));
  const L = layoutGraph(g);
  assert.equal(L.columns[0].note, '7 PRs · any order');
  assert.equal(L.columns[0].count, g.nodes.filter(n => colOf(L, n).rank === 0).length);
  // and the count in the words is the count in the geometry, not a constant
  assert.equal(columnLabel(0, 0, 3).note, '3 PRs · any order');
  assert.equal(columnLabel(0, 0, 1).note, '1 PR');
});
await t('a rank of one does not claim an order that is not there', () => {
  const g = buildGraph([sp(491, [edge(S, 504)]), sp(504)]);
  const L = layoutGraph(g);
  for (const c of L.columns) {
    assert.equal(c.count, 1);
    assert.equal(c.note, '1 PR');
  }
  const html = page(g);
  const notes = [...html.matchAll(/<text class="rknote[^"]*" [^>]*>([^<]*)<\/text>/g)].map(m => m[1]);
  assert.deepEqual(notes, ['1 PR', '1 PR'], 'no column claims an order that is not there');
  assert.doesNotMatch(html, /any order among/, 'and no row of the list claims it either');
});
await t('the column header states the count and that there is no order in it', () => {
  const g = buildGraph([sp(491, [edge(S, 504)]), sp(504), sp(457)]);
  const layout = layoutGraph(g);
  assert.deepEqual(layout.columns.map(c => c.label), ['MERGES FIRST', 'MERGES LAST']);
  assert.deepEqual(layout.columns.map(c => c.note), ['2 PRs · any order', '1 PR']);
  const html = page(g);
  assert.match(html, /<text class="rknote" [^>]*>2 PRs · any order<\/text>/);
});
await t('MERGES FIRST is at the left end of the canvas and MERGES LAST at the right', () => {
  const g = buildGraph([sp(491, [edge(S, 504)]), sp(504)]);
  const layout = layoutGraph(g);
  const first = layout.columns.find(c => c.label === 'MERGES FIRST');
  const last = layout.columns.find(c => c.label === 'MERGES LAST');
  assert.equal(first.x, layout.left, 'MERGES FIRST is flush with the left edge');
  assert.equal(last.x + last.width + 10, layout.width, 'MERGES LAST is flush with the right edge');
  assert.ok(first.x < last.x);
  // and in the drawing itself, in that order along the x axis
  const html = page(g);
  const xOf = label => Number(html.match(new RegExp(`<text class="rk" x="(\\d+)"[^>]*>${label}<`))[1]);
  assert.ok(xOf('MERGES FIRST') < xOf('MERGES LAST'));
});
await t('a middle column points at the column on its LEFT, not below it', () => {
  const g = buildGraph([sp(1, [edge(S, 2)]), sp(2, [edge(S, 3)]), sp(3)]);
  const layout = layoutGraph(g);
  assert.deepEqual(layout.columns.map(c => c.label), ['MERGES FIRST', 'THEN', 'MERGES LAST']);
  assert.equal(layout.columns[1].sub, 'after the column on its left');
});
await t('NEGATIVE: "any order" is not claimed for a rank a cut cycle edge lands in', () => {
  // Ranking cuts the edge that closes a cycle, and a cut edge contributes no
  // depth -- so it can leave both of its ends on one rank, where "any order"
  // would be a lie. The claim is checked against the edges, not assumed.
  assert.match(columnLabel(0, 0, 3, false).note, /3 PRs · a cycle is cut here/);
  assert.doesNotMatch(columnLabel(0, 0, 3, false).note, /any order/);
  const g = buildGraph([sp(1, [edge(S, 1)])]);
  assert.equal(rankCensus(g).unordered(0), false, 'a self-edge tangles its rank');
  const html = page(g);
  assert.doesNotMatch(html, /any order among/);
  assert.match(html, /rank 1 of 1 · a cycle sits inside it/);
  assert.match(html, /1 PR · a cycle is cut here/, 'and never "links two" about one PR');
});
console.log('the text fallback does not imply an order either');
await t('the list says outright that it is not a running order', () => {
  const html = page(buildGraph([sp(1, [edge(S, 2)]), sp(2), sp(3)]));
  assert.match(html, /The list below is not a running order\./);
  assert.match(html, /listed by number, not in merge order/);
  assert.match(html, /everything sharing one\s*rank is independent of everything else in that rank/);
  assert.match(html, /rank <em>n<\/em> is the\s*<em>n<\/em>th column from the left/);
});
await t('EVERY row carries its rank and how many PRs share it', () => {
  const g = buildGraph([sp(1, [edge(S, 2)]), sp(2), sp(3), sp(4)]);
  const html = page(g);
  // three at rank 0 (#2 #3 #4), one at rank 1 (#1)
  assert.equal(occurrences(html, 'rank 1 of 2 · any order among the 3 in it'), 3);
  assert.equal(occurrences(html, 'rank 2 of 2 · the only PR in it'), 1);
  assert.equal(
    occurrences(html, 'class="badge step"'),
    g.nodes.length + 2,
    'one per row, plus the two samples in the notice'
  );
});
await t("a referenced PR that is not mine keeps its owner badge AND gains its rank", () => {
  const p = sp(2222, [edge('snapshot-labs/sx-monorepo', 2219, { kind: 'stack', author: 'wa0x6e', foreign: true })], 'snapshot-labs/sx-monorepo');
  const html = page(buildGraph([p]));
  assert.match(html, /not yours · @wa0x6e/, 'the existing badge survives');
  assert.match(html, /rank 1 of 2 · the only PR in it/, 'and the referenced node is ranked too');
});
await t('the text form marks a tangled rank as tangled rather than as unordered', () => {
  const html = page(buildGraph([sp(1, [edge(S, 1)])]));
  assert.match(html, /rank 1 of 1 · a cycle sits inside it/);
  assert.doesNotMatch(html, /any order among/);
});
await t('NEGATIVE: the rank labelling describes, it never instructs', () => {
  // Same rule that governs sx#2251: the page states facts about the graph and
  // never tells anybody to merge anything.
  const html = page(buildGraph([...Array.from({ length: 12 }, (_, i) => sp(i + 1)), sp(2251, [edge(S, 1)], 'snapshot-labs/sx-monorepo')]));
  assert.doesNotMatch(html, /ready to merge|safe to merge|merge it now|merge now|go ahead and merge/i);
  assert.doesNotMatch(html, /you (can|should) merge/i);
  assert.match(html, /no prerequisites<\/span>/);
});
await t('...and it still says so when there is only one rank', () => {
  const html = page(buildGraph([sp(1), sp(2)]));
  assert.match(html, /rank 1 of 1 · any order among the 2 in it/);
  assert.match(html, /nothing waits on anything, so everything on this\s*page is independent/);
  assert.doesNotMatch(html, /rank 1 of 1<\/span> merges\s*before/);
});

console.log('the page says which way it points, and does it without a runtime');
await t('direction is stated in the title, the heading, the banner and the caption', () => {
  const html = page(buildGraph([sp(491, [edge(S, 504)]), sp(504)]));
  assert.match(html, /<title>PR dependency graph — merge left to right/);
  assert.match(html, /<h1>Open PRs — merge left to right<\/h1>/);
  assert.match(html, /Read the graph left to right\. A PR sits to the right of the things it needs\./);
  assert.match(html, /from a prerequisite rightward to the PR that waits on it/);
  assert.match(html, /an arrow runs from a prerequisite rightward to the PR that\s*waits on it/);
  assert.match(html, /one column per rank, earliest on the left/);
  assert.match(html, /merge the tail before the head/);
  assert.match(html, /<span class="k">left to right<\/span> merge order/);
  assert.match(html, /Merge order runs left to right/, 'and in the footer');
  assert.match(html, /a prerequisite sits to the left in the graph and merges before the PR that needs it/,
    'and under every repo heading');
  assert.match(html, /MERGES FIRST/);
  assert.match(html, /MERGES LAST/);
});
await t('NEGATIVE: nothing on the page still says the old bottom-up direction', () => {
  const html = page(buildGraph([sp(491, [edge(S, 504)]), sp(504)]));
  assert.doesNotMatch(html, /bottom-up|bottom up/i);
  assert.doesNotMatch(html, /sits above the things/i);
  assert.doesNotMatch(html, /the bottom rank|the top rank/i);
  assert.doesNotMatch(html, /rank below|rank above/i);
  assert.doesNotMatch(html, /merges? (from )?the bottom/i);
  assert.doesNotMatch(html, /arrow runs from a prerequisite up\b/i);
  assert.doesNotMatch(html, /something above needs/i);
});
await t('the no-order-within-a-column fact is stated everywhere the direction is', () => {
  const html = page(buildGraph([sp(491, [edge(S, 504)]), sp(504), sp(457)]));
  assert.match(html, /Order is the horizontal axis only\./, 'banner');
  assert.match(html, /Two PRs in the same column have\s*no order between them/, 'caption');
  assert.match(html, /<span class="k">same column<\/span> one rank — no order between them/, 'legend');
  assert.match(html, /2 PRs · any order/, 'column header in the drawing');
  assert.match(html, /any order among the 2 in it/, 'and on the rows of the text form');
  assert.match(html, /Only the horizontal axis carries order\./, 'and in the explainer');
  assert.match(html, /PRs sharing a\s*column have no order between them/, 'and in the footer');
});
await t('and on every single edge in the text form, not only in the banner', () => {
  const html = page(buildGraph([sp(491, [edge(S, 504)]), sp(504)]));
  assert.match(html, /needs first<\/span> <a class="num" href="[^"]*\/504">#504<\/a>/);
  assert.match(html, /class="dir">needed by<\/span> <a class="num" href="[^"]*\/491">#491<\/a>/);
});
await t('NO runtime dependency: no script tag, nothing loaded from anywhere', () => {
  const html = page(buildGraph([sp(491, [edge(S, 504)]), sp(504)]));
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /<(link|img|iframe|object|embed|use)\b/i);
  assert.doesNotMatch(html, /url\(\s*['"]?https?:/i, 'no CSS fetches anything either');
  // The only absolute URLs on the page are the PR links and the SVG namespace.
  // (The prose says the words "Mermaid" and "CDN"; the page does not load them.)
  const urls = [...html.matchAll(/https?:\/\/[^\s"'<)]+/g)].map(m => m[0]);
  assert.ok(
    urls.every(u => u.startsWith('https://github.com/') || u === 'http://www.w3.org/2000/svg'),
    urls.join(' ')
  );
});
await t('the SVG carries a text alternative, and the relationships are ALSO written out', () => {
  const html = page(buildGraph([sp(491, [edge(S, 504)]), sp(504)]));
  assert.match(html, /role="img" aria-labelledby="graph-title graph-desc"/);
  assert.match(html, /<title id="graph-title">Dependency graph: 2 pull requests, 1 dependency edge/);
  assert.match(html, /<desc id="graph-desc">Each pull request is drawn exactly once/);
  assert.match(html, /The graph reads left to right/, 'the text alternative states the direction');
  assert.match(html, /stacked in the same column are independent of one another/);
  assert.match(html, /written out under the repo headings below/);
  assert.match(html, /also written out in the per-repository list below this diagram/);
  // the text form stands on its own: the edge is stated in prose-free markup
  // that needs neither CSS nor SVG to be read
  assert.match(html, /<ul class="edges">/);
});
await t("somebody else's PR is badged as such in the HTML and in the SVG box", () => {
  const p = sp(2222, [edge('snapshot-labs/sx-monorepo', 2219, { kind: 'stack', author: 'wa0x6e', foreign: true })], 'snapshot-labs/sx-monorepo');
  const html = page(buildGraph([p]));
  assert.match(html, /not yours · @wa0x6e/);
  assert.match(html, /<tspan class="g">◇<\/tspan> @wa0x6e/);
  assert.match(html, /referenced only — drawn because something to its right needs it/);
});
await t('a PR with no prerequisites is described, never instructed', () => {
  // sx#2251 is titled "[DO NOT MERGE until migration is run]" and has no
  // prerequisites. "no prerequisites" is a fact; "ready to merge" would be advice.
  const html = page(buildGraph([sp(2251, [], 'snapshot-labs/sx-monorepo')]));
  assert.match(html, /no prerequisites<\/span>/);
  assert.doesNotMatch(html, /ready to merge|safe to merge|merge it now|merge now/i);
});
await t('CI attribution reaches the page, in words and not only in colour', () => {
  const red = sp(1453, [], 'snapshot-labs/score-api');
  red.ci = { state: 'own-red', ownFailures: [{ name: 'test (22) / Test' }], baseFailures: [], pending: [], total: 1, passed: 0, baseRef: 'master' };
  const base = sp(457);
  base.ci = { state: 'base-red', ownFailures: [], baseFailures: [{ name: 'Test' }], pending: [], total: 1, passed: 0, baseRef: 'master' };
  const html = page(buildGraph([red, base]));
  assert.match(html, /red on its own<\/span> <span class="dim">\(test \(22\) \/ Test\)/);
  assert.match(html, /red, but base is red too<\/span> <span class="dim">\(Test also failing on master\)/);
  assert.match(html, /<tspan class="g">✗<\/tspan> red on its own/);
  assert.match(html, /<tspan class="g">~<\/tspan> base is red too/);
});
await t('a private dependency target keeps its number and never its repo name', () => {
  const p = sp(491, [
    edge('snapshot-labs/a-private-repo', 86, {
      crossRepo: true,
      title: null,
      author: null,
      hidden: true
    })
  ]);
  const g = buildGraph([p]);
  const html = page(g);
  assert.doesNotMatch(html, /a-private-repo#86/, 'the repo name is not printed as a ref');
  assert.match(html, /private repo — details withheld/);
  assert.match(html, /private repos — names withheld/, 'it is grouped without naming the repo');
  assert.match(html, /<text class="ref" [^>]*>#86<\/text>/, 'the SVG box shows the number only');
});
await t('the withheld notice keeps its accounting', () => {
  const g = buildGraph([sp(491)]);
  const html = render({
    graph: g,
    groups: groupNodes(g),
    author: 'tony8713',
    org: 'snapshot-labs',
    generatedAt: '2026-01-01T00:00:00Z',
    withheld: { count: 2, referenced: 0, blocking: 0 },
    total: 1
  });
  assert.match(html, /<strong>2 PRs withheld\.<\/strong>/);
  assert.match(html, /Neither blocks anything on this page/);
  assert.match(html, /2 nodes that would have had no edges anyway, not a broken chain/);
  assert.match(html, /INCLUDE_PRIVATE=true/);
  assert.match(html, /does not pretend the work does not exist/);
});
await t('the explainer argues for the graph, and no longer for the tree', () => {
  const html = page(buildGraph([sp(491, [edge(S, 504)]), sp(504)]));
  assert.match(html, /<summary>Why this is a graph and not a tree<\/summary>/);
  assert.match(html, /one node, as many edges as the data has/);
  assert.doesNotMatch(html, /Inverted, <code>#491<\/code> has two/);
  assert.doesNotMatch(html, /inverting does not make the structure a tree/);
  assert.doesNotMatch(html, /moves where the duplication lands/);
  assert.doesNotMatch(html, /read upward from the leaves/);
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
