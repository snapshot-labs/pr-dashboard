// node test.mjs   (needs GH_TOKEN: the release-gate cases hit the real API)
import assert from 'node:assert/strict';
import { parseDeclarations } from './src/declarations.mjs';
import { classify } from './src/ci.mjs';
import {
  accountWithheld,
  buildGraph,
  componentsOf,
  decorateEdge,
  duplicateNodes,
  groupNodes,
  isMineFor,
  redactPrivate,
  resolveDeps,
  resolveStatus
} from './build.mjs';
import {
  cardOf,
  columnLabel,
  descRef,
  graphDesc,
  layoutGraph,
  NODE_H,
  NODE_W,
  rankCensus,
  RANK_GAP,
  shortRef,
  splitHold,
  textWidth,
  wrapText
} from './src/graph.mjs';
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

// THE RULE, and it reverses the one this file used to pin down.
//
// It used to be: every node is a PR of mine, and somebody else's is drawn only as
// the TARGET of one of my edges -- never a node in its own right, never a root,
// never with prerequisites of its own. That cut a chain off at the first PR that
// was not mine and hid what the rest of it was waiting for.
//
// It is now: split the graph into connected components, treating every edge as
// UNDIRECTED, and draw a component in full -- every node in it, whoever wrote it
// -- if at least one PR in it is mine. A component with none of mine in it is
// dropped whole and reported on `graph.pruned`.
//
// What did NOT change, and matters more now than it did: every node that is not
// mine is marked as not mine. The page no longer implies whose a node is by the
// fact of having drawn it.
console.log('a component is drawn when at least ONE PR in it is mine');
const mine = isMineFor('tony8713');
const SX = 'snapshot-labs/sx-monorepo';
const pr = (number, author, deps = [], repo = SX) => ({
  repo,
  number,
  title: `pr ${number}`,
  url: `https://github.com/${repo}/pull/${number}`,
  author,
  draft: false,
  status: 'open',
  ci: { state: 'green', ownFailures: [], baseFailures: [], pending: [], total: 0, passed: 0 },
  deps: deps.map(d =>
    typeof d === 'number'
      ? { repo, number: d, crossRepo: false, satisfied: false, status: 'open' }
      : { repo, crossRepo: false, satisfied: false, status: 'open', ...d }
  )
});

await t('one PR of mine in a chain draws the WHOLE chain, whoever wrote the rest', () => {
  // The shape of today's data: #2222 is mine and sits on wa0x6e's #2219.
  const g = buildGraph([pr(2222, 'tony8713', [2219]), pr(2219, 'wa0x6e')], mine);
  assert.deepEqual(g.nodes.map(n => n.number).sort(), [2219, 2222]);
  assert.deepEqual(g.pruned, [], 'nothing in this component is dropped');
  const [group] = groupNodes(g);
  assert.deepEqual(group.mine.map(n => n.number), [2222]);
  assert.deepEqual(group.referenced.map(n => n.number), [2219], 'accounted apart from mine');
  assert.equal(group.count, 1, 'and not counted among my open PRs');
});
await t('...and every node in it that is not mine is MARKED as not mine', () => {
  const g = buildGraph([pr(2222, 'tony8713', [2219]), pr(2219, 'wa0x6e')], mine);
  const n = at(g, `${SX}#2219`);
  assert.equal(n.kind, 'dep');
  assert.equal(n.foreign, true, 'the marking is what stops it reading as my work');
  assert.equal(at(g, `${SX}#2222`).foreign, false);
});
await t("somebody else's PR can be a ROOT, with prerequisites of its own drawn", () => {
  // wa0x6e's #2219 is branched off wa0x6e's #2210, and mine sits on top. The old
  // rule stopped at #2219 and never showed why IT could not merge.
  const g = buildGraph(
    [pr(2222, 'tony8713', [2219]), pr(2219, 'wa0x6e', [2210]), pr(2210, 'wa0x6e')],
    mine
  );
  assert.deepEqual(g.nodes.map(n => n.number).sort(), [2210, 2219, 2222]);
  assert.deepEqual(needs(at(g, `${SX}#2219`)), [`${SX}#2210`], 'it heads a chain of its own now');
  assert.equal(at(g, `${SX}#2210`).rank, 0, 'and the root of that chain is not mine either');
  assert.deepEqual([at(g, `${SX}#2219`).rank, at(g, `${SX}#2222`).rank], [1, 2]);
  assert.deepEqual(g.nodes.filter(n => n.foreign).map(n => n.number).sort(), [2210, 2219]);
});
await t("connectivity is UNDIRECTED: a PR of somebody else's that waits on MINE is drawn", () => {
  // Nothing of mine points at #900. It points at me, which joins it to my
  // component just the same -- a chain is a chain from either end.
  const g = buildGraph([pr(1, 'tony8713'), pr(900, 'wa0x6e', [1])], mine);
  assert.deepEqual(g.nodes.map(n => n.number).sort(), [1, 900]);
  assert.deepEqual(g.pruned, []);
  assert.deepEqual(neededBy(at(g, `${SX}#1`)), [`${SX}#900`]);
  assert.equal(at(g, `${SX}#900`).foreign, true);
});
await t('...and what THAT PR waits on comes with it, two hops from anything of mine', () => {
  const g = buildGraph([pr(1, 'tony8713'), pr(900, 'wa0x6e', [1, 901]), pr(901, 'wa0x6e')], mine);
  assert.deepEqual(g.nodes.map(n => n.number).sort(), [1, 900, 901]);
  assert.deepEqual(g.pruned, [], '#901 is joined to me only through #900, and that is enough');
});
await t('a chain with NONE of mine in it is dropped whole, and the drop is reported', () => {
  // Today's real second component: bonustrack's #2188 <- #2191 <- #2192, which no
  // PR of mine touches anywhere. It is not drawn, not even the end of it.
  const g = buildGraph(
    [
      pr(1, 'tony8713'),
      pr(2192, 'bonustrack', [2191]),
      pr(2191, 'bonustrack', [2188]),
      pr(2188, 'bonustrack')
    ],
    mine
  );
  assert.deepEqual(g.nodes.map(n => n.number), [1], 'only my component survives');
  assert.deepEqual(g.pruned, [`${SX}#2188`, `${SX}#2191`, `${SX}#2192`]);
  assert.equal(g.edges.length, 0, 'and its edges go with it');
  for (const k of g.pruned) assert.equal(at(g, k), undefined, `${k} is not reachable by key`);
});
await t('NEGATIVE: a lone PR by somebody else is not drawn', () => {
  // The bound: a PR is drawn because a declared dependency joins it to one of
  // mine, never because it is in the same repo or turned up in the same sweep.
  const g = buildGraph([pr(1, 'tony8713'), pr(999, 'someone-else')], mine);
  assert.deepEqual(g.nodes.map(n => n.number), [1]);
  assert.equal(at(g, `${SX}#999`), undefined);
  assert.deepEqual(g.pruned, [`${SX}#999`]);
});
await t('NEGATIVE: a foreign chain is not rescued by touching a DROPPED foreign chain', () => {
  const g = buildGraph([pr(1, 'tony8713'), pr(900, 'wa0x6e', [901]), pr(901, 'bonustrack')], mine);
  assert.deepEqual(g.nodes.map(n => n.number), [1]);
  assert.deepEqual(g.pruned, [`${SX}#900`, `${SX}#901`]);
});
await t('a PR reachable two ways is still exactly ONE node', () => {
  const g = buildGraph(
    [pr(1, 'tony8713', [900]), pr(2, 'tony8713', [900]), pr(900, 'wa0x6e')],
    mine
  );
  assert.equal(copies(g, `${SX}#900`), 1);
  assert.deepEqual(neededBy(at(g, `${SX}#900`)), [`${SX}#1`, `${SX}#2`]);
  assert.deepEqual(duplicateNodes(g), []);
});
await t('componentsOf splits on edges taken in EITHER direction', () => {
  const g = buildGraph(
    [pr(1, 'tony8713'), pr(900, 'wa0x6e', [1, 901]), pr(901, 'wa0x6e'), pr(5, 'tony8713')],
    mine
  );
  const comps = componentsOf(g.nodes).map(c => c.map(n => n.number).sort((a, b) => a - b));
  comps.sort((a, b) => a[0] - b[0]);
  assert.deepEqual(comps, [[1, 900, 901], [5]]);
});
await t('pruneComponents keeps a component held only by a MERGED PR of mine', () => {
  // A node of mine that is not one of my open PRs -- a merged prerequisite, say --
  // is still a PR of mine, and still holds its component on the page.
  const g = buildGraph([pr(900, 'wa0x6e', [{ number: 500, author: 'tony8713' }])], mine);
  assert.deepEqual(g.nodes.map(n => n.number).sort(), [500, 900]);
  assert.deepEqual(g.pruned, []);
  assert.equal(at(g, `${SX}#500`).kind, 'dep', 'not one of my open PRs, so no CI on it');
  assert.equal(at(g, `${SX}#500`).foreign, false, "but not somebody else's either");
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
await t('...and it is drawn exactly once, with no "also drawn" footnote', () => {
  const html = page(buildGraph([sp(1, [edge(S, 3)]), sp(2, [edge(S, 3)]), sp(3)]));
  assert.equal(occurrences(html, '<text class="ref" '), 3, 'three cards, one per PR');
  assert.equal(occurrences(html, '>stamp#3</text>'), 1, '#3 gets exactly one card');
  assert.equal(occurrences(html, 'href="https://github.com/snapshot-labs/stamp/pull/3"'), 1);
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
await t('...and it has one card of its own, with the release gate marked on its edge', () => {
  const html = page(
    buildGraph([sp(1225, [], JS), sp(491, [edge(JS, 1225, { crossRepo: true, needsRelease: true })])])
  );
  assert.equal(occurrences(html, '>snapshot.js#1225</text>'), 1, 'one card of its own');
  assert.equal(occurrences(html, 'href="https://github.com/snapshot-labs/snapshot.js/pull/1225"'), 1);
  assert.match(html, />GATED<\/text>/, 'the gate is compacted to one word on the edge');
  assert.match(
    html,
    /release-gated: satisfied by a published release, not by a merge/,
    'and spelled out in full on the edge title and in the legend'
  );
  assert.match(html, /release-gated: a published release, not just a merge/, 'legend entry');
});
await t('every node in the graph appears exactly once as a card of its own', () => {
  const g = buildGraph([sp(1, [edge(S, 3)]), sp(2, [edge(S, 3)]), sp(3), sp(1225, [], JS)]);
  const html = page(g);
  assert.equal(occurrences(html, '<g class="node '), g.nodes.length);
  for (const n of g.nodes) {
    assert.equal(
      occurrences(html, `>${shortRef(n.repo, n.number)}</text>`),
      1,
      `${n.key} has one card`
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
  assert.match(page(g), /<strong>1 declared dependency closes a cycle<\/strong>/);
});
await t('a cut edge is still NAMED, so the declaration is not silently dropped', () => {
  // The list used to be where a cut edge was written out. With the list gone it
  // gets a notice of its own, and a sentence in the SVG's text alternative.
  const html = page(buildGraph([sp(1, [edge(S, 2)]), sp(2, [edge(S, 3)]), sp(3, [edge(S, 2)])]));
  assert.match(html, /cannot be drawn as an arrow, so it is named here instead/);
  assert.match(html, /Nothing declared is dropped\./);
  assert.match(html, /1 declared dependency closes a cycle and cannot be drawn, but it is not dropped/);
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
    assert.ok(sorted[i].y >= sorted[i - 1].y + sorted[i - 1].h, 'no two cards overlap');
    assert.ok(sorted[i - 1].h >= NODE_H, 'and no card is shorter than the minimum');
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
  assert.match(html, /1 PR · a cycle is cut here/, 'and never "links two" about one PR');
});
await t('the column header is the ONLY place a rank is stated, and it states the count', () => {
  // It used to be stated twice: on the column header AND as a badge on every row
  // of the list. The list is gone, so the header carries it alone.
  const g = buildGraph([sp(1, [edge(S, 2)]), sp(2), sp(3), sp(4)]);
  const html = page(g);
  assert.match(html, /<text class="rknote" [^>]*>3 PRs · any order<\/text>/);
  assert.match(html, /<text class="rknote" [^>]*>1 PR<\/text>/);
  assert.equal(occurrences(html, 'class="rknote'), 2, 'one note per column, not one per PR');
  assert.doesNotMatch(html, /class="badge step"/, 'the per-card rank badge is gone');
  assert.doesNotMatch(html, /rank \d+ of \d+/, 'and nothing repeats a rank per PR');
});
await t('a tangled rank is still marked as tangled rather than as unordered', () => {
  const html = page(buildGraph([sp(1, [edge(S, 1)])]));
  assert.match(html, /<text class="rknote cyc" [^>]*>1 PR · a cycle is cut here<\/text>/);
  assert.doesNotMatch(
    html,
    /<text class="rknote[^"]*" [^>]*>[^<]*any order/,
    'no column claims an order it does not have'
  );
});
await t('NEGATIVE: the page describes the graph, it never instructs anybody to merge', () => {
  const html = page(
    buildGraph([
      ...Array.from({ length: 12 }, (_, i) => sp(i + 1)),
      sp(2251, [edge(S, 1)], 'snapshot-labs/sx-monorepo')
    ])
  );
  assert.doesNotMatch(html, /ready to merge|safe to merge|merge it now|merge now|go ahead and merge/i);
  assert.doesNotMatch(html, /you (can|should) merge/i);
});
await t('...and a single-rank graph says there is no order to keep at all', () => {
  const html = page(buildGraph([sp(1), sp(2)]));
  assert.match(html, /<text class="rk" [^>]*>NO ORDER TO KEEP<\/text>/);
  assert.match(html, /<text class="rksub" [^>]*>nothing waits on anything<\/text>/);
  assert.match(html, /<text class="rknote" [^>]*>2 PRs · any order<\/text>/);
  assert.match(
    html,
    /There are no dependency edges: nothing on this page waits on anything else on it\./,
    'and the text alternative says it too'
  );
});

console.log('the per-PR list underneath is gone');
await t('there is no per-PR listing under the drawing any more', () => {
  const g = buildGraph([
    sp(491, [edge(S, 504), edge(JS, 1225, { crossRepo: true, needsRelease: true })]),
    sp(504),
    sp(1225, [], JS)
  ]);
  const html = page(g);
  assert.doesNotMatch(html, /<ul class="tree/, 'no list');
  assert.doesNotMatch(html, /<div class="pr/, 'no per-PR rows');
  assert.doesNotMatch(html, /<ul class="edges">/, 'no per-PR edge list');
  assert.doesNotMatch(html, /<h2/, 'no repo headings');
  assert.doesNotMatch(html, /class="badge/, 'and none of the badges those rows carried');
  assert.doesNotMatch(html, /The list below is not a running order/);
  assert.doesNotMatch(html, /listed by number, not in merge order/);
  assert.doesNotMatch(html, /referenced only —/);
  assert.doesNotMatch(html, /class="dir">needed by/);
});
await t('the CI wording is off the card face, and survives only as hover text', () => {
  const red = sp(1453, [], 'snapshot-labs/score-api');
  red.ci = {
    state: 'own-red',
    ownFailures: [{ name: 'test (22) / Test' }],
    baseFailures: [],
    pending: [],
    total: 1,
    passed: 0,
    baseRef: 'master'
  };
  red.draft = true;
  const html = page(buildGraph([red]));
  const onCard = [...html.matchAll(/<text class="(?:ref|ttl|mark)[^"]*"[^>]*>(.*?)<\/text>/g)]
    .map(m => m[1])
    .join(' | ');
  assert.doesNotMatch(onCard, /red on its own|draft|CI/, `card face reads: ${onCard}`);
  assert.doesNotMatch(html, /also failing on master/, 'and the verbose failure list is gone');
  assert.match(
    html,
    /<title>score-api#1453 — pr 1453 — red on its own — draft/,
    'the classifier still runs; its verdict is on hover only'
  );
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
  assert.match(
    html,
    /The graph reads left to right: an arrow runs from a prerequisite rightward/,
    "and in the SVG's own text alternative"
  );
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
  assert.match(html, /in any order among themselves/, 'and in the text alternative');
  assert.match(html, /PRs sharing a\s*column have no order between them/, 'and in the footer');
});
await t('and on every single edge in the drawing, not only in the banner', () => {
  // The direction used to be spelled out on every row of the list. It is now on
  // every edge of the drawing instead, as that edge's own title.
  const g = buildGraph([sp(491, [edge(S, 504)]), sp(504)]);
  const html = page(g);
  assert.equal(occurrences(html, '<g class="edgeg"><title>'), g.edges.length);
  assert.equal(
    occurrences(html, '<title>stamp#504 → stamp#491 — merge stamp#504 before stamp#491'),
    1
  );
  assert.match(html, /merges after stamp#504/, 'and on the card that waits');
  assert.match(html, /merges before stamp#491/, 'and on the card that is waited on');
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
console.log('with the list gone, the SVG is the text alternative');
await t('role, title and desc survive, and the desc carries the WHOLE structure', () => {
  const g = buildGraph([
    sp(491, [edge(S, 504), edge(JS, 1225, { crossRepo: true, needsRelease: true })]),
    sp(504),
    sp(1225, [], JS)
  ]);
  const html = page(g);
  assert.match(html, /role="img" aria-labelledby="graph-title graph-desc"/);
  assert.match(html, /<title id="graph-title">Dependency graph: 3 pull requests, 2 dependency edges/);
  assert.match(
    html,
    /<desc id="graph-desc">Each pull request is drawn exactly once, as a card carrying its repository, its number and its title\./
  );
  assert.match(html, /stacked in the same column are independent of one another/);
  // every column, everything standing in it, and every edge -- in words
  assert.match(
    html,
    /Column 1 of 2, which merges first, holds 2 pull requests, in any order among themselves: (snapshot\.js#1225, stamp#504|stamp#504, snapshot\.js#1225)\./
  );
  assert.match(html, /Column 2 of 2, which merges last, holds 1 pull request: stamp#491\./);
  assert.match(
    html,
    /stamp#504 before stamp#491; snapshot\.js#1225 before stamp#491, release-gated/
  );
  assert.doesNotMatch(html, /written out under the repo headings below/, 'and no longer promises a list');
  assert.doesNotMatch(html, /also written out in the per-repository list below this diagram/);
});
await t('and a <title> on EVERY node and EVERY edge', () => {
  const g = buildGraph([
    sp(491, [edge(S, 504), edge(JS, 1225, { crossRepo: true, needsRelease: true })]),
    sp(504),
    sp(1225, [], JS)
  ]);
  const html = page(g);
  assert.equal(occurrences(html, '<g class="node '), g.nodes.length);
  assert.equal(occurrences(html, '<g class="edgeg"><title>'), g.edges.length);
  for (const n of g.nodes) {
    assert.equal(
      occurrences(html, `<title>${shortRef(n.repo, n.number)} — `),
      1,
      `${n.key} has exactly one title`
    );
  }
  // one <title> for the svg itself, plus one per node, plus one per edge
  assert.equal(occurrences(html, '<title'), 1 + g.nodes.length + g.edges.length + 1);
});
await t("somebody else's PR is marked ◇ @handle on a dashed card, with a legend entry", () => {
  const p = sp(2222, [edge('snapshot-labs/sx-monorepo', 2219, { kind: 'stack', author: 'wa0x6e', foreign: true })], 'snapshot-labs/sx-monorepo');
  const html = page(buildGraph([p]));
  assert.match(html, /<tspan class="g">◇<\/tspan> @wa0x6e<\/text>/, 'compacted, but still on the card');
  assert.match(html, /<g class="node dep">/, 'on a dashed card');
  assert.match(html, /@wa0x6e — not yours to merge/, 'and the card title says what it means');
  assert.match(
    html,
    /<span class="k">◇ @handle<\/span> whose PR it is, when it is not tony8713's to merge/,
    'and the legend explains the glyph'
  );
  assert.doesNotMatch(html, /not yours · @wa0x6e/, 'the long form is gone');
});
await t('a foreign ROOT is marked too, and so is every foreign card behind it', () => {
  // The card the old rule could not draw at all: not mine, at the left end, with
  // a prerequisite of its own. Both of them have to say whose they are, because
  // nothing else on the page does now.
  const g = buildGraph(
    [pr(2222, 'tony8713', [2219]), pr(2219, 'wa0x6e', [2210]), pr(2210, 'wa0x6e')],
    mine
  );
  const html = page(g);
  assert.equal(occurrences(html, '<tspan class="g">◇</tspan> @wa0x6e</text>'), 2, 'both marked');
  assert.equal(occurrences(html, '<g class="node dep">'), 2, 'and both cards dashed');
  assert.equal(occurrences(html, '@wa0x6e — not yours to merge'), 2, 'in the hover title too');
  assert.match(html, /1 open PR/, 'one open PR of mine, not three');
});
await t('the text alternative says whose each card is, and that whole chains are drawn', () => {
  // With the per-PR list gone the <desc> is all a reader who is not looking at
  // the picture gets, so the authorship cannot live only on the card.
  const g = buildGraph([pr(2222, 'tony8713', [2219]), pr(2219, 'wa0x6e')], mine);
  const html = page(g);
  assert.match(
    html,
    /A whole dependency chain is drawn whenever at least one pull request in it belongs to the page author/
  );
  assert.match(html, /Every one that is not the page author's names its author where it is listed/);
  assert.match(
    html,
    /holds 1 pull request: sx-monorepo#2219 \(by @wa0x6e, not the page author's\)\./
  );
  assert.match(html, /holds 1 pull request: sx-monorepo#2222\./, 'and mine is named plainly');
  assert.equal(descRef(at(g, `${SX}#2222`)), 'sx-monorepo#2222');
  assert.equal(descRef(at(g, `${SX}#2219`)), "sx-monorepo#2219 (by @wa0x6e, not the page author's)");
});
await t('the page states the component rule, and no longer the roots-are-mine one', () => {
  const html = page(buildGraph([pr(2222, 'tony8713', [2219]), pr(2219, 'wa0x6e')], mine));
  assert.match(html, /Whole chains are drawn, not just tony8713's share of them\./);
  assert.match(
    html,
    /every PR joined to it — following the arrows in <em>either<\/em>\s*direction — is drawn too, whoever wrote it/
  );
  assert.match(html, /A chain with none of tony8713's PRs in it is\s*not drawn at all/);
  assert.match(html, /Every card that is not tony8713's says so/);
  assert.match(
    html,
    /A chain is drawn <strong>in full<\/strong> if <strong>at least one<\/strong> PR in it is/
  );
  // the reversed rule is explained, not silently deleted
  assert.match(html, /This replaced a narrower rule/);
  assert.doesNotMatch(html, /Every card without a <code>◇<\/code> marker is a PR by/);
  assert.doesNotMatch(html, /Somebody else's PR is drawn only when one of these depends on it/);
  assert.doesNotMatch(html, /nothing here depends\s*on is not drawn at all/);
});
await t("a title that says DO NOT MERGE is lifted onto its own line, where truncation cannot reach it", () => {
  // sx#2251. The words are part of the PR's own title, so a long title plus a
  // narrow card could otherwise cut them off and leave the PR reading as ready.
  const p = sp(2251, [], 'snapshot-labs/sx-monorepo');
  p.title =
    'chore: add alias from aviator-dao.eth to airfox-dao.eth [DO NOT MERGE until migration is run]';
  const html = page(buildGraph([p]));
  assert.match(html, /<tspan class="g">⊘<\/tspan> DO NOT MERGE until migration is run<\/text>/);
  assert.match(html, /class="mark m-critical"/, 'and it is the loudest thing on the card');
  assert.match(
    html,
    /<title>sx-monorepo#2251 — chore: add alias from aviator-dao\.eth to airfox-dao\.eth \[DO NOT MERGE until migration is run\]/,
    'the title is still whole on hover, brackets and all'
  );
  assert.match(html, /<span class="k crit">⊘<\/span> the PR's own title says do not merge/, 'legend');
  assert.doesNotMatch(html, /ready to merge|safe to merge|merge it now|merge now/i);
});
await t('splitHold lifts a bracketed hold and leaves an unbracketed one in the title', () => {
  const a = splitHold('chore: alias airfox [DO NOT MERGE until migration is run]');
  assert.equal(a.title, 'chore: alias airfox');
  assert.equal(a.hold, 'DO NOT MERGE until migration is run');
  const b = splitHold('do not merge yet: still testing');
  assert.equal(b.title, 'do not merge yet: still testing', 'an unbracketed title is left alone');
  assert.equal(b.hold, 'do not merge yet');
  assert.equal(splitHold('fix: an ordinary title').hold, null);
  assert.equal(splitHold(null).hold, null);
});
await t('a private dependency target keeps its number and never its repo name, href included', () => {
  const p = sp(491, [
    edge('snapshot-labs/a-private-repo', 86, {
      crossRepo: true,
      title: null,
      author: null,
      hidden: true
    })
  ]);
  const html = page(buildGraph([p]));
  assert.doesNotMatch(html, /a-private-repo/, 'the repo name appears NOWHERE, not even in a link');
  assert.match(html, /<text class="ref" [^>]*>#86<\/text>/, 'the card shows the number only');
  assert.match(html, /<tspan class="g">◇<\/tspan> private repo<\/text>/);
  assert.match(html, /title withheld \(private repo\)/);
  assert.match(html, /#86 before stamp#491/, 'and the text alternative uses the number only');
});
await t('a PR the COMPONENT rule pulls in from a private repo is redacted the same way', () => {
  // The new rule can put somebody else's PR on the page as a card of its own.
  // Privacy does not care how it got here: from a private repo it is a number,
  // with no title, no author, no repo name and no link.
  const P = 'snapshot-labs/a-private-repo';
  const secret = pr(86, 'wa0x6e', [], P);
  secret.title = 'secret work about the acme launch';
  secret.body = 'Depends on #999 — because of the secret thing';
  secret.base = 'feat/secret-branch';
  redactPrivate(secret);
  const g = buildGraph([pr(491, 'tony8713', [{ repo: P, number: 86, crossRepo: true }]), secret], mine);
  assert.deepEqual(g.pruned, [], 'it is drawn: it is in a component of mine');
  const n = at(g, `${P}#86`);
  assert.deepEqual([n.hidden, n.title, n.author], [true, null, null]);

  const html = page(g);
  assert.doesNotMatch(html, /a-private-repo/, 'the repo name appears NOWHERE, not even in a link');
  assert.doesNotMatch(html, /secret work|acme|secret-branch|secret thing/i, 'nor anything else of it');
  assert.doesNotMatch(html, /@wa0x6e/, 'nor its author');
  assert.match(html, /<text class="ref" [^>]*>#86<\/text>/, 'the card shows the number only');
  assert.match(html, /<tspan class="g">◇<\/tspan> private repo<\/text>/);
  assert.match(html, /#86 \(private repository, details withheld\)/, 'and the desc says why');
});
await t('a hidden node declares nothing of its own: no edges, no branch names, no reasons', async () => {
  // Its body goes with its title. A card the page cannot even name has no
  // business printing prose or branch names out of a private repo.
  const rec = redactPrivate({
    repo: 'snapshot-labs/a-private-repo',
    number: 86,
    author: 'wa0x6e',
    title: 'secret work',
    base: 'feat/secret-branch',
    body: 'Depends on #999 — because the secret thing'
  });
  assert.deepEqual([rec.title, rec.author, rec.body, rec.hidden], [null, null, '', true]);
  assert.deepEqual(await resolveDeps(rec, new Map()), [], 'and it contributes no edge of its own');
});
await t('the withheld notice keeps its accounting', () => {
  const g = buildGraph([sp(491)]);
  const html = render({
    graph: g,
    author: 'tony8713',
    org: 'snapshot-labs',
    generatedAt: '2026-01-01T00:00:00Z',
    withheld: { count: 2, referenced: 0, blocking: 0 },
    total: 1
  });
  assert.match(html, /<strong>2 PRs withheld\.<\/strong>/);
  assert.match(html, /Neither blocks anything on this page/);
  assert.match(html, /2 cards that would have had no edges anyway, not a broken chain/);
  assert.match(html, /INCLUDE_PRIVATE=true/);
  assert.match(html, /does not pretend the work does not exist/);
});
await t('the graph-versus-tree essay and the CI explainer are gone; the syntax help stays', () => {
  const html = page(buildGraph([sp(491, [edge(S, 504)]), sp(504)]));
  assert.doesNotMatch(html, /<summary>Why this is a graph and not a tree<\/summary>/);
  assert.doesNotMatch(html, /How the CI column decides/);
  assert.doesNotMatch(html, /read upward from the leaves/);
  assert.doesNotMatch(html, /Also drawn/);
  // the one explainer that earns its place: it is how an edge gets onto the page
  assert.match(html, /<summary>Declaring a prerequisite \(the syntax this page reads\)<\/summary>/);
  assert.match(html, /Depends on release of snapshot-labs\/snapshot\.js#1225/);
  assert.match(html, /blockquoted lines are ignored/);
});

console.log('the card carries the PR title');
await t('a card is the ref AND the title, wrapped over as many lines as the title needs', () => {
  const p = sp(1453, [], 'snapshot-labs/score-api');
  p.title = 'fix: throttle upstream RPC-provider error reporting to stop log amplification';
  const html = page(buildGraph([p]));
  assert.match(
    html,
    /<text class="ref" [^>]*>score-api#1453<\/text>/,
    'the ref stays: it is how people refer to these'
  );
  const lines = [...html.matchAll(/<text class="ttl"[^>]*>([^<]*)<\/text>/g)].map(m => m[1]);
  assert.ok(lines.length >= 2, `the title wrapped over ${lines.length} line(s)`);
  assert.equal(lines.join(' '), p.title, 'and the whole title is on the card, in order');
});
await t('a title too long for three lines is cut with an ellipsis and kept whole on hover', () => {
  const p = sp(1);
  p.title = `fix(resolvers): ${'a very long clause about resolvers '.repeat(8)}end`;
  const html = page(buildGraph([p]));
  const lines = [...html.matchAll(/<text class="ttl"[^>]*>([^<]*)<\/text>/g)].map(m => m[1]);
  assert.equal(lines.length, 3, 'never more than three lines on a card');
  assert.match(lines[2], /…$/, 'the cut is marked');
  assert.ok(html.includes(`<title>stamp#1 — ${p.title} —`), 'the full title survives on hover');
});
await t('a card is as tall as its own title, and cards never overlap because of it', () => {
  const short = sp(1);
  short.title = 'fix: one';
  const long = sp(2);
  long.title =
    'fix(addressResolvers): keep out-of-range 64-hex values out of the hub batch entirely';
  const g = buildGraph([short, long]);
  layoutGraph(g);
  const a = at(g, `${S}#1`);
  const b = at(g, `${S}#2`);
  assert.ok(b.h > a.h, `a longer title makes a taller card (${a.h} vs ${b.h})`);
  const sorted = [a, b].sort((p, q) => p.y - q.y);
  assert.ok(sorted[1].y >= sorted[0].y + sorted[0].h, 'and the packing respects it');
  assert.ok(NODE_W >= 240, 'the card got wider to hold a title, which is the point');
});
await t('no line drawn in a card is wider than the card', () => {
  const titles = [
    'fix: skip proposal emails for flagged spaces',
    "fix(ui): Sepolia ENS v2 space creation 'not allowed' (resolver-agnostic controller check)",
    'MIGRATE ALL THE UPPERCASE THINGS BECAUSE CAPITALS ARE WIDER THAN LOWERCASE ONES',
    'Update Sepolia ENS subgraph',
    'chore: add alias from aviator-dao.eth to airfox-dao.eth [DO NOT MERGE until migration is run]'
  ];
  const g = buildGraph(
    titles.map((ttl, i) => {
      const p = sp(i + 1);
      p.title = ttl;
      return p;
    })
  );
  layoutGraph(g);
  const budget = NODE_W - 20;
  for (const n of g.nodes) {
    assert.ok(textWidth(n.card.ref, 10.5, true) <= budget, `ref of ${n.key}`);
    for (const l of n.card.lines) {
      assert.ok(textWidth(l, 11) <= budget, `"${l}" is ${Math.round(textWidth(l, 11))}px`);
    }
    for (const m of n.card.marks) {
      assert.ok(textWidth(`${m.glyph} ${m.text}`, 9.5) <= budget, `marker "${m.text}"`);
    }
  }
});
await t('wrapText breaks on words, hard-breaks a word that cannot fit, and never overruns', () => {
  const lines = wrapText('alpha beta gamma delta epsilon zeta eta theta', 60, 11, 5);
  assert.ok(lines.length > 1);
  for (const l of lines) assert.ok(textWidth(l, 11) <= 60, `"${l}" fits`);
  const hard = wrapText('supercalifragilisticexpialidocious', 40, 11, 5);
  assert.ok(hard.length > 1, 'a single unbreakable word is hard-broken rather than overflowing');
  for (const l of hard) assert.ok(textWidth(l, 11) <= 40, `"${l}" fits`);
  assert.deepEqual(wrapText('', 60, 11, 3), []);
});
await t('a card with no title available says so instead of showing an empty box', () => {
  const c = cardOf({ kind: 'dep', repo: 'snapshot-labs/stamp', number: 9, title: null });
  assert.deepEqual(c.lines, ['title unavailable']);
  assert.equal(c.dim, true);
  const h = cardOf({ kind: 'dep', repo: 'x/y', number: 9, title: null, hidden: true });
  assert.deepEqual(h.lines, ['title withheld (private repo)']);
});
await t('graphDesc names every node and every edge, one sentence per column', () => {
  const g = buildGraph([sp(1, [edge(S, 3)]), sp(2, [edge(S, 3)]), sp(3), sp(1225, [], JS)]);
  layoutGraph(g);
  const desc = graphDesc(g);
  const ranks = new Set(g.nodes.map(n => n.rank));
  assert.equal(occurrences(desc, ' holds '), ranks.size, 'one sentence per column');
  for (const n of g.nodes) {
    assert.ok(desc.includes(shortRef(n.repo, n.number)), `${n.key} is named in the description`);
  }
  assert.equal(occurrences(desc, ' before '), g.edges.length, 'and every edge, once');
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
