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
import { bandNote, layoutGraph, NODE_H, rankCensus } from './src/graph.mjs';
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

console.log('layered layout, bottom-up');
await t('rank 0 sits BELOW rank 1 on the canvas', () => {
  const g = buildGraph([sp(491, [edge(S, 504)]), sp(504)]);
  g.layout = layoutGraph(g);
  assert.ok(
    at(g, `${S}#504`).y > at(g, `${S}#491`).y + NODE_H,
    'the prerequisite is drawn lower down, so merge order reads upward'
  );
});
await t('a shared prerequisite is centred under the things that wait on it', () => {
  const g = buildGraph([
    sp(491, [edge(S, 504), edge(JS, 1225, { crossRepo: true })]),
    sp(504),
    sp(1225, [], JS)
  ]);
  g.layout = layoutGraph(g);
  const parent = at(g, `${S}#491`);
  const kids = [at(g, `${S}#504`), at(g, `${JS}#1225`)];
  const mid = (kids[0].cx + kids[1].cx) / 2;
  assert.ok(Math.abs(parent.cx - mid) <= 1, `${parent.cx} vs ${mid}`);
});
await t('one <g class="node"> per PR, and one arrow per drawn edge', () => {
  const g = buildGraph([sp(1, [edge(S, 3)]), sp(2, [edge(S, 3)]), sp(3)]);
  const html = page(g);
  assert.equal(occurrences(html, '<g class="node'), g.nodes.length);
  assert.equal(occurrences(html, 'marker-end="url(#dep-arrow)"'), g.edges.length);
});
await t('a rank wider than one row wraps instead of overflowing the canvas', () => {
  const g = buildGraph(Array.from({ length: 12 }, (_, i) => sp(i + 1)));
  const layout = layoutGraph(g);
  assert.equal(layout.maxRank, 0);
  assert.ok(new Set(g.nodes.map(n => n.row)).size === 3, 'twelve nodes, five per row, three rows');
  for (const n of g.nodes) {
    assert.ok(n.x >= layout.left, `${n.key} starts inside the canvas`);
    assert.ok(n.x + 150 <= layout.left + layout.contentW, `${n.key} ends inside the canvas`);
  }
});
await t('the nodes something waits on land on the row nearest the rank above', () => {
  const many = Array.from({ length: 11 }, (_, i) => sp(i + 10));
  const g = buildGraph([...many, sp(1, [edge(S, 15)])]);
  layoutGraph(g);
  assert.equal(at(g, `${S}#15`).row, 0, 'the prerequisite is on the top row of its rank');
});

// WITHIN a rank there is no order; BETWEEN ranks there is. The drawing used to
// say the opposite: a rank wider than five wrapped onto extra rows, a wrapped row
// is the same shape as a rank, and twenty independent PRs at rank 0 came out as
// four rows that read as four steps. These pin the distinction down at both ends
// -- a rank is one enclosed thing however many rows it takes, and the only thing
// that ever separates two of them is an explicit marked gap.
console.log('SAME RANK = NO ORDER; between ranks = order');

// The band a node is drawn inside, found by geometry rather than by trusting the
// index -- which is the thing a reader does with their eyes.
const bandOf = (L, n) => L.bands.find(b => n.y >= b.top && n.y + NODE_H <= b.top + b.height);

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

await t('a rank that wraps onto several rows is ONE band, not several', () => {
  const g = buildGraph(Array.from({ length: 12 }, (_, i) => sp(i + 1)));
  const L = layoutGraph(g);
  assert.equal(L.bands.length, 1, 'twelve PRs, one rank, one band');
  assert.equal(L.bands[0].rows, 3, 'drawn on three rows');
  assert.equal(L.bands[0].count, 12);
  for (const n of g.nodes) {
    const b = bandOf(L, n);
    assert.ok(b, `${n.key} is inside a band`);
    assert.equal(b.rank, 0, `${n.key} is inside the rank-0 band whatever row it landed on`);
  }
});

await t('NEGATIVE: a wrapped row is not given a rank label or a border of its own', () => {
  // The exact reported defect: three rows that each look like a rank.
  const html = page(buildGraph(Array.from({ length: 12 }, (_, i) => sp(i + 1))));
  assert.equal(occurrences(html, 'class="rk"'), 1, 'twelve PRs on three rows, ONE rank label');
  assert.equal(occurrences(html, 'class="bandbox"'), 1, 'and ONE border, around all three rows');
  assert.equal(occurrences(html, 'class="stepgap"'), 0, 'no order marker: there is no second rank');
});

await t('every row of a wrapped rank sits inside that rank, and a second rank does not', () => {
  const many = Array.from({ length: 12 }, (_, i) => sp(i + 10));
  const g = buildGraph([...many, sp(1, [edge(S, 15)])]);
  const L = layoutGraph(g);
  assert.equal(L.maxRank, 1);
  assert.ok(new Set(many.map(m => at(g, `${S}#${m.number}`).row)).size > 1, 'rank 0 really wraps');
  for (const m of many) {
    assert.equal(bandOf(L, at(g, `${S}#${m.number}`)).rank, 0, `#${m.number} is in the rank-0 band`);
  }
  assert.equal(bandOf(L, at(g, `${S}#1`)).rank, 1, 'the dependent is in a DIFFERENT band');
});

await t('two rows of one rank are closer together than two ranks, and share a border', () => {
  const many = Array.from({ length: 12 }, (_, i) => sp(i + 10));
  const g = buildGraph([...many, sp(1, [edge(S, 15)])]);
  const L = layoutGraph(g);
  const rowGap = () => {
    const ys = [...new Set(g.nodes.filter(n => n.rank === 0).map(n => n.y))].sort((a, b) => a - b);
    return ys[1] - (ys[0] + NODE_H);
  };
  const b0 = L.bands[0];
  const b1 = L.bands[1];
  const rankGap = b0.top - (b1.top + b1.height);
  assert.ok(rowGap() < rankGap, `row gap ${rowGap()} must be tighter than rank gap ${rankGap}`);
  // ...and the gap is not the only carrier, which is the point: the rows are
  // inside one border and the ranks are not.
  assert.notEqual(b0.rank, b1.rank);
  assert.ok(b1.top + b1.height < b0.top, 'the two bands do not overlap');
});

await t('the rank says on ITSELF that its members have no order, not only in the legend', () => {
  const html = page(buildGraph(Array.from({ length: 12 }, (_, i) => sp(i + 1))));
  assert.match(html, /<text class="bnote [^>]*>[^<]*<tspan class="k"[^>]*>ANY ORDER<\/tspan>/,
    'the words are inside the SVG band itself, not in the legend');
  assert.match(html, /these 12 are independent of each other/);
  assert.match(html, /nothing in this rank waits on anything else in it/);
});

await t('the note counts the PRs actually inside the band', () => {
  const g = buildGraph(Array.from({ length: 7 }, (_, i) => sp(i + 1)));
  const L = layoutGraph(g);
  assert.match(L.bands[0].note.text, /these 7 are independent/);
  assert.equal(L.bands[0].count, g.nodes.filter(n => bandOf(L, n).rank === 0).length);
  // and the count in the words is the count in the geometry, not a constant
  assert.match(bandNote(3, true).text, /these 3 are independent/);
  assert.equal(bandNote(1, true).key, 'ONE PR');
  assert.equal(bandNote(9, false).key, 'CYCLE');
});

await t('a rank of one does not claim an order that is not there', () => {
  const g = buildGraph([sp(491, [edge(S, 504)]), sp(504)]);
  const L = layoutGraph(g);
  for (const b of L.bands) {
    assert.equal(b.count, 1);
    assert.equal(b.note.key, 'ONE PR');
    assert.equal(b.note.text, 'nothing else sits at this rank');
  }
  assert.doesNotMatch(page(g), /ANY ORDER/, 'nothing to be unordered against');
});

await t('a rank holding a cut cycle edge does NOT claim to be unordered', () => {
  // Checked, not assumed. A cut edge contributes no depth, so it is the one way
  // both ends of an edge can land on one rank -- here, a PR declaring itself.
  const g = buildGraph([sp(1, [edge(S, 1)])]);
  assert.deepEqual([...rankCensus(g).tangled], [0]);
  const L = layoutGraph(g);
  assert.equal(L.bands[0].unordered, false);
  assert.equal(L.bands[0].note.key, 'CYCLE');
  const html = page(g);
  assert.doesNotMatch(html, /ANY ORDER/, 'it must not promise independence it cannot prove');
  assert.match(html, /a dependency cycle runs inside this rank/);
});

await t('between two ranks there is a marked step, and inside a rank there is none', () => {
  const g = buildGraph([sp(1, [edge(S, 2)]), sp(2, [edge(S, 3)]), sp(3), sp(4)]);
  const html = page(g);
  const L = g.layout;
  assert.equal(L.maxRank, 2);
  assert.equal(occurrences(html, 'class="stepgap"'), 2, 'one order marker per gap between ranks');
  assert.equal(occurrences(html, 'marker-end="url(#step-arrow)"'), 2);
  assert.equal(occurrences(html, '>then</text>'), 2);
  // and it is NOT the dependency arrowhead: those stay one per drawn edge
  assert.equal(occurrences(html, 'marker-end="url(#dep-arrow)"'), g.edges.length);
});

await t('the SVG text alternative states the same thing, for a reader who gets no picture', () => {
  const html = page(buildGraph([sp(1, [edge(S, 2)]), sp(2)]));
  assert.match(html, /independent of each other and can merge in any order or at the same time/);
  assert.match(html, /a band that wraps onto several rows is still one single rank, not several/);
  assert.match(html, /Order exists only between bands/);
});

console.log('the text fallback does not imply an order either');
await t('the list says outright that it is not a running order', () => {
  const html = page(buildGraph([sp(1, [edge(S, 2)]), sp(2), sp(3)]));
  assert.match(html, /The list below is not a running order\./);
  assert.match(html, /listed by number, not in merge order/);
  assert.match(html, /everything sharing one rank is independent of everything else in\s*that rank/);
});

await t('EVERY row carries its rank and how many PRs share it', () => {
  const g = buildGraph([sp(1, [edge(S, 2)]), sp(2), sp(3), sp(4)]);
  const html = page(g);
  // three at rank 0 (#2 #3 #4), one at rank 1 (#1)
  assert.equal(occurrences(html, 'rank 1 of 2 · any order among the 3 in it'), 3);
  assert.equal(occurrences(html, 'rank 2 of 2 · the only PR in it'), 1);
  assert.equal(occurrences(html, 'class="badge step"'), g.nodes.length + 2, 'one per row, plus the two in the explainer');
});

await t("a referenced PR that is not mine keeps its owner badge AND gains its rank", () => {
  const p = sp(2222, [edge('snapshot-labs/sx-monorepo', 2219, { kind: 'stack', author: 'wa0x6e', foreign: true })], 'snapshot-labs/sx-monorepo');
  const html = page(buildGraph([p]));
  assert.match(html, /not yours · @wa0x6e/, 'the existing badge survives');
  assert.match(html, /rank 1 of 2 · the only PR in it/, 'and the referenced node is ranked too');
});

await t('the text form marks a tangled rank as tangled rather than as unordered', () => {
  const html = page(buildGraph([sp(1, [edge(S, 1)])]));
  assert.match(html, /rank 1 of 1 · a cycle links two in it/);
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

console.log('the page says which way it points, and does it without a runtime');
await t('direction is stated in the title, the heading, the banner and the caption', () => {
  const html = page(buildGraph([sp(491, [edge(S, 504)]), sp(504)]));
  assert.match(html, /<title>PR dependency graph — merge from the bottom up/);
  assert.match(html, /<h1>Open PRs — merge from the bottom up<\/h1>/);
  assert.match(html, /Read the graph bottom-up\. A PR sits above the things it needs\./);
  assert.match(html, /from a prerequisite to the PR that waits on it/);
  assert.match(html, /an arrow runs from a prerequisite up to the PR that waits on\s*it/);
  assert.match(html, /merge the tail before the head/);
  assert.match(html, /MERGES FIRST/);
  assert.match(html, /MERGES LAST/);
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
  assert.match(html, /referenced only — drawn because something above needs it/);
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
