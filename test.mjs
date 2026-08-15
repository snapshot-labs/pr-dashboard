// node test.mjs   (needs GH_TOKEN: the release-gate cases hit the real API)
import assert from 'node:assert/strict';
import { parseDeclarations } from './src/declarations.mjs';
import { classify } from './src/ci.mjs';
import {
  accountWithheld,
  buildGraph,
  componentsOf,
  declaredEdge,
  expandMergedTrail,
  decorateEdge,
  duplicateNodes,
  groupNodes,
  isMineFor,
  mergedNonPrerequisites,
  prRecord,
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
  nodeState,
  nodeTitleText,
  rankCensus,
  RANK_GAP,
  shortRef,
  splitHold,
  textWidth,
  wrapText
} from './src/graph.mjs';
import { render } from './src/render.mjs';
import { getPr } from './src/github.mjs';
import { openPrState, PR_STATES, prState, STATE_GLYPH } from './src/state.mjs';

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

// The spellings people actually write on a stacked PR. `Depends on` was the only
// one this understood, and the cost was not cosmetic: the computed stack edge
// dies the instant the parent merges (GitHub retargets the child), so a stack
// that was never declared in words leaves the page at the moment it lands.
console.log('the stack spellings declare what "depends on" declares');
await t('"Stacked on" is a declaration', () => {
  const [d] = parseDeclarations('Stacked on #2219', 'o/r');
  assert.deepEqual([d.repo, d.number, d.stacked, d.crossRepo], ['o/r', 2219, true, false]);
});
await t('"On top of" is a declaration', () => {
  const [d] = parseDeclarations('On top of #2188', 'o/r');
  assert.deepEqual([d.repo, d.number, d.stacked], ['o/r', 2188, true]);
});
await t('"Stacked on top of" with the branch in parentheses', () => {
  const [d] = parseDeclarations(
    'Stacked on top of #2188 (`feat/safesnap-execution`) — review/merge that first.',
    'o/r'
  );
  assert.equal(d.number, 2188);
  assert.equal(d.branch, 'feat/safesnap-execution', 'the backticks are markdown, not the ref');
});
await t('the stack spellings take the cross-repo and release-gated forms too', () => {
  const [d] = parseDeclarations('Stacked on release of snapshot-labs/snapshot.js#1225', 'o/r');
  assert.deepEqual([d.repo, d.crossRepo, d.needsRelease], [
    'snapshot-labs/snapshot.js', true, true
  ]);
});
await t('lowercase and a bullet are both fine', () => {
  assert.equal(parseDeclarations('- stacked on #7', 'o/r').length, 1);
});
await t('the instruction after a stack spelling is NOT the arrow label', () => {
  const [d] = parseDeclarations('Stacked on #2219 — retarget to `master` after it merges.', 'o/r');
  assert.equal(d.reason, null, 'that is advice to the author, and it expires when #2219 merges');
  assert.match(d.raw, /retarget to/, 'and the line is still carried verbatim');
});
await t('the branch is the arrow label instead, matching the computed edge', () => {
  const [d] = parseDeclarations('Stacked on top of #2188 (`feat/safesnap-execution`) — x', 'o/r');
  assert.equal(d.reason, 'stacked on feat/safesnap-execution');
});
await t('a parenthetical that cannot be a branch is not used as one', () => {
  const [d] = parseDeclarations('Stacked on #123 (the schema PR) — x', 'o/r');
  assert.equal(d.branch, null, 'a git ref cannot hold a space');
  assert.equal(d.reason, null);
});
await t('"Depends on" keeps its reason, and a parenthetical does not eat it', () => {
  const [d] = parseDeclarations('Depends on #504 (`some-branch`) — because reasons', 'o/r');
  assert.equal(d.reason, 'because reasons');
  assert.equal(d.stacked, false);
});
await t('NEGATIVE: a stack spelling in a blockquote declares nothing', () => {
  assert.deepEqual(parseDeclarations('> Stacked on #2219 — retarget later', 'o/r'), []);
});
await t('NEGATIVE: a stack spelling in fenced code declares nothing', () => {
  assert.deepEqual(parseDeclarations('```\nStacked on top of #2188\n```', 'o/r'), []);
  assert.deepEqual(parseDeclarations('~~~\nOn top of #2188\n~~~', 'o/r'), []);
});
await t('NEGATIVE: mid-sentence stack prose declares nothing', () => {
  assert.deepEqual(parseDeclarations('This one sits on top of #2188 for now.', 'o/r'), []);
});
await t('NEGATIVE: a line that carries on past the number declares nothing', () => {
  // sx-monorepo#2218 opens with exactly this shape.
  assert.deepEqual(
    parseDeclarations('Together with #2219, this will allow a simpler PR on #2099', 'o/r'),
    []
  );
  assert.deepEqual(parseDeclarations('Stacked on #1 and #2', 'o/r'), []);
});
await t('one target declared twice, in two spellings, is one declaration', () => {
  const d = parseDeclarations('Stacked on o/r#1\nDepends on o/r#1 — and again', 'o/r');
  assert.equal(d.length, 1);
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

// The card fill. GitHub has no "draft" state: a pull request carries `state`
// ("open" | "closed"), a separate `draft` flag (`isDraft` in GraphQL), and
// `merged_at`. These assert the mapping against the SHAPE OF THE REAL PAYLOAD,
// and the live block at the bottom of this file checks that shape is still what
// GitHub sends.
console.log('PR state -> the colour a card is filled with');
await t('an open PR with the flag clear is open', () => {
  assert.equal(prState({ state: 'open', draft: false, merged_at: null }), 'open');
});
await t('a DRAFT is an open PR with the flag set, not a third state value', () => {
  assert.equal(prState({ state: 'open', draft: true, merged_at: null }), 'draft');
});
await t('MERGED is read off merged_at, because state says "closed" for it', () => {
  // The trap: a merged PR's `state` is "closed", exactly like one that was
  // thrown away. merged_at is the only field that separates them.
  assert.equal(prState({ state: 'closed', draft: false, merged_at: '2026-08-01T00:00:00Z' }), 'merged');
});
await t('closed and never merged is closed, not merged', () => {
  assert.equal(prState({ state: 'closed', draft: false, merged_at: null }), 'closed');
});
await t('NEGATIVE: a PR closed while still a draft reads closed, not draft', () => {
  // GitHub leaves the flag set. Reading it before `state` would hide the fact
  // that the prerequisite is gone.
  assert.equal(prState({ state: 'closed', draft: true, merged_at: null }), 'closed');
});
await t('NEGATIVE: a merged PR that still carries the draft flag reads merged', () => {
  assert.equal(prState({ state: 'closed', draft: true, merged_at: '2026-08-01T00:00:00Z' }), 'merged');
});
await t('NEGATIVE: the mapping never reads `merged`, which the LIST endpoint omits', () => {
  // /repos/{r}/pulls returns merged_at but no `merged` boolean. Trusting
  // `merged` would classify every stack parent as unmerged.
  assert.equal(prState({ state: 'closed', merged_at: '2026-08-01T00:00:00Z' }), 'merged');
  assert.equal(prState({ state: 'closed', merged: true, merged_at: null }), 'closed');
});
await t('an unreadable target is unknown, never guessed', () => {
  assert.equal(prState(null), 'unknown');
  assert.equal(prState(undefined), 'unknown');
  assert.equal(prState({}), 'unknown');
  assert.equal(prState({ state: 'weird' }), 'unknown');
});
await t('an open-search PR is open or draft and nothing else', () => {
  assert.equal(openPrState({ draft: true }), 'draft');
  assert.equal(openPrState({ draft: false }), 'open');
  assert.equal(openPrState({}), 'open');
});
await t('every state has a glyph, and no two states share one', () => {
  const glyphs = PR_STATES.map(s => STATE_GLYPH[s]);
  assert.ok(glyphs.every(Boolean), 'no state is colour-only');
  assert.equal(new Set(glyphs).size, PR_STATES.length, 'the glyphs separate the states on their own');
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

// --- tracked bots ---------------------------------------------------------
//
// chai3-bot's PRs are TRACKED: they seed the page and anchor a component exactly
// as the page author's do, and they are drawn wherever the ranking puts them.
//
// The premise worth testing against, because it is easy to assume the opposite:
// there was never a rule confining somebody else's PR to a leaf or a root. The
// component rule replaced that rule, and a foreign node has sat mid-graph ever
// since (see "somebody else's PR can be a ROOT..." above, and the mid-graph case
// below). What kept chai3-bot off the page was that nothing tracked was anywhere
// in its component, so pruneComponents() dropped it -- not where it would have
// been drawn, but whether. These tests pin BOTH: that a bot PR is drawn, and that
// it is drawn in the middle of a chain when that is where its edges put it.
console.log('a tracked bot anchors a component, and sits anywhere in the graph');
const bot = isMineFor(['chai3-bot']);
const botGraph = (prs, trail = []) => buildGraph(prs, mine, trail, bot);

await t('isMineFor takes a LIST, and still takes one login', () => {
  const both = isMineFor(['tony8713', 'chai3-bot']);
  assert.equal(both('Tony8713'), true);
  assert.equal(both('CHAI3-BOT'), true);
  assert.equal(both('wa0x6e'), false);
  assert.equal(both(null), false);
  assert.equal(isMineFor(['tony8713', ''])(''), false, 'an empty login matches nothing');
});
await t('a LONE bot PR, on no edge at all, is drawn: it anchors its own component', () => {
  // envelop#300 today: no declared dependency, nothing of mine anywhere near it.
  // Under the old anchor it was a component of one with nothing tracked in it and
  // was dropped whole; this is the whole of what the change does.
  const g = botGraph([pr(1, 'tony8713'), pr(300, 'chai3-bot')]);
  assert.deepEqual(g.nodes.map(n => n.number).sort((a, b) => a - b), [1, 300]);
  assert.deepEqual(g.pruned, [], 'nothing dropped');
  assert.equal(at(g, `${SX}#300`).kind, 'bot');
});
await t('NEGATIVE: without the bot predicate that same PR is still dropped', () => {
  const g = buildGraph([pr(1, 'tony8713'), pr(300, 'chai3-bot')], mine);
  assert.deepEqual(g.nodes.map(n => n.number), [1]);
  assert.deepEqual(g.pruned, [`${SX}#300`], 'so the anchor really is what changed');
});
await t('a bot PR sits MID-GRAPH: an arrow in and an arrow out, rank 1 of 2', () => {
  // The thing to prove, stated as the shape it has to have. #500 (mine) <- #300
  // (the bot's) <- #700 (mine): the bot's card is neither a root nor a leaf, and
  // nothing in the ranking knows or cares who wrote it.
  const g = botGraph([
    pr(500, 'tony8713'),
    pr(300, 'chai3-bot', [500]),
    pr(700, 'tony8713', [300])
  ]);
  const n = at(g, `${SX}#300`);
  assert.deepEqual(needs(n), [`${SX}#500`], 'an arrow arrives');
  assert.deepEqual(neededBy(n), [`${SX}#700`], 'and an arrow leaves');
  assert.deepEqual([at(g, `${SX}#500`).rank, n.rank, at(g, `${SX}#700`).rank], [0, 1, 2]);
  assert.equal(n.kind, 'bot', 'and it is a full card there, not a stub');
});
await t('a bot PR can be a ROOT with prerequisites of its own, and a LEAF', () => {
  const g = botGraph([pr(300, 'chai3-bot', [301]), pr(301, 'chai3-bot'), pr(9, 'tony8713', [300])]);
  assert.equal(at(g, `${SX}#301`).rank, 0, 'the leftmost card is the bot\'s');
  assert.deepEqual(neededBy(at(g, `${SX}#300`)), [`${SX}#9`]);
  const h = botGraph([pr(9, 'tony8713'), pr(300, 'chai3-bot', [9])]);
  assert.deepEqual(neededBy(at(h, `${SX}#9`)), [`${SX}#300`], 'and it can be the last card too');
  assert.equal(at(h, `${SX}#300`).neededBy.length, 0);
});
await t('a bot PR anchors a chain of STRANGERS, drawn in full, with none of mine in it', () => {
  // The anchor is genuinely equal to mine: no PR of tony8713's is anywhere in
  // this component, and it is still drawn whole.
  const g = botGraph([pr(300, 'chai3-bot', [901]), pr(901, 'wa0x6e', [902]), pr(902, 'bonustrack')]);
  assert.deepEqual(g.nodes.map(n => n.number).sort((a, b) => a - b), [300, 901, 902]);
  assert.deepEqual(g.pruned, []);
  assert.deepEqual(
    g.nodes.filter(n => n.kind === 'dep').map(n => n.number).sort((a, b) => a - b),
    [901, 902],
    'and the strangers are still marked as strangers'
  );
});
await t('NEGATIVE: a chain with neither mine nor a bot\'s in it is still dropped whole', () => {
  const g = botGraph([pr(1, 'tony8713'), pr(901, 'wa0x6e', [902]), pr(902, 'bonustrack')]);
  assert.deepEqual(g.nodes.map(n => n.number), [1]);
  assert.deepEqual(g.pruned, [`${SX}#901`, `${SX}#902`], 'the bound did not move for everyone');
});
await t('a bot PR is FOREIGN, so it keeps the ◇ @handle mark: tracked is not mine', () => {
  const g = botGraph([pr(300, 'chai3-bot')]);
  const n = at(g, `${SX}#300`);
  assert.equal(n.foreign, true, 'not the page author\'s, and the card has to say so');
  assert.equal(n.kind, 'bot', 'but not merely referenced either');
  assert.equal(n.status, undefined, 'seeded open, so "open" is noise, same as mine');
});
await t('a merged bot PR is a dep like any merged PR, and trips no assertion', () => {
  // Parallel to `own`: 'bot' means an OPEN PR. A merged one arrives as an edge
  // target, is filed dep, and is legal precisely because something needs it.
  const g = botGraph([
    pr(9, 'tony8713', [{ number: 300, author: 'chai3-bot', merged: true, targetState: 'merged' }])
  ]);
  const n = at(g, `${SX}#300`);
  assert.equal(n.kind, 'dep');
  assert.equal(n.state, 'merged');
  assert.deepEqual(mergedNonPrerequisites(g), [], 'it IS a prerequisite, so it is allowed');
});
await t('a merged bot PR that nothing needs is caught, exactly as a merged one of mine is', () => {
  const g = botGraph([{ ...pr(300, 'chai3-bot'), state: 'merged' }]);
  assert.deepEqual(mergedNonPrerequisites(g), [`${SX}#300`], 'kind:bot is an OPEN PR or it is a bug');
});
await t('a merged PR of the BOT\'s anchors its component, as a merged one of mine does', () => {
  const g = botGraph([pr(901, 'wa0x6e', [{ number: 300, author: 'chai3-bot' }])]);
  assert.deepEqual(g.nodes.map(n => n.number).sort((a, b) => a - b), [300, 901]);
  assert.deepEqual(g.pruned, [], 'the anchor reads the AUTHOR, not the kind');
});
await t('groupNodes counts a bot apart from mine AND apart from the merely referenced', () => {
  const g = botGraph([pr(9, 'tony8713', [300]), pr(300, 'chai3-bot', [901]), pr(901, 'wa0x6e')]);
  const [group] = groupNodes(g);
  assert.deepEqual(group.mine.map(n => n.number), [9]);
  assert.deepEqual(group.bots.map(n => n.number), [300]);
  assert.deepEqual(group.referenced.map(n => n.number), [901]);
  assert.equal(group.count, 1, 'the open-PR total stays the page author\'s');
  assert.equal(group.botCount, 1);
  assert.deepEqual(group.nodes.map(n => n.number), [9, 300, 901], 'and every node lands in one');
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
    [wh('snapshot-labs/a-private-repo', 86, 'tony8713'), wh('snapshot-labs/another-private-repo', 8, 'tony8713')],
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
    deps: [{ repo: 'snapshot-labs/a-private-repo', number: 86, crossRepo: true, satisfied: false }]
  };
  const r = accountWithheld([wh('snapshot-labs/a-private-repo', 86, 'tony8713')], [dependent], mine);
  assert.deepEqual([r.count, r.referenced, r.blocking], [1, 1, 1]);
});
await t('a withheld PR by another author that nothing depends on is NOT counted', () => {
  // It would not be rendered even if the repo were public, so calling it
  // "withheld" would overstate what privacy is hiding.
  const r = accountWithheld([wh('snapshot-labs/a-private-repo', 90, 'someone-else')], [pr(1, 'tony8713')], mine);
  assert.equal(r.count, 0);
});
await t("a tracked BOT's private PR is counted as withheld, on the same terms as mine", () => {
  // The privacy consequence of tracking a second author, pinned. A tracked
  // author's private-repo PR is WITHHELD and counted -- never redacted and drawn
  // -- so widening the tracked set widens what the notice OWNS UP TO, not what
  // the page prints.
  const tracked = isMineFor(['tony8713', 'chai3-bot']);
  const priv = [wh('snapshot-labs/a-private-repo', 42, 'chai3-bot')];
  const r = accountWithheld(priv, [pr(1, 'tony8713')], tracked);
  assert.deepEqual([r.count, r.referenced, r.blocking], [1, 0, 0]);
  assert.equal(
    accountWithheld(priv, [pr(1, 'tony8713')], mine).count,
    0,
    'and it is the TRACKED predicate that counts it, not the page-author one'
  );
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
  // What the build derives from the target's payload, and what the card that
  // target becomes is filled with.
  targetState: 'open',
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

// ---------------------------------------------------------------------------
// THE MERGED-TRAIL RULE: a merged PR is drawn if and only if something on the
// graph depends on it, transitively.
// ---------------------------------------------------------------------------
//
// `merged` and `satisfied` are separate on purpose. A release-gated prerequisite
// can be merged and NOT satisfied, and the page has to draw the first while
// still honouring the second.
const done = (repo, number, over = {}) =>
  edge(repo, number, {
    merged: true,
    satisfied: true,
    status: 'merged',
    targetState: 'merged',
    ...over
  });
const gated = (repo, number, over = {}) =>
  edge(repo, number, {
    merged: true,
    satisfied: false,
    needsRelease: true,
    crossRepo: true,
    status: 'merged, awaiting release',
    targetState: 'merged',
    ...over
  });
// One trail record: the prerequisites a MERGED PR declared for itself.
const trailOf = (repo, number, deps) => ({ repo, number, deps });

console.log('the merged trail: kept when something depends on it, dropped when nothing does');
await t('a merged prerequisite IS drawn, because one of mine depends on it', () => {
  const g = buildGraph([sp(491, [done(S, 400)])]);
  const n = at(g, `${S}#400`);
  assert.ok(n, '#400 is on the graph');
  assert.equal(n.merged, true);
  assert.equal(n.satisfied, true);
  assert.deepEqual(neededBy(n), [`${S}#491`], 'and it is there as the thing #491 waited for');
});
await t('NEGATIVE: a merged PR that nothing depends on is not drawn at all', () => {
  // The other half of the rule, and the half that keeps the page readable: the
  // root set is my OPEN PRs, so a merged PR only ever arrives as an edge target.
  const g = buildGraph([sp(491, [done(S, 400)])], () => true, [
    // A trail record for a merged PR that is NOT on the graph is never spent, so
    // the transitive rule cannot smuggle in a merged PR nothing waits on.
    trailOf(S, 777, [done(S, 778)])
  ]);
  assert.equal(at(g, `${S}#777`), undefined);
  assert.equal(at(g, `${S}#778`), undefined);
  assert.deepEqual(g.nodes.map(n => n.key).sort(), [`${S}#400`, `${S}#491`]);
});
await t('TRANSITIVE: a drawn merged PR brings its OWN declared prerequisite with it', () => {
  // #491 (open) <- #400 (merged) <- #300 (merged). All three links of the trail.
  const g = buildGraph([sp(491, [done(S, 400)])], () => true, [trailOf(S, 400, [done(S, 300)])]);
  assert.ok(at(g, `${S}#300`), '#300 is on the trail even though nothing OPEN names it');
  assert.deepEqual(needs(at(g, `${S}#400`)), [`${S}#300`]);
  assert.deepEqual(neededBy(at(g, `${S}#300`)), [`${S}#400`]);
  assert.equal(at(g, `${S}#300`).merged, true);
});
await t('...and it keeps going: three merged hops behind one open PR', () => {
  const g = buildGraph([sp(491, [done(S, 400)])], () => true, [
    // Deliberately NOT in chain order, so the walk cannot be relying on the
    // records arriving already sorted.
    trailOf(S, 300, [done(S, 200)]),
    trailOf(S, 400, [done(S, 300)])
  ]);
  assert.deepEqual(
    g.nodes.map(n => n.key).sort(),
    [`${S}#200`, `${S}#300`, `${S}#400`, `${S}#491`]
  );
  assert.deepEqual(
    [at(g, `${S}#200`).rank, at(g, `${S}#300`).rank, at(g, `${S}#400`).rank, at(g, `${S}#491`).rank],
    [0, 1, 2, 3],
    'the whole trail is ranked, so the drawing is as long as the chain really is'
  );
});
await t('a merged PR two of mine depend on is still ONE node with two edges', () => {
  const g = buildGraph([sp(1, [done(S, 400)]), sp(2, [done(S, 400)])]);
  assert.equal(copies(g, `${S}#400`), 1);
  assert.deepEqual(duplicateNodes(g), []);
  assert.deepEqual(neededBy(at(g, `${S}#400`)), [`${S}#1`, `${S}#2`]);
});
await t('a merged prerequisite in another repo is drawn, and the edge crosses', () => {
  const g = buildGraph([sp(491, [done(JS, 1223, { crossRepo: true })])]);
  assert.ok(at(g, `${JS}#1223`));
  assert.equal(g.edges[0].edge.crossRepo, true);
});

console.log('walking the trail: only merged nodes extend it, and the walk terminates');
const loader = table => async (repo, number) => table[`${repo}#${number}`] || [];
await t('a merged seed is followed, and what it declares is followed too', async () => {
  const r = await expandMergedTrail([done(S, 400)], loader({
    [`${S}#400`]: [done(S, 300)],
    [`${S}#300`]: [done(S, 200)]
  }));
  assert.deepEqual(r.visited, [`${S}#400`, `${S}#300`, `${S}#200`]);
  assert.deepEqual(r.records.map(x => `${x.repo}#${x.number}`), [`${S}#400`, `${S}#300`]);
  assert.equal(r.truncated, false);
});
await t('NEGATIVE: an OPEN prerequisite heads no chain of its own', async () => {
  // Following open PRs would pull a stranger's whole backlog onto the page
  // through one edge. Merged work is finite and already on the trail.
  const r = await expandMergedTrail([edge(S, 504)], loader({ [`${S}#504`]: [done(S, 400)] }));
  assert.deepEqual(r.visited, []);
  assert.deepEqual(r.records, []);
});
await t('a merged-but-unreleased prerequisite still extends the trail', async () => {
  // It is merged, so it is drawn, so what it declared is drawn: satisfied is a
  // different question from merged and does not gate the walk.
  const r = await expandMergedTrail([gated(JS, 1222)], loader({ [`${JS}#1222`]: [done(JS, 1100)] }));
  assert.deepEqual(r.visited, [`${JS}#1222`, `${JS}#1100`]);
});
await t('NEGATIVE: a merged PR pointing at something still OPEN is a stale claim, not an edge', async () => {
  // The PR merged anyway, so that gate was never real. Drawing it would put an
  // open PR to the LEFT of a merged one and assert it must merge first, which is
  // both untrue and unsatisfiable.
  const r = await expandMergedTrail([done(S, 400)], loader({
    [`${S}#400`]: [done(S, 300), edge(S, 504)]
  }));
  assert.deepEqual(r.records[0].deps.map(d => d.number), [300], 'only the merged one is kept');
  assert.deepEqual(r.stale, [`${S}#400 -> ${S}#504 (open)`], 'and the drop is reported, not hidden');
  assert.deepEqual(r.visited, [`${S}#400`, `${S}#300`]);
});
await t('...so every node the trail adds is itself merged', () => {
  const g = buildGraph([sp(491, [done(S, 400)])], () => true, [trailOf(S, 400, [done(S, 300)])]);
  assert.ok(g.nodes.filter(n => n.kind === 'dep').every(n => n.merged));
});
await t('a declared cycle between merged PRs terminates instead of spinning', async () => {
  const r = await expandMergedTrail([done(S, 400)], loader({
    [`${S}#400`]: [done(S, 300)],
    [`${S}#300`]: [done(S, 400)]
  }));
  assert.deepEqual(r.visited, [`${S}#400`, `${S}#300`]);
  assert.equal(r.truncated, false);
});
await t('one merged PR needed twice is walked once', async () => {
  const r = await expandMergedTrail([done(S, 400), done(S, 400)], loader({}));
  assert.deepEqual(r.visited, [`${S}#400`]);
});
await t('a runaway chain stops at the limit and SAYS the drawing is incomplete', async () => {
  const chain = {};
  for (let i = 1; i < 40; i++) chain[`${S}#${i}`] = [done(S, i + 1)];
  const r = await expandMergedTrail([done(S, 1)], loader(chain), 5);
  assert.equal(r.truncated, true);
  assert.equal(r.visited.length, 5);
});

console.log('a merged prerequisite reads as DONE, and never as work still to do');
await t('the card is filled as merged and says so in a word', () => {
  // The fill comes from the state channel (src/state.mjs); what the trail rule
  // has to guarantee is that a trail node reaches it with the right state.
  const g = buildGraph([sp(491, [done(S, 400)])]);
  g.layout = layoutGraph(g);
  const html = page(g);
  assert.equal(at(g, `${S}#400`).state, 'merged', 'the card knows its state');
  assert.match(html, /<g class="node dep st-merged">/, 'so it is filled as merged');
  assert.match(html, /<text class="st"[^>]*>● merged<\/text>/, 'and says so, not only in ink');
});
await t('merged and satisfied are consistent with the state channel, and cannot drift', () => {
  // Two derivations of one fact -- resolveStatus() sets `merged`, prState() sets
  // `state` -- so they are pinned against each other.
  const g = buildGraph([sp(491, [done(S, 400), gated(JS, 1222)])]);
  for (const n of g.nodes.filter(x => x.kind === 'dep'))
    assert.equal(n.merged, n.state === 'merged', `${n.key}: merged and state agree`);
  assert.equal(at(g, `${JS}#1222`).merged, true, 'gated: merged...');
  assert.equal(at(g, `${JS}#1222`).satisfied, false, '...and not satisfied');
});
await t('the met edge gets the met ARROWHEAD as well as the met line', () => {
  // A marker does not inherit the stroke of the path that references it, so a
  // met edge with the default head came out as a light line ending in a
  // full-weight point. Hence a second <marker> def rather than a class.
  const g = buildGraph([sp(491, [done(S, 400)])]);
  g.layout = layoutGraph(g);
  const html = page(g);
  assert.match(html, /<marker id="dep-arrow-met"/, 'the met arrowhead is defined');
  assert.match(html, /<path class="edge met"[^>]*marker-end="url\(#dep-arrow-met\)"/);
  assert.match(html, /\.ahead\.met\{fill:var\(--muted\)\}/, 'in the same ink as the met line');
  assert.match(html, />✓ MET</, 'and the edge is labelled, so it is not colour alone');
});
await t('the hover text says already merged, in full words', () => {
  // With the per-PR list gone the card title IS the detail surface, so the fact
  // has to be there in words and not only in the fill.
  const g = buildGraph([sp(491, [done(S, 400)])]);
  g.layout = layoutGraph(g);
  const html = page(g);
  assert.match(html, /already merged — drawn because something here still depends on it/);
  assert.match(html, /nothing is waiting on it any more/);
});
await t('CRUCIAL: its dependent is not described as held back by it', () => {
  const g = buildGraph([sp(491, [done(S, 400)])]);
  g.layout = layoutGraph(g);
  const html = page(g);
  const svg = html.slice(html.indexOf('<svg'), html.indexOf('</svg>'));
  assert.doesNotMatch(svg, /blocked|waiting for|still needs|cannot merge/i,
    'nothing in the drawing says #491 is held back');
  assert.match(svg, /merges after stamp#400/, 'the edge is stated, in the past tense');
  assert.doesNotMatch(html, /ready to merge|safe to merge|merge it now/i,
    'and the absence of a blocker is never turned into advice');
});
await t('the text alternative names the merged cards and says why they are drawn', () => {
  const g = buildGraph([sp(491, [done(S, 400)])]);
  g.layout = layoutGraph(g);
  const html = page(g);
  assert.match(html, /1 of these has already merged and is drawn because something here still depends on it: stamp#400/);
  assert.match(html, /Each of those is a wait that is already over/);
  assert.match(html, /Column 1 of 2, which has already merged, holds 1 pull request: stamp#400/);
});
await t('a merged-but-unreleased prerequisite does NOT let its dependent look ready', () => {
  const g = buildGraph([sp(491, [gated(JS, 1222)])]);
  g.layout = layoutGraph(g);
  const html = page(g);
  const svg = html.slice(html.indexOf('<svg'), html.indexOf('</svg>'));
  const n = at(g, `${JS}#1222`);
  assert.deepEqual([n.merged, n.satisfied], [true, false]);
  assert.match(html, /<g class="node dep st-merged">/, 'filled as merged, because it IS merged');
  assert.match(html, /the merge landed and the gate has not opened, so it is still in the way/);
  assert.doesNotMatch(svg, /class="edge cross met"/, 'and its edge is NOT drawn as met');
  assert.doesNotMatch(svg, /marker-end="url\(#dep-arrow-met\)"/, 'nor given the met arrowhead');
  assert.doesNotMatch(svg, />✓ MET</, 'nor labelled as met');
  assert.match(svg, />GATED</, 'the gate is still labelled on the edge');
});
await t('a mix of one merged and one open prerequisite keeps the open arrow live', () => {
  const g = buildGraph([sp(491, [done(S, 400), edge(S, 504)])]);
  g.layout = layoutGraph(g);
  const html = page(g);
  assert.equal(occurrences(html, 'class="edge met"'), 1, 'exactly one met edge');
  assert.equal(occurrences(html, 'class="edge"'), 1, 'and one that is still live');
});
await t('a column of nothing but merged PRs is not labelled MERGES FIRST', () => {
  // It has no merge in its future. Predicting one for finished work would be
  // the same mistake as drawing it as work still to do.
  const g = buildGraph([sp(491, [done(S, 400)])]);
  g.layout = layoutGraph(g);
  assert.deepEqual(g.layout.columns.map(c => c.label), ['ALREADY MERGED', 'MERGES LAST']);
  assert.equal(g.layout.columns[0].sub, 'this part is done');
  assert.match(page(g), /<g class="colhead done">/);
});
await t('...but one open PR in that column is enough to keep the ordinary label', () => {
  const g = buildGraph([sp(491, [done(S, 400), edge(S, 504)]), sp(504)]);
  g.layout = layoutGraph(g);
  assert.deepEqual(g.layout.columns.map(c => c.label), ['MERGES FIRST', 'MERGES LAST']);
  assert.equal(g.layout.columns[0].allMerged, false);
});
await t('columnLabel says it plainly on its own', () => {
  assert.deepEqual(columnLabel(0, 2, 3, true, true), {
    label: 'ALREADY MERGED',
    sub: 'this part is done',
    note: '3 PRs · any order'
  });
  assert.equal(columnLabel(0, 2, 3, true, false).label, 'MERGES FIRST');
});

console.log('the merged trail and the component rule');
await t("a merged PR by another author keeps 'not yours' AND gains the merged marking", () => {
  const g = buildGraph(
    [sp(2222, [done('snapshot-labs/sx-monorepo', 2219, { author: 'wa0x6e', foreign: true })],
      'snapshot-labs/sx-monorepo')],
    mine
  );
  g.layout = layoutGraph(g);
  const html = page(g);
  assert.match(html, /@wa0x6e — not yours to merge/, 'the authorship marking survives being merged');
  assert.match(html, /<g class="node dep st-merged">/, 'filled by state...');
  assert.match(html, /<text class="st"[^>]*>● merged<\/text>/, '...and it says merged');
  assert.match(html, /<tspan class="g">◇<\/tspan> @wa0x6e<\/text>/, 'AND whose it is');
  assert.match(html, /\.node\.dep \.box\{stroke-dasharray:4 3\}/,
    'so it stays dashed: merged does not make a colleague\'s PR yours');
  assert.match(html, /already merged — drawn because something here still depends on it/);
});
await t('...and it is never kind:own, so it is not counted as an open PR', () => {
  // A merged card CAN be the leftmost thing in the picture under the component
  // rule, and that is fine. What it can never be is one of the author's OPEN
  // PRs: `own` is what carries CI and what the total at the top counts.
  const p = sp(2222, [done('snapshot-labs/sx-monorepo', 2219, { author: 'wa0x6e', foreign: true })],
    'snapshot-labs/sx-monorepo');
  const g = buildGraph([p], mine);
  const [group] = groupNodes(g);
  assert.deepEqual(group.mine.map(n => n.number), [2222]);
  assert.deepEqual(group.referenced.map(n => n.number), [2219]);
  assert.equal(group.count, 1, 'a merged prerequisite is not counted in the open set');
  assert.equal(at(g, 'snapshot-labs/sx-monorepo#2219').kind, 'dep');
  assert.match(page(g), /1 open PR/);
});
await t('a merged trail node joins the component of the PR that needs it', () => {
  // The trail is expanded BEFORE components are pruned, so a merged chain is
  // part of the component it hangs off rather than a stray piece of its own.
  const g = buildGraph([sp(491, [done(S, 400)])], mine, [trailOf(S, 400, [done(S, 300)])]);
  assert.equal(componentsOf(g.nodes).length, 1, 'one component, four links long');
  assert.deepEqual(g.pruned, []);
  assert.deepEqual(
    componentsOf(g.nodes)[0].map(n => n.number).sort((a, b) => a - b),
    [300, 400, 491]
  );
});
await t('NEGATIVE: a merged trail in a component with none of mine is dropped whole', () => {
  // The component rule outranks the trail rule. A merged chain hanging off
  // somebody else's unrelated PR is not a reason to draw either of them.
  const notMine = { author: 'someone-else', foreign: true };
  const theirs = sp(900, [done(S, 800, notMine)], S);
  theirs.author = 'someone-else';
  const g = buildGraph([sp(491), theirs], mine, [trailOf(S, 800, [done(S, 700, notMine)])]);
  assert.deepEqual(g.nodes.map(n => n.number), [491]);
  assert.deepEqual(g.pruned, [`${S}#700`, `${S}#800`, `${S}#900`].sort());
});
await t('...but a merged PR of MINE anchors its component, like any PR of mine', () => {
  // Wan's rule is "one node from the graph is yours", and a PR I merged is
  // mine. In the real build this cannot widen anything, because the trail is
  // only walked from edges of a graph that has already been pruned.
  const theirs = sp(900, [done(S, 800)], S);
  theirs.author = 'someone-else';
  const g = buildGraph([theirs], mine);
  assert.deepEqual(g.nodes.map(n => n.number).sort((a, b) => a - b), [800, 900]);
  assert.deepEqual(g.pruned, []);
});
await t('a merged PR of MINE on the trail is referenced, never listed as open work', () => {
  // It is mine, so it is not badged "not yours" -- but it is merged, so it is
  // not one of my OPEN PRs either, and the open count must not move.
  const g = buildGraph([sp(491, [done(S, 400)])], mine);
  const [group] = groupNodes(g);
  assert.deepEqual(group.mine.map(n => n.number), [491]);
  assert.deepEqual(group.referenced.map(n => n.number), [400]);
  assert.equal(group.count, 1);
  assert.doesNotMatch(page(g), /not yours · @tony8713/);
});
await t('a merged PR reached only through the trail is still never a root', () => {
  const g = buildGraph([sp(491, [done(S, 400)])], mine, [trailOf(S, 400, [done(S, 300)])]);
  const [group] = groupNodes(g);
  assert.equal(group.count, 1, 'still one open PR');
  assert.deepEqual(group.referenced.map(n => n.number), [300, 400]);
  assert.ok(group.referenced.every(n => n.kind === 'dep'));
});
await t('a withheld PR reached only through the trail is still counted', () => {
  const r = accountWithheld(
    [wh('snapshot-labs/laser', 86, 'tony8713')],
    [sp(491, [done(S, 400)])],
    mine,
    [edge('snapshot-labs/laser', 86, { crossRepo: true })]
  );
  assert.deepEqual([r.count, r.referenced, r.blocking], [1, 1, 1]);
});
await t('NEGATIVE: the merged trail prints no private repo name anywhere', () => {
  const g = buildGraph([sp(491, [done(S, 400)])], mine, [
    trailOf(S, 400, [
      done('snapshot-labs/a-private-repo', 9, { crossRepo: true, title: null, author: null, hidden: true })
    ])
  ]);
  g.layout = layoutGraph(g);
  const html = page(g);
  assert.ok(at(g, 'snapshot-labs/a-private-repo#9'), 'the node exists');
  assert.doesNotMatch(html, /a-private-repo#9/, 'but never as a ref');
  assert.match(html, /<text class="ref" [^>]*>#9<\/text>/, 'the box shows the number only');
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
  const onCard = [...html.matchAll(/<text class="(?:ref|ttl|mark|st)[^"]*"[^>]*>(.*?)<\/text>/g)]
    .map(m => m[1])
    .join(' | ');
  assert.doesNotMatch(onCard, /red on its own|CI/, `card face reads: ${onCard}`);
  assert.doesNotMatch(html, /also failing on master/, 'and the verbose failure list is gone');
  assert.match(onCard, /◌ draft/, 'draft is on the card face, because it is what the fill means');
  assert.match(
    html,
    /<title>score-api#1453 — pr 1453 — draft, not yet marked ready for review — red on its own/,
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
// The page is the graph. Everything that is not the drawing, or the minimum
// needed to read the drawing, is behind a <summary> -- present for whoever needs
// it, not competing with the picture for the reader's attention.
//
// "Visible" here means what a browser paints before anything is clicked: the
// content outside every <details>, PLUS each block's own <summary>, because a
// closed block still renders its summary. Nothing nests, so the non-greedy match
// is exact -- and one of these tests pins that no-nesting assumption, since a
// nested block would silently make every other test in this section lie.
const fold = html =>
  html.replace(/<details\b[^>]*>([\s\S]*?)<\/details>/g, (m, inner) => {
    const s = inner.match(/<summary>[\s\S]*?<\/summary>/);
    return s ? s[0] : '';
  });
const summariesOf = html =>
  [...html.matchAll(/<summary>([\s\S]*?)<\/summary>/g)].map(m => m[1].replace(/<[^>]*>/g, '').trim());
// The visible words, not counting the drawing's own text (column headers and
// card titles are the picture, not prose about it).
const visibleWords = html =>
  fold(html)
    .replace(/<svg[\s\S]*?<\/svg>/g, ' ')
    .replace(/<head[\s\S]*?<\/head>/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .split(/\s+/)
    .filter(Boolean).length;

console.log('the graph is the page; everything else is behind a summary');
await t('the drawing itself is never inside a collapsed block', () => {
  const html = page(buildGraph([sp(491, [edge(S, 504)]), sp(504)]));
  const visible = fold(html);
  assert.match(visible, /<svg class="depgraph"/, 'the graph is above the fold');
  assert.match(visible, /<h1>Open PRs — merge left to right<\/h1>/, 'and so is the heading');
  assert.match(visible, /<figcaption>/, 'and its caption');
  assert.match(visible, /class="legend"/, 'and the key to its marks');
});
await t('the DIRECTION label is visible without opening anything', () => {
  // An unlabelled dependency graph is ambiguous, and that has been the recurring
  // complaint on this page. Collapsing the long explainer must not take the one
  // sentence that says which way to read the picture with it.
  const visible = fold(page(buildGraph([sp(491, [edge(S, 504)]), sp(504)])));
  assert.match(visible, /<strong>Merge order reads left to right\.<\/strong>/, 'in the caption');
  assert.match(visible, /A PR sits to the right of everything it\s*needs/);
  assert.match(visible, /<span class="k">left to right<\/span> merge order/, 'and in the legend');
  assert.match(visible, /MERGES FIRST/, 'and on the column headers of the drawing');
  assert.match(visible, /MERGES LAST/);
});
await t('the no-order-within-a-column fact is visible too, not folded away', () => {
  const visible = fold(page(buildGraph([sp(491, [edge(S, 504)]), sp(504), sp(457)])));
  assert.match(visible, /Two PRs in the same column have\s*no order between them/, 'caption');
  assert.match(visible, /<span class="k">same column<\/span> one rank — no order between them/);
  assert.match(visible, /2 PRs · any order/, 'and on the column header itself');
});
await t('what a card FILL means is visible, since colour is a legend or it is nothing', () => {
  const visible = fold(page(buildGraph([sp(491, [edge(S, 504)]), sp(504)])));
  assert.match(visible, /<span class="k">card fill<\/span> the state of the PR/);
  for (const s of ['open', 'draft', 'merged'])
    assert.match(visible, new RegExp(`<span class="sw st-${s}">`), `${s} is keyed above the fold`);
});
await t('what an EDGE means is visible: the arrow, the dash, and both edge labels', () => {
  const visible = fold(page(buildGraph([sp(491, [edge(S, 504)]), sp(504)])));
  assert.match(visible, /<span class="k">arrow<\/span> merge the tail before the head/);
  assert.match(visible, /<span class="k">dashed line<\/span> crosses repos/);
  assert.match(visible, /GATED<\/span> release-gated/);
  assert.match(visible, /✓ MET<\/span> that prerequisite has already landed/);
});
await t('the explainer, the syntax help and the methodology are all COLLAPSED', () => {
  const html = page(buildGraph([sp(491, [edge(S, 504)]), sp(504)]));
  const visible = fold(html);
  // still on the page in full -- collapsed, never deleted
  assert.match(html, /Read the graph left to right\. A PR sits to the right of the things it needs\./);
  assert.match(html, /Order is the horizontal axis only\./);
  assert.match(html, /Depends on release of snapshot-labs\/snapshot\.js#1225/);
  assert.match(html, /Merge order runs left to right/);
  // and none of it competes with the drawing
  assert.doesNotMatch(visible, /Order is the horizontal axis only\./, 'the explainer is folded');
  assert.doesNotMatch(visible, /Depends on release of/, 'the declaration syntax is folded');
  assert.doesNotMatch(visible, /Merge order runs left to right/, 'the methodology is folded');
  assert.doesNotMatch(visible, /Whole chains are drawn/, 'and the component rule with it');
  assert.deepEqual(summariesOf(html), [
    'How to read this graph',
    'Declaring a prerequisite (the syntax this page reads)',
    'How this page is built'
  ]);
});
await t('every collapsed block carries a summary, and no block nests inside another', () => {
  const html = page(buildGraph([sp(491, [edge(S, 504)]), sp(504)]));
  assert.equal(
    occurrences(html, '<details'),
    summariesOf(html).length,
    'a block with no summary would be a block with no handle to open it'
  );
  assert.equal(occurrences(html, '<details'), occurrences(html, '</details>'));
  // Nesting would break the strip above, and with it every claim in this section.
  const flat = html.replace(/<details\b[^>]*>[\s\S]*?<\/details>/g, '');
  assert.doesNotMatch(flat, /<details|<\/details>|<summary>/, 'no block survives one strip');
});
await t('the withheld notice is FOLDED, not deleted, and its count survives being shut', () => {
  // It exists so the page admits it is not showing everything. An admission that
  // only appears once you open something is not an admission, so the number goes
  // in the summary and the accounting goes inside.
  const g = buildGraph([sp(491)]);
  const html = render({
    graph: g,
    author: 'tony8713',
    org: 'snapshot-labs',
    generatedAt: '2026-01-01T00:00:00Z',
    withheld: { count: 2, referenced: 0, blocking: 0 },
    total: 1
  });
  assert.match(html, /<summary>2 PRs withheld from this page<\/summary>/);
  assert.match(fold(html), /2 PRs withheld from this page/, 'the count is legible while shut');
  assert.match(html, /<strong>2 PRs withheld\.<\/strong>/, 'the notice itself is still there');
  assert.match(html, /INCLUDE_PRIVATE=true/);
  assert.match(html, /does not pretend the work does not exist/);
  assert.doesNotMatch(fold(html), /INCLUDE_PRIVATE=true/, 'but the accounting is folded');
});
await t('an edge that cannot be drawn also keeps its count in the summary', () => {
  const html = page(buildGraph([sp(1, [edge(S, 2)]), sp(2, [edge(S, 3)]), sp(3, [edge(S, 2)])]));
  assert.match(html, /<summary>1 declared dependency is not drawn as an arrow<\/summary>/);
  assert.match(fold(html), /1 declared dependency is not drawn as an arrow/);
  assert.match(html, /<strong>1 declared dependency closes a cycle<\/strong>/);
  assert.doesNotMatch(fold(html), /Nothing declared is dropped/, 'the detail is folded');
});
await t('collapsing cost the page NO runtime: it is native markup, not a widget', () => {
  const html = page(buildGraph([sp(491, [edge(S, 504)]), sp(504)]));
  assert.doesNotMatch(html, /<script/i, 'no script tag was added to open a block');
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i, 'and no inline handler either');
  assert.doesNotMatch(html, /aria-expanded|role="button"|tabindex/, 'no hand-rolled disclosure');
  assert.match(html, /<details class="fold"/, 'the browser does it');
});
await t('the page still reads with the stylesheet stripped', () => {
  // <details> is collapsed by the BROWSER, not by this stylesheet, so stripping
  // the CSS does not spill the prose back over the drawing -- and if a reader's
  // browser did render every block open, that is acceptable: the content is
  // ordered so the graph still comes first.
  const html = page(buildGraph([sp(491, [edge(S, 504)]), sp(504)]));
  const nocss = html.replace(/<style[\s\S]*?<\/style>/g, '');
  assert.doesNotMatch(nocss, /display:none|visibility:hidden/, 'nothing was hidden with CSS');
  assert.match(nocss, /<summary>How to read this graph<\/summary>/, 'the handles survive');
  assert.match(nocss, /<rect class="box" x="\d+"/, 'and the drawing keeps its geometry');
  assert.match(nocss, /stroke="currentColor"/, 'which is presentational attributes, not CSS');
  assert.ok(
    html.indexOf('<svg class="depgraph"') < html.indexOf('<details'),
    'the graph precedes every collapsed block in source order, so it is first either way'
  );
});
await t('the prose competing with the drawing is a fraction of what it was', () => {
  // The measured form of the complaint. The page carried ~1750 visible words
  // above the drawing and around it; what is left is the heading, one caption,
  // the key to the marks, and four summaries.
  const html = page(buildGraph([sp(491, [edge(S, 504)]), sp(504)]));
  const words = visibleWords(html);
  assert.ok(words < 200, `${words} visible words`);
  assert.ok(words > 60, `${words} visible words -- the legend must not have been gutted either`);
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
  assert.match(html, /<g class="node dep st-open">/, 'on a dashed card, filled by its state');
  assert.match(
    html,
    /<span class="k">dashed card<\/span> not one of tony8713's open PRs/,
    'and the dash means referenced, which covers a merged prerequisite of his own too'
  );
  assert.match(html, /@wa0x6e — not yours to merge/, 'and the card title says what it means');
  assert.match(
    html,
    /<span class="k">◇ @handle<\/span> whose PR it is, when it is not tony8713's to merge/,
    'and the legend explains the glyph'
  );
  assert.doesNotMatch(html, /not yours · @wa0x6e/, 'the long form is gone');
});
// A tracked bot's card is the third value of the "whose work is this" channel:
// solid = the page author's, dotted = a tracked bot's, dashed = in the way. The
// dash pattern is the SECOND carrier -- every card that is not the page author's
// still prints `◇ @handle` -- so none of this rests on telling one dotted line
// from one dashed line, and none of it rests on colour, which the fill owns.
const botPage = (graph, over = {}) =>
  render({
    graph,
    author: 'tony8713',
    org: 'snapshot-labs',
    generatedAt: '2026-01-01T00:00:00Z',
    withheld: { count: 0, referenced: 0, blocking: 0 },
    total: graph.nodes.filter(n => n.kind === 'own').length,
    bots: ['chai3-bot'],
    botTotal: graph.nodes.filter(n => n.kind === 'bot').length,
    ...over
  });
await t("a tracked bot's card is DOTTED, marked ◇ @handle, and keyed in the legend", () => {
  const g = botGraph([pr(9, 'tony8713', [300]), pr(300, 'chai3-bot')]);
  const html = botPage(g);
  assert.match(html, /<g class="node bot st-open">/, 'its own class, so its own outline');
  assert.match(html, /svg\.depgraph \.node\.bot \.box\{stroke-dasharray:1 3\}/, 'dotted');
  assert.match(html, /svg\.depgraph \.node\.dep \.box\{stroke-dasharray:4 3\}/, 'dashed is still dashed');
  assert.match(html, /<tspan class="g">◇<\/tspan> @chai3-bot<\/text>/, 'and it still names its author');
  assert.match(
    html,
    /<span class="k">dotted card<\/span> a tracked bot's open PR \(@chai3-bot\) — scheduled here like tony8713's own/,
    'a mark on the canvas is a legend entry or it is nothing'
  );
});
await t("a tracked bot's PR is NOT counted in the page author's open-PR total", () => {
  const g = botGraph([pr(9, 'tony8713'), pr(300, 'chai3-bot'), pr(301, 'chai3-bot')]);
  const html = botPage(g);
  assert.match(html, /1 open PR ·/, 'one of mine, not three');
  assert.match(html, /2 more by @chai3-bot/, 'and the bot count is stated, not folded in');
});
await t('the page says a bot PR is here to be scheduled, not because it is in the way', () => {
  const html = botPage(botGraph([pr(9, 'tony8713'), pr(300, 'chai3-bot')]));
  assert.match(html, /A tracked bot's PR is dotted, not dashed/);
  assert.match(html, /<strong>Tracked bots\.<\/strong>/);
  assert.match(html, /There is no rule on this page\s*about <em>where<\/em> a card may sit/);
  assert.match(html, /A bot's PR in a private repo is withheld and counted in the notice above/);
});
await t('NEGATIVE: with no tracked bot the page says nothing about one', () => {
  const html = page(buildGraph([sp(491, [edge(S, 504)]), sp(504)]));
  assert.doesNotMatch(html, /dotted card|tracked bot|chai3-bot/);
  assert.match(html, /A chain with none of tony8713's PRs in it is\s*not drawn at all/);
});
await t('the text alternative names a tracked bot as one, not just as somebody else', () => {
  const g = botGraph([pr(9, 'tony8713', [300]), pr(300, 'chai3-bot'), pr(901, 'wa0x6e', [9])]);
  layoutGraph(g);
  assert.equal(descRef(at(g, `${SX}#300`)), 'sx-monorepo#300 (by @chai3-bot, a tracked bot)');
  assert.equal(descRef(at(g, `${SX}#901`)), "sx-monorepo#901 (by @wa0x6e, not the page author's)");
  const desc = graphDesc(g);
  assert.match(desc, /belongs to the page author or to a tracked bot/);
  assert.match(desc, /A tracked bot's pull request is named as one/);
  assert.doesNotMatch(graphDesc(buildGraph([sp(491)])), /tracked bot/, 'and only when one is drawn');
});
await t("a tracked bot's card carries CI on hover, exactly as the page author's does", () => {
  const p = pr(300, 'chai3-bot');
  p.ci = { state: 'own-red', ownFailures: [{ name: 'Test' }], baseFailures: [], pending: [], total: 1, passed: 0 };
  const html = botPage(botGraph([pr(9, 'tony8713'), p]));
  assert.match(html, /<title>sx-monorepo#300 — pr 300 — open, and marked ready for review — red on its own/);
  assert.match(html, /@chai3-bot — a tracked bot's PR, drawn and scheduled like the page author's/);
});
await t("a release gate on a bot PR's edge is drawn like any other", () => {
  // Release gating is a property of the EDGE, not of who wrote either end, and
  // this pins that it stays that way with a bot on one end.
  const g = botGraph([
    pr(300, 'chai3-bot', [
      { number: 1225, repo: JS, crossRepo: true, needsRelease: true, satisfied: false, status: 'merged, awaiting release', merged: true, targetState: 'merged' }
    ]),
    pr(9, 'tony8713', [300])
  ]);
  const html = botPage(g);
  assert.match(html, /GATED/, 'the gate is on the arrow into the bot\'s card');
  assert.match(html, /release-gated: satisfied by a published release, not by a merge/);
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
  assert.equal(occurrences(html, '<g class="node dep '), 2, 'and both cards dashed');
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

console.log('a card is a link, and it opens in a new tab');
// Cheap assertions on purpose: target/rel are exactly the kind of attribute a
// later refactor of the card markup drops without anything else going wrong, so
// the page is checked as a whole rather than one hand-picked card.
const anchorTags = html => html.match(/<a\b[^>]*>/g) || [];
await t('every card link carries target="_blank" and rel="noopener"', () => {
  const html = page(buildGraph([sp(1, [edge(S, 3)]), sp(2, [edge(S, 3)]), sp(3), sp(1225, [], JS)]));
  const tags = anchorTags(html);
  assert.equal(tags.length, 4, 'one link per card');
  for (const tag of tags) {
    assert.match(tag, /^<a href="https:\/\/github\.com\/[^"]+"/, 'an SVG 2 href, not xlink:href');
    assert.match(tag, /\btarget="_blank"/, `${tag} opens in a new tab`);
    assert.match(tag, /\brel="noopener"/, `${tag} does not hand over a window handle`);
  }
});
await t('NO link anywhere on the page opens in this tab, card or not', () => {
  // Whole-page, so a link added later outside the graph -- in the prose, the
  // legend, the withheld notice -- has to carry them too or this fails.
  const html = render({
    graph: buildGraph([sp(491, [edge(S, 504)]), sp(504)]),
    author: 'tony8713',
    org: 'snapshot-labs',
    generatedAt: '2026-01-01T00:00:00Z',
    withheld: { count: 2, referenced: 0, blocking: 1 },
    total: 1
  });
  const tags = anchorTags(html);
  assert.ok(tags.length >= 2, 'there are links to check');
  assert.equal(
    tags.filter(tag => /\btarget="_blank"/.test(tag) && /\brel="noopener"/.test(tag)).length,
    tags.length,
    `every one of the ${tags.length} links on the page: ${tags.filter(tag => !/target/.test(tag))}`
  );
  assert.doesNotMatch(html, /xlink:href/, 'and none of them is an SVG 1.1 xlink link');
});
await t('a withheld card is still not a link at all, target or no target', () => {
  const P = 'snapshot-labs/a-private-repo';
  const g = buildGraph([sp(491, [edge(P, 86, { crossRepo: true, title: null, author: null, hidden: true })])]);
  const html = page(g);
  const tags = anchorTags(html);
  assert.equal(tags.length, 1, 'the visible card is linked, the withheld one is not');
  assert.match(tags[0], /stamp\/pull\/491/);
  assert.doesNotMatch(html, /a-private-repo/, 'nothing new leaked the repo name into a link');
});

console.log('the fill is the state, said in a colour AND in a word');

// A prerequisite that is not one of the open PRs becomes a dep node, which is
// the only way anything merged reaches this page.
const mergedEdge = (repo, number, over = {}) =>
  edge(repo, number, { targetState: 'merged', satisfied: true, status: 'merged', ...over });
const draftPr = (number, repo = 'snapshot-labs/sx-monorepo') => {
  const p = sp(number, [], repo);
  p.draft = true;
  return p;
};

await t('an open PR is filled open; a draft is filled draft', () => {
  const g = buildGraph([sp(504), draftPr(2266)]);
  assert.equal(nodeState(at(g, `${S}#504`)).state, 'open');
  assert.equal(nodeState(at(g, 'snapshot-labs/sx-monorepo#2266')).state, 'draft');
});
await t('...and the state the build derived wins over the raw flag', () => {
  const p = sp(1);
  p.draft = false;
  p.state = 'draft';
  assert.equal(nodeState(at(buildGraph([p]), `${S}#1`)).state, 'draft');
});
await t('the card carries the fill CLASS, the glyph AND the word, never the colour alone', () => {
  const g = buildGraph([sp(504), draftPr(2266), sp(491, [mergedEdge(S, 457)])]);
  const html = page(g);
  assert.match(html, /<g class="node own st-draft">/, 'the draft card is classed draft');
  assert.match(html, /<g class="node own st-open">/);
  assert.match(html, /<g class="node dep st-merged">/);
  assert.equal(occurrences(html, '<text class="st"'), g.nodes.length, 'every card says its state');
  assert.match(html, /<text class="st"[^>]*>◌ draft<\/text>/, 'glyph and word, on the card');
  assert.match(html, /<text class="st"[^>]*>○ open<\/text>/);
  assert.match(html, /<text class="st"[^>]*>● merged<\/text>/);
  assert.match(html, /svg\.depgraph \.st-draft \.box\{fill:var\(--state-draft\)/, 'and it is themed');
});
await t('the state word sits opposite the ref and never crowds it out', () => {
  // The longest ref in the real set. If it survives uncut beside the state,
  // every shorter one does.
  const p = sp(368, [], 'snapshot-labs/snapshot-relayer');
  const c = cardOf(at(buildGraph([p]), 'snapshot-labs/snapshot-relayer#368'));
  assert.equal(c.ref, 'snapshot-relayer#368', 'not truncated');
  assert.equal(c.stateText, '○ open');
  const room = NODE_W - 20;
  assert.ok(
    textWidth(c.ref, 10.5, true) + textWidth(c.stateText, 9.5) <= room,
    'the two fit on one line together'
  );
});
await t('hovering a card names its state in a whole sentence', () => {
  const g = buildGraph([draftPr(2266)]);
  const n = at(g, 'snapshot-labs/sx-monorepo#2266');
  assert.match(nodeTitleText(n), /— draft, not yet marked ready for review —/);
  assert.match(page(g), /— draft, not yet marked ready for review —/);
});

console.log('a merged PR is drawn only as a prerequisite that has landed');
await t('a merged prerequisite is one dep card, to the LEFT of what it unblocked', () => {
  const g = buildGraph([sp(491, [mergedEdge(S, 457)])]);
  const n = at(g, `${S}#457`);
  assert.equal(n.kind, 'dep', 'never a card of its own');
  assert.equal(nodeState(n).state, 'merged');
  assert.deepEqual(neededBy(n), [`${S}#491`], 'it is on the tail of an edge');
  assert.equal(n.rank, 0);
  assert.equal(at(g, `${S}#491`).rank, 1, 'so it sits in an earlier column');
  assert.deepEqual(mergedNonPrerequisites(g), []);
});
await t("the build FAILS rather than draw a merged PR that is nobody's prerequisite", () => {
  // The rule is asserted, not left to the search string: this page lists open
  // PRs, and the one reason to draw a merged one is that something still open
  // is waiting on it.
  const stray = sp(457);
  stray.state = 'merged';
  assert.deepEqual(mergedNonPrerequisites(buildGraph([stray])), [`${S}#457`]);
  const own = sp(491, [mergedEdge(S, 457)]);
  own.state = 'merged';
  assert.deepEqual(mergedNonPrerequisites(buildGraph([own])), [`${S}#491`]);
});
await t('NEGATIVE: none of the open PRs is ever filled merged or closed', () => {
  const g = buildGraph([sp(491, [mergedEdge(S, 457)]), sp(504), draftPr(2266)]);
  for (const n of g.nodes.filter(x => x.kind === 'own')) {
    assert.ok(['open', 'draft'].includes(nodeState(n).state), `${n.key} is ${nodeState(n).state}`);
  }
});
await t('the arrow leaving a landed prerequisite says it is cleared', () => {
  const g = buildGraph([sp(491, [mergedEdge(S, 457)])]);
  g.layout = layoutGraph(g);
  const html = page(g);
  assert.match(html, /<path class="edge met"/, 'the arrow is toned down');
  assert.match(html, /<text class="elabel met"[^>]*>✓ MET<\/text>/, 'and says so in words');
  assert.match(html, /<span class="k met">✓ MET<\/span> that prerequisite has already landed/);
});
await t('MERGED DOES NOT MEAN CLEARED: a release-gated prerequisite is both', () => {
  // The one case the colour could be misread. The card is filled merged because
  // that is what the PR is; the EDGE is still unsatisfied, and says so.
  const gated = mergedEdge(JS, 1225, {
    crossRepo: true,
    needsRelease: true,
    satisfied: false,
    status: 'merged, awaiting release'
  });
  const g = buildGraph([sp(491, [gated])]);
  g.layout = layoutGraph(g);
  const n = at(g, `${JS}#1225`);
  assert.equal(nodeState(n).state, 'merged', 'the PR is merged');
  assert.equal(g.edges[0].edge.satisfied, false, 'and the dependency is still not satisfied');
  const html = page(g);
  assert.match(html, /st-merged/);
  assert.match(html, />GATED</);
  assert.match(html, /merged, awaiting release/);
  assert.doesNotMatch(html, /<text class="elabel met"/, 'the arrow is NOT drawn as cleared');
  assert.doesNotMatch(html, /ready to merge|safe to merge/i);
});
await t('an edge that is both released and met keeps BOTH labels, apart', () => {
  const released = mergedEdge(JS, 1225, {
    crossRepo: true,
    needsRelease: true,
    satisfied: true,
    status: 'released in v0.14.3'
  });
  const g = buildGraph([sp(491, [released])]);
  g.layout = layoutGraph(g);
  const html = page(g);
  const gatedY = Number(html.match(/<text class="elabel" x="\d+" y="(\d+)"/)[1]);
  const metY = Number(html.match(/<text class="elabel met" x="\d+" y="(\d+)"/)[1]);
  assert.ok(metY > gatedY + 10, `the two labels do not overlap (${gatedY} vs ${metY})`);
  assert.match(html, />GATED</);
});

console.log('the legend and the text alternative say what the fill means');
await t('open, draft and merged are always keyed, with swatch and glyph and word', () => {
  const html = page(buildGraph([sp(504)]));
  assert.match(html, /<span class="k">card fill<\/span> the state of the PR/);
  assert.match(html, /<span class="sw st-open">○<\/span>open<\/span>/);
  assert.match(html, /<span class="sw st-draft">◌<\/span>draft<\/span>/);
  assert.match(html, /<span class="sw st-merged">●<\/span>merged — a prerequisite that has already landed<\/span>/);
  assert.match(html, /The colour a card is filled with is the state of that PR/, 'and the banner');
});
await t('closed is keyed only when something on the page is closed', () => {
  assert.doesNotMatch(page(buildGraph([sp(504)])), /class="sw st-closed"/);
  const dead = buildGraph([
    sp(491, [edge(S, 457, { targetState: 'closed', status: 'closed unmerged' })])
  ]);
  assert.match(page(dead), /<span class="sw st-closed">✕<\/span>closed/);
});
await t('the <desc> explains the fill and names every state that is not open', () => {
  // With the per-PR list gone, this IS the text form of the page.
  const g = buildGraph([sp(504), draftPr(2266), sp(491, [mergedEdge(S, 457)])]);
  layoutGraph(g);
  const desc = graphDesc(g);
  assert.match(desc, /The fill colour of a card is the state of that pull request/);
  assert.match(desc, /every card also prints that state as a word/);
  assert.match(desc, /only merged pull requests drawn are prerequisites that have already landed/);
  assert.match(desc, /sx-monorepo#2266 \(draft\)/, 'a draft is named as one');
  assert.match(desc, /stamp#457 \(merged\)/, 'and so is a merged prerequisite');
  assert.doesNotMatch(desc, /stamp#504 \(open\)/, 'open is the usual case and stays unmarked');
  assert.match(desc, /stamp#457 before stamp#491, already met/, 'and the edge says it is cleared');
});

console.log('CI is off the card face entirely, and colour means one thing');
await t('CI keeps its wording on hover and takes no room on the card', () => {
  const red = sp(1453, [], 'snapshot-labs/score-api');
  red.ci = { state: 'own-red', ownFailures: [{ name: 'Test' }], baseFailures: [], pending: [], total: 1, passed: 0, baseRef: 'master' };
  const html = page(buildGraph([red]));
  assert.match(html, /<title>score-api#1453 — pr 1453 — open, and marked ready for review — red on its own/);
  const faces = [...html.matchAll(/<text class="(ttl|st|mark|ref)"[^>]*>([^<]*)</g)].map(m => m[2]);
  assert.ok(!faces.some(f => /red on its own/.test(f)), 'not printed on the card itself');
});
await t('nothing but the state is coloured on the canvas', () => {
  const html = page(buildGraph([sp(504)]));
  assert.doesNotMatch(html, /svg\.depgraph \.is-(good|warning|serious|critical)/);
  assert.doesNotMatch(html, /CI_SHORT|CI_ROLE|CI_GLYPH/);
});

console.log('the fills are distinguishable, in light mode and in dark');
const stateVars = block =>
  Object.fromEntries(
    [...block.matchAll(/--state-([a-z-]+):\s*(#[0-9a-f]{3,8})/g)].map(m => [m[1], m[2]])
  );
await t('all four states are themed in BOTH schemes, fill and border', () => {
  const html = page(buildGraph([sp(504)]));
  const [light, dark] = html.split('@media (prefers-color-scheme:dark)');
  assert.ok(dark, 'there is a dark block');
  for (const [name, vars] of [['light', stateVars(light)], ['dark', stateVars(dark)]]) {
    for (const s of ['open', 'draft', 'merged', 'closed']) {
      assert.ok(vars[s], `${name}: ${s} has a fill`);
      assert.ok(vars[`${s}-line`], `${name}: ${s} has a border`);
      assert.notEqual(vars[s], vars[`${s}-line`], `${name}: ${s} fill and border differ`);
    }
    const fills = ['open', 'draft', 'merged', 'closed'].map(s => vars[s]);
    assert.equal(new Set(fills).size, 4, `${name}: no two states share a fill`);
    const lines = ['open', 'draft', 'merged', 'closed'].map(s => vars[`${s}-line`]);
    assert.equal(new Set(lines).size, 4, `${name}: no two states share a border`);
  }
});
await t('dark mode is re-themed, not the light wash left to fend for itself', () => {
  const html = page(buildGraph([sp(504)]));
  const [light, dark] = html.split('@media (prefers-color-scheme:dark)');
  const l = stateVars(light);
  const d = stateVars(dark);
  for (const s of ['open', 'draft', 'merged', 'closed']) {
    assert.notEqual(l[s], d[s], `${s} has its own dark fill`);
  }
});

// --- the two edge sources, against a fake GitHub -------------------------
//
// A stacked PR now says in words what its base ref already says, so both edge
// sources speak about the same pair and the build has to emit ONE edge. Then the
// parent merges, GitHub retargets the child onto master, and the base ref is
// gone -- so the declaration is the only thing left, and the same pair has to
// keep drawing. The second case cannot be built out of open PRs at all, which is
// why this stubs the API rather than reaching for one.
console.log('a declared stack and a computed one are one edge');

const respond = data => ({
  ok: true,
  status: 200,
  headers: { get: () => null },
  json: async () => data
});
const missing = { ok: false, status: 404, headers: { get: () => null } };
const withFakeGitHub = async (open, byNumber, fn) => {
  const real = globalThis.fetch;
  globalThis.fetch = async url => {
    const u = String(url);
    const one = u.match(/\/pulls\/(\d+)(?:\?|$)/);
    if (one) return byNumber[one[1]] ? respond(byNumber[one[1]]) : missing;
    if (/\/pulls\?state=open/.test(u)) return respond(/page=1(?:&|$)/.test(u) ? open : []);
    throw new Error(`the fake GitHub was asked for something it does not serve: ${u}`);
  };
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
};
const pull = (repo, number, over = {}) => ({
  number,
  title: `pr ${number}`,
  html_url: `https://github.com/${repo}/pull/${number}`,
  user: { login: 'wa0x6e' },
  draft: false,
  state: 'open',
  merged_at: null,
  body: '',
  head: { ref: `feat/branch-${number}`, sha: `sha-${number}`, repo: { full_name: repo } },
  base: { ref: 'master', repo: { full_name: repo, private: false } },
  ...over
});
const openRepo = name => new Map([[name, { name, private: false, defaultBranch: 'master' }]]);

await t('declared AND computed on the same pair is one edge, and the stack wins', async () => {
  const R = 'fake/both-sources';
  const parent = pull(R, 10, { head: { ref: 'feat/parent', sha: 's10', repo: { full_name: R } } });
  const child = pull(R, 11, {
    user: { login: 'tony8713' }, // mine, so the component rule keeps the chain
    base: { ref: 'feat/parent', repo: { full_name: R, private: false } },
    body: 'Stacked on top of #10 (`feat/parent`) — review/merge that first.'
  });
  const rec = prRecord(child, R, { private: false });
  await withFakeGitHub([parent, child], { 10: parent, 11: child }, () =>
    resolveDeps(rec, openRepo(R))
  );
  assert.equal(rec.deps.length, 1, 'one pair, one edge');
  assert.equal(rec.deps[0].number, 10);
  assert.equal(rec.deps[0].kind, 'stack');
  assert.equal(rec.deps[0].reason, 'branched from feat/parent', 'the computed reason is kept');
  assert.equal(buildGraph([rec], mine).edges.length, 1, 'and it is drawn once');
});

await t('once the parent merges the declaration alone still draws the edge', async () => {
  // sx-monorepo#2222 -> #2219, to the letter: #2219 merged, GitHub retargeted
  // #2222 onto master within seconds, so the base ref no longer says anything
  // and #2219 is not in the open listing either. The body is all that is left.
  const R = 'fake/parent-merged';
  const parent = pull(R, 20, {
    state: 'closed',
    merged_at: '2026-08-12T09:00:00Z',
    head: { ref: 'feat/landed', sha: 's20', repo: { full_name: R } }
  });
  const child = pull(R, 21, {
    user: { login: 'tony8713' }, // mine; #20 is a colleague's, exactly as #2219 is
    body: 'Stacked on #20 — retarget to `master` after it merges.'
  });
  const rec = prRecord(child, R, { private: false });
  await withFakeGitHub([child], { 20: parent, 21: child }, () => resolveDeps(rec, openRepo(R)));

  assert.equal(rec.deps.length, 1, 'the edge survives its prerequisite merging');
  const [dep] = rec.deps;
  assert.equal(dep.kind, 'implicit', 'declared, because there is no base ref left to compute from');
  assert.equal(dep.title, 'pr 20', 'resolved by number, so it is not a bare number');
  assert.equal(dep.merged, true);
  assert.equal(dep.satisfied, true);
  assert.equal(dep.status, 'merged');
  assert.equal(dep.targetState, 'merged');
  assert.equal(dep.reason, null, 'and it is not labelled with advice that has expired');

  const g = buildGraph([rec], mine);
  g.layout = layoutGraph(g);
  const html = page(g);
  assert.equal(at(g, `${R}#20`).merged, true, 'the merged prerequisite is a card');
  assert.equal(at(g, `${R}#20`).state, 'merged');
  assert.equal(g.edges.length, 1);
  assert.match(html, /already merged — drawn because something here still depends on it/);
  assert.match(html, /<path class="edge[^"]*met"/, 'and its arrow is drawn met');
});

// --- the release label names the release that CARRIED the change ---------
//
// snapshot.js#1225 merged at 14:11, v0.15.2 shipped 41 minutes later and really
// did carry it, and v0.16.0 shipped the next morning. getReleases() hands the
// list back newest-first, so taking the first release published after the merge
// takes the NEWEST one -- and the label then moves onto whatever ships next,
// every time, for ever. `satisfied` is right either way, which is why this went
// unnoticed: only the tag on the card is wrong. Stubbed rather than live, so the
// pin cannot expire the next time snapshot.js publishes.
console.log('the release label names the release that shipped the change');

const withFakeReleases = async (rels, fn) => {
  const real = globalThis.fetch;
  globalThis.fetch = async url => {
    const u = String(url);
    if (/\/releases\?/.test(u)) return respond(rels);
    throw new Error(`the fake GitHub was asked for something it does not serve: ${u}`);
  };
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
};
const release = (tag, publishedAt) => ({
  tag_name: tag,
  published_at: publishedAt,
  draft: false,
  prerelease: false,
  html_url: `https://github.com/fake/repo/releases/tag/${tag}`
});
// newest-first, exactly the order the endpoint and getReleases() produce
const afterTheMerge = [
  release('v0.16.0', '2026-08-14T10:38:34Z'),
  release('v0.15.2', '2026-08-13T14:52:21Z'),
  release('v0.15.1', '2026-08-06T11:50:11Z')
];

await t('a later release does not steal the label from the one that shipped it', async () => {
  const r = await withFakeReleases(afterTheMerge, () =>
    resolveStatus(
      { repo: 'fake/release-order', needsRelease: true },
      { merged_at: '2026-08-13T14:11:37Z', state: 'closed' }
    )
  );
  assert.equal(r.satisfied, true, 'satisfied either way -- the verdict was never the bug');
  assert.equal(r.release.tag, 'v0.15.2', 'the EARLIEST release after the merge, not the newest');
  assert.equal(r.status, 'released in v0.15.2');
});

await t('and with nothing published since the merge it still awaits a release', async () => {
  const r = await withFakeReleases(afterTheMerge, () =>
    resolveStatus(
      { repo: 'fake/release-none-since', needsRelease: true },
      { merged_at: '2026-08-14T12:00:00Z', state: 'closed' }
    )
  );
  assert.equal(r.satisfied, false);
  assert.equal(r.status, 'merged, awaiting release');
  assert.equal(r.latestRelease.tag, 'v0.16.0', 'the newest release, which this merge missed');
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

  console.log('the fields the fill is derived from are real (live API)');
  await t('GitHub sends state, draft and merged_at as three separate fields', async () => {
    // The mapping is checked against the payload rather than against a belief
    // about it: `draft` is a real boolean, and `state` really is a two-valued
    // field with no "draft" and no "merged" in it.
    for (const number of [1225, 1222]) {
      const p = await getPr(RJS, number);
      assert.equal(typeof p.draft, 'boolean', `#${number}: draft is a field of its own`);
      assert.ok(['open', 'closed'].includes(p.state), `#${number}: state is ${p.state}`);
      assert.ok(PR_STATES.includes(prState(p)));
    }
  });
  await t('a merged PR is state "closed" plus merged_at, and maps to merged', async () => {
    const p = await getPr(RJS, 1222);
    assert.equal(p.state, 'closed', 'GitHub calls a merged PR closed');
    assert.ok(p.merged_at, 'merged_at is the field that says otherwise');
    assert.equal(prState(p), 'merged');
  });
  await t("the mapping agrees with GitHub's own `merged`, which it never reads", async () => {
    // Cross-check against the field the mapping deliberately ignores, because
    // the pulls LIST endpoint does not return it.
    for (const number of [1225, 1222, 1223]) {
      const p = await getPr(RJS, number);
      assert.equal(prState(p) === 'merged', p.merged, `#${number}`);
    }
  });
  await t('merged and satisfied are reported as the two different facts they are', async () => {
    const open = await resolveStatus({ repo: RJS, needsRelease: false }, await getPr(RJS, 1225));
    assert.deepEqual([open.merged, open.satisfied], [false, false]);
    const shipped = await resolveStatus({ repo: RJS, needsRelease: true }, await getPr(RJS, 1223));
    assert.deepEqual([shipped.merged, shipped.satisfied], [true, true]);
    // merged, and STILL in the way: this is the pair the drawing depends on.
    const gatedLive = await resolveStatus({ repo: RJS, needsRelease: true }, await getPr(RJS, 1222));
    assert.deepEqual([gatedLive.merged, gatedLive.satisfied], [true, false]);
  });

  console.log('resolving a merged target by number (live API)');
  await t('a MERGED PR that is in nobody\'s open set still resolves title, author and state', async () => {
    // The open-PR listing that stack detection uses cannot see #1222 at all --
    // it is merged. Resolving by number can, so a merged prerequisite arrives
    // with its real title instead of degrading to a bare number.
    const e = await declaredEdge({
      repo: RJS,
      number: 1222,
      crossRepo: true,
      needsRelease: false,
      reason: null,
      raw: `Depends on ${RJS}#1222`
    });
    assert.equal(e.unreadable, false);
    assert.ok(e.title && e.title.length > 0, `title resolved: ${e.title}`);
    assert.ok(e.author && e.author.length > 0, `author resolved: ${e.author}`);
    assert.equal(e.merged, true);
    assert.equal(e.satisfied, true);
    assert.equal(e.status, 'merged');
    assert.equal(e.url, `https://github.com/${RJS}/pull/1222`);
  });
  await t('and it draws as a finished card once something depends on it', async () => {
    const dep = await declaredEdge({
      repo: RJS,
      number: 1222,
      crossRepo: true,
      needsRelease: false,
      reason: null,
      raw: ''
    });
    const g = buildGraph([sp(491, [decorateEdge(dep, mine, false)])], mine);
    g.layout = layoutGraph(g);
    const html = page(g);
    assert.equal(at(g, `${RJS}#1222`).merged, true);
    assert.equal(at(g, `${RJS}#1222`).state, 'merged', 'and the fill knows it too');
    assert.match(html, /<text class="st"[^>]*>● merged<\/text>/);
    assert.match(html, /already merged — drawn because something here still depends on it/);
    assert.match(html, /<path class="edge cross met"/, 'and its edge is drawn met');
  });
} else {
  console.log('release gating (live API)  SKIPPED - no GH_TOKEN');
}

console.log(`\n${pass} passed${process.exitCode ? ', SOME FAILED' : ''}`);
