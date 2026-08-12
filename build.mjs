#!/usr/bin/env node
// Builds dist/index.html: my open PRs across an org, drawn as a DEPENDENCY
// GRAPH -- one node per PR, however many edges that PR happens to be on either
// end of.
//
// Whose PRs are on it: whole connected components, drawn when ONE PR in them is
// mine. Somebody else's PR standing in a chain of mine is a full node, marked as
// not mine; a chain with none of mine in it is not drawn at all. See the block
// above isMineFor().
//
// Direction, the one thing this picture must never leave ambiguous:
//
//   the graph reads LEFT TO RIGHT. A PR sits to the RIGHT of the things it
//   needs. Every arrow runs from a prerequisite RIGHTWARD to the PR that waits
//   on it, so the leftmost column merges FIRST, the rightmost column merges
//   LAST, and reading the drawing left to right IS merge order.
//
// And the direction that does NOT exist: one rank is one COLUMN, and the PRs
// stacked inside a column have no edge between them and no order between them.
// Vertical position is packing. The page says so on every column header, in the
// banner, in the caption, in the legend, and on every row of the text form.
//
// Why a graph and not the nested tree this replaced. A PR can have several
// INDEPENDENT prerequisites -- stamp#491 needs stamp#504 merged AND
// snapshot.js#1225 released, and neither of those depends on the other -- and a
// PR can equally be the prerequisite of several others. Either way a nested
// list cannot hold it: one of the two copies of snapshot.js#1225 had to be a
// footnote pointing at the other, because a list gives every node exactly one
// place. A graph gives a node one place and as many edges as it needs, so #1225
// is now ONE box with an arrow into stamp#491 and nothing duplicated. The
// duplication was a workaround for the tree shape, not a fact about the data.
//
// The drawing is a layered layout emitted as inline SVG at build time (see
// src/graph.mjs). No Mermaid, no d3, no CDN, no <script> tag: the page stays a
// single static file.
//
// A card carries the PR's ref AND ITS TITLE. The per-repo list that used to
// repeat the whole graph underneath is gone, so the SVG carries the text
// alternative itself: role="img", a <desc> that writes out every column and
// every edge in words, and a <title> on every node and every edge.

import { mkdirSync, writeFileSync } from 'node:fs';
import {
  apiCallCount,
  getBranchHead,
  getChecks,
  getPr,
  getReleases,
  getRepo,
  openPrsInRepo,
  searchOpenPrs
} from './src/github.mjs';
import { parseDeclarations } from './src/declarations.mjs';
import { classify } from './src/ci.mjs';
import { layoutGraph, shortRef } from './src/graph.mjs';
import { render } from './src/render.mjs';

export { shortRef };

const AUTHOR = process.env.PR_AUTHOR || 'tony8713';
const ORG = process.env.PR_ORG || 'snapshot-labs';
// Private repos are withheld from the built page by default, because the page
// is served publicly. The page still SAYS they were withheld -- it never
// pretends the work does not exist.
const INCLUDE_PRIVATE = process.env.INCLUDE_PRIVATE === 'true';

// WHAT IS DRAWN: whole connected components, chosen by whether one PR in them is
// mine.
//
// Take the dependency graph, treat every edge as UNDIRECTED, and split it into
// connected components. A component is drawn IN FULL -- every node in it,
// whoever wrote it -- if at least one PR in it is mine. A component with none of
// mine in it is not drawn at all. So somebody else's PR is a full node here, and
// can be the leftmost thing in the picture with prerequisites of its own; what it
// can never be is unmarked. Every node that is not mine carries
// `◇ not yours · @handle`, and that marking matters MORE under this rule than it
// did under the last one, because the page no longer implies whose work a node is
// by the mere fact of drawing it.
//
// This REPLACES the earlier rule, which was "every node is a PR of mine, and
// somebody else's is drawn only as the target of one of my edges, never as a node
// of its own and never as a root". That rule hid the rest of a chain my PR was
// sitting in the middle of.
//
// It stays bounded in both directions: a PR is drawn only when a declared
// dependency edge joins it to one of mine, transitively. Nobody's PR arrives here
// for being interesting, recent, or in the same repo.
//
// Today the new rule reaches exactly one PR the old one already drew --
// sx-monorepo#2219 (wa0x6e's), which #2222 of mine is branched off -- and it
// keeps two all-bonustrack stacks OUT, because no PR of mine is anywhere in them.
export const isMineFor = author => login =>
  String(login || '').toLowerCase() === String(author).toLowerCase();
const isMine = isMineFor(AUTHOR);

// Flags a dependency edge so the page can say whose PR the target is.
//
// Unknown authorship (an unreadable target) is NOT reported as "another
// author" -- we do not know, and guessing reads as an accusation. A target in
// a private repo keeps its number and link but loses its title and author on a
// public build, because a dependency is no reason to leak private work.
export function decorateEdge(edge, mine, includePrivate) {
  const known = Boolean(edge.author);
  edge.foreign = known && !mine(edge.author);
  if (edge.targetPrivate && !includePrivate) {
    edge.title = null;
    edge.author = null;
    edge.hidden = true;
  }
  return edge;
}
const markAuthor = edge => decorateEdge(edge, isMine, INCLUDE_PRIVATE);

// One PR, as this build carries it around. The GitHub list endpoint and the
// single-PR endpoint both produce this, so a candidate found in a repo listing
// and one of mine found by search are the same kind of thing from here on.
export function prRecord(full, repo, meta) {
  return {
    key: `${repo}#${full.number}`,
    repo,
    number: full.number,
    title: full.title,
    url: full.html_url,
    author: full.user ? full.user.login : null,
    draft: Boolean(full.draft),
    head: full.head.ref,
    headSha: full.head.sha,
    base: full.base.ref,
    baseRepo: full.base.repo ? full.base.repo.full_name : null,
    mergeable: full.mergeable_state || null,
    updatedAt: full.updated_at,
    body: full.body || '',
    private: meta ? meta.private : true,
    status: 'open'
  };
}

// Somebody else's PR that the component rule pulls onto the page from a PRIVATE
// repo. It keeps its number and its link, and loses everything else: no title, no
// author, no repo name -- the same deal a private edge TARGET has always had.
//
// It also loses its BODY, which means it declares no dependencies of its own and
// contributes no branch names or edge reasons. A node the page cannot even name
// has no business printing prose out of a private repo, so a hidden node is a
// number, a link and the one edge that pulled it in. My own private PRs are not
// drawn at all; they are counted in the withheld notice instead.
export function redactPrivate(rec) {
  rec.title = null;
  rec.author = null;
  rec.body = '';
  rec.hidden = true;
  return rec;
}

// The dependency edges leaving one PR: its explicit stack parent, then whatever
// its body declares. Computed once per PR and cached on it, because the component
// rule asks the same question of candidates as of my own PRs -- forward and
// backward connectivity have to come from ONE edge definition or the graph ends
// up with edges that exist in one direction only.
export async function resolveDeps(pr, repoMeta) {
  if (pr.deps) return pr.deps;
  pr.deps = [];
  if (pr.hidden) return pr.deps; // see redactPrivate()

  // 1. explicit stack: base branch is another OPEN PR's head branch.
  //    Any author -- a stack can sit on a colleague's branch (sx#2222 sits on
  //    wa0x6e's #2219), and under the component rule a colleague's PR reached
  //    this way is a full node with prerequisites of its own.
  //
  //    Two guards, because the naive name match is badly wrong. A PR opened
  //    FROM A FORK's default branch has head.ref === "master", which matches
  //    the base of every ordinary PR in the repo: without these, all six
  //    stamp PRs came out "stacked on #31", a fork PR named master.
  //      a) a PR based on the repo's default branch is never stacked
  //      b) the parent's head branch must live in the upstream repo itself
  const defaultBranch = repoMeta.get(pr.repo).defaultBranch;
  const siblings = await openPrsInRepo(pr.repo);
  const basePr =
    pr.base === defaultBranch
      ? undefined
      : siblings.find(
          s =>
            s.head.ref === pr.base &&
            s.number !== pr.number &&
            s.head.repo &&
            s.head.repo.full_name === pr.baseRepo
        );
  if (basePr) {
    pr.deps.push(
      markAuthor({
        kind: 'stack',
        repo: pr.repo,
        number: basePr.number,
        url: basePr.html_url,
        title: basePr.title,
        author: basePr.user.login,
        targetPrivate: Boolean(basePr.base && basePr.base.repo && basePr.base.repo.private),
        crossRepo: false,
        needsRelease: false,
        reason: `branched from ${pr.base}`,
        satisfied: false,
        status: 'open'
      })
    );
  }

  // 2 + 3. declared edges, same-repo and cross-repo.
  for (const d of parseDeclarations(pr.body, pr.repo)) {
    if (pr.deps.some(e => e.repo === d.repo && e.number === d.number)) continue;
    const target = await getPr(d.repo, d.number);
    const edge = {
      kind: d.crossRepo ? 'cross-repo' : 'implicit',
      repo: d.repo,
      number: d.number,
      url: target ? target.html_url : `https://github.com/${d.repo}/pull/${d.number}`,
      title: target ? target.title : null,
      author: target ? target.user.login : null,
      targetPrivate: Boolean(target && target.base && target.base.repo && target.base.repo.private),
      crossRepo: d.crossRepo,
      needsRelease: d.needsRelease,
      reason: d.reason,
      declared: d.raw,
      unreadable: !target
    };
    Object.assign(edge, await resolveStatus(edge, target));
    pr.deps.push(markAuthor(edge));
  }
  return pr.deps;
}

async function main() {
  const found = await searchOpenPrs(AUTHOR, ORG);
  console.log(`search: ${found.length} open PRs by ${AUTHOR} in ${ORG}`);

  const repoMeta = new Map();
  const loadRepo = async name => {
    if (repoMeta.has(name)) return repoMeta.get(name);
    const meta = await getRepo(name);
    const rec = {
      name,
      private: meta ? meta.private : true,
      defaultBranch: meta ? meta.default_branch : null
    };
    repoMeta.set(name, rec);
    return rec;
  };

  // --- my own open PRs: the seed ----------------------------------------
  for (const r of new Set(found.map(i => i.repository_url.split('/repos/')[1]))) await loadRepo(r);

  const seed = [];
  for (const item of found) {
    const repo = item.repository_url.split('/repos/')[1];
    const full = await getPr(repo, item.number);
    if (!full) continue;
    seed.push(prRecord(full, repo, repoMeta.get(repo)));
  }
  seed.sort((a, b) => a.repo.localeCompare(b.repo) || a.number - b.number);

  // The search is already scoped to author:AUTHOR, so this reclassifies nothing
  // today. It is here so "a node is MINE only if I wrote it" survives a widened
  // query rather than depending on one word in a search string: a PR by anybody
  // else that arrives through the seed search is treated as a candidate like any
  // other, marked as not mine, and kept only if it lands in a component of mine.
  const misfiled = seed.filter(p => !isMine(p.author));
  if (misfiled.length) {
    console.log(`${misfiled.length} seed PR(s) not authored by ${AUTHOR}: treated as anybody else's`);
  }

  const withheldAll = seed.filter(p => isMine(p.author) && p.private && !INCLUDE_PRIVATE);

  // --- the search space, and why it is this and not "the org" -----------
  //
  // The component rule lets somebody else's PR onto the page, so the set of PRs
  // this build has to LOOK at is bigger than the set it draws. It is still
  // bounded, and the bound is: the open PRs of the repos this page already has a
  // reason to open -- the repos my own open PRs live in, plus any repo a drawn
  // dependency points into. Everything found there is a CANDIDATE and nothing
  // more; a candidate becomes a node only when a dependency edge joins it,
  // transitively and in either direction, to a PR of mine. Bodies come with the
  // list endpoint, so asking every candidate for its edges is nearly free.
  const pool = new Map();
  const addCandidate = rec => {
    if (rec.private && !INCLUDE_PRIVATE) {
      if (isMine(rec.author)) return null; // withheld, and counted as withheld
      redactPrivate(rec);
    }
    if (!pool.has(rec.key)) pool.set(rec.key, rec);
    return pool.get(rec.key);
  };
  for (const p of seed) addCandidate(p);

  const scanned = new Set();
  const scanRepo = async name => {
    if (scanned.has(name)) return;
    scanned.add(name);
    const meta = await loadRepo(name);
    // A private repo is not swept for candidates on a public build: every PR
    // found there would be drawn as a bare number, and a page that cannot name
    // them has no business pulling more of them in.
    if (meta.private && !INCLUDE_PRIVATE) return;
    for (const p of await openPrsInRepo(name)) addCandidate(prRecord(p, name, meta));
  };

  let graph = null;
  for (let pass = 1; ; pass++) {
    for (const name of new Set([...pool.values()].map(p => p.repo))) await scanRepo(name);
    for (const p of pool.values()) await resolveDeps(p, repoMeta);

    // A candidate on no dependency edge at all was never in a chain, so it is not
    // something the component rule "left out" -- it is simply somebody else's
    // unrelated PR, and handing it to buildGraph would make `graph.pruned` a list
    // of every other open PR in the org instead of the chains this page declined
    // to draw. My own PRs go in regardless: each is at least a component of one.
    const onAnEdge = new Set();
    for (const p of pool.values()) {
      for (const d of p.deps) {
        onAnEdge.add(p.key);
        onAnEdge.add(`${d.repo}#${d.number}`);
      }
    }
    graph = buildGraph(
      [...pool.values()].filter(p => isMine(p.author) || onAnEdge.has(p.key)),
      isMine
    );

    // A cross-repo edge can land in a repo nothing on the page lives in yet, and
    // whatever else is joined to the far end of it belongs to the component too.
    // Only edges of nodes that SURVIVED the component filter widen the sweep, so
    // an unrelated stack in an unrelated repo never does.
    const next = new Set(
      graph.nodes.flatMap(n => n.needs.map(e => e.from.repo)).filter(r => !scanned.has(r))
    );
    if (!next.size) break;
    if (pass >= 4) {
      console.log(`expansion stopped after ${pass} passes; not swept: ${[...next].join(', ')}`);
      break;
    }
    for (const r of next) await scanRepo(r);
  }

  const dupes = duplicateNodes(graph);
  if (dupes.length) {
    // Not a warning and not a footnote. One PR is one node, or the page is wrong.
    throw new Error(`a PR was built into more than one node: ${dupes.join(', ')}`);
  }

  // --- CI attribution ----------------------------------------------------
  //
  // Mine only, and only for the ones actually drawn. Somebody else's node states
  // whose it is instead: "whose PR is this" outranks CI in the one line a box
  // has, and under the component rule that line is the only thing standing
  // between a foreign root and a reader who assumes the page is all mine.
  const drawnMine = graph.nodes.filter(n => n.kind === 'own').map(n => n.pr);
  for (const pr of drawnMine) {
    const prChecks = await getChecks(pr.repo, pr.headSha);
    const baseSha = await getBranchHead(pr.repo, pr.base);
    const baseChecks = baseSha ? await getChecks(pr.repo, baseSha) : [];
    pr.ci = classify(prChecks, baseChecks);
    pr.ci.baseRef = pr.base;
    pr.ci.baseSha = baseSha ? baseSha.slice(0, 7) : null;
  }

  graph.layout = layoutGraph(graph);
  const groups = groupNodes(graph);

  const withheld = accountWithheld(withheldAll, graph.nodes.map(n => n.pr).filter(Boolean), isMine);
  console.log(
    `withheld: ${withheld.count} (${withheld.blocking} of them block a PR shown on the page)`
  );
  console.log(
    `graph: ${graph.nodes.length} node(s), ${graph.edges.length} edge(s), ` +
      `${graph.layout.maxRank + 1} rank(s), ${graph.layout.width}x${graph.layout.height} canvas`
  );
  console.log(
    `components: ${componentsOf(graph.nodes).length} drawn, each holding at least one PR by ` +
      `${AUTHOR}; ${graph.pruned.length} candidate PR(s) dropped for being in a component with ` +
      `none of ${AUTHOR}'s${graph.pruned.length ? `: ${graph.pruned.join(', ')}` : ''}`
  );
  const others = graph.nodes.filter(n => n.kind !== 'own');
  if (others.length) {
    console.log(
      `not ${AUTHOR}'s, drawn because a component says so: ` +
        others
          .map(n => `${n.hidden ? `#${n.number}` : n.key}${n.author ? ` (@${n.author})` : ''}`)
          .join(', ')
    );
  }
  for (const g of groups) {
    console.log(
      `${g.repo}: ${g.count} mine` +
        (g.referenced.length ? `, ${g.referenced.length} in the graph but not mine` : '') +
        `, ${g.last.length} that nothing waits on`
    );
  }

  mkdirSync('dist', { recursive: true });
  const html = render({
    graph,
    author: AUTHOR,
    org: ORG,
    generatedAt: new Date().toISOString(),
    withheld,
    total: drawnMine.length
  });
  writeFileSync('dist/index.html', html);
  console.log(`wrote dist/index.html (${html.length} bytes, ${apiCallCount()} API calls)`);
}

// Is a prerequisite already met?
export async function resolveStatus(edge, target) {
  if (!target) return { satisfied: false, status: 'unreadable' };

  if (!target.merged_at) {
    return { satisfied: false, status: target.state === 'closed' ? 'closed unmerged' : 'open' };
  }

  if (!edge.needsRelease) return { satisfied: true, status: 'merged' };

  // Release-gated: merging is not enough, it needs a published release AFTER
  // the merge landed.
  const releases = await getReleases(edge.repo);
  const after = releases.find(r => new Date(r.publishedAt) > new Date(target.merged_at));
  if (after) {
    return { satisfied: true, status: `released in ${after.tag}`, release: after };
  }
  return {
    satisfied: false,
    status: 'merged, awaiting release',
    latestRelease: releases[0] || null
  };
}

// What the "N PRs withheld" notice is allowed to count.
//
// The notice exists to admit the page is incomplete, so it must count only PRs
// the page would otherwise have DRAWN. Under the component rule that is: my own
// PRs (each is at least a component of one, so each is always drawn), plus
// anybody's PR that something drawn depends on. A PR that is neither is missing
// from the graph for reasons that have nothing to do with privacy -- most often
// because no PR of mine is anywhere in its component -- and counting it as
// "withheld" would overstate what privacy is hiding.
//
// `drawn` is every PR record the graph kept, not only mine: somebody else's node
// can now carry the edge that makes one of my private PRs a blocker.
export function accountWithheld(withheldPrs, drawn, mine) {
  const referenced = new Set();
  const blockers = new Set();
  for (const pr of drawn) {
    for (const d of pr.deps || []) {
      const key = `${d.repo}#${d.number}`;
      referenced.add(key);
      if (!d.satisfied) blockers.add(key);
    }
  }

  const key = p => `${p.repo}#${p.number}`;
  const counted = withheldPrs.filter(p => mine(p.author) || referenced.has(key(p)));
  return {
    count: counted.length,
    referenced: counted.filter(p => referenced.has(key(p))).length,
    blocking: counted.filter(p => blockers.has(key(p))).length
  };
}

// Same-repo prerequisites first, then cross-repo, numerically within each, so a
// repo's own stack reads contiguously before the outside world does.
export const edgeOrder = (a, b) =>
  Number(Boolean(a.crossRepo)) - Number(Boolean(b.crossRepo)) ||
  a.repo.localeCompare(b.repo) ||
  a.number - b.number;

// --- the graph ----------------------------------------------------------
//
// ONE NODE PER PR, and as many edges as the data has. That sentence is the
// whole rework. The previous build drew a nested list, which gives every node
// exactly one place, so a PR that two others needed had to be drawn twice with a
// footnote on each copy pointing at the other. Here a shared prerequisite is one
// box with two arrows leaving it.
//
// An edge points from the PREREQUISITE to the PR that waits on it, i.e. in merge
// order. `n.needs` are the edges arriving from the left, `n.neededBy` the edges
// leaving to the right.
//
// EVERY PR handed in becomes a node, whoever wrote it, and so does every PR at
// the far end of an edge. What decides whether a node is DRAWN is the component
// it lands in: pruneComponents() then drops, in one piece, every component that
// holds no PR of mine, and reports each dropped PR on `graph.pruned`.
//
// `kind: 'own'` is reserved for the dashboard author's own open PRs -- they are
// the ones that carry CI and a draft flag. Anybody else's node is `kind: 'dep'`,
// which is what puts the dashed box and the `◇ not yours · @handle` mark on it,
// and it gets that mark wherever it sits: prerequisite, dependent, or the root of
// the whole chain.
export function buildGraph(prs, mine = () => true) {
  const K = (repo, number) => `${repo}#${number}`;
  const byKey = new Map();
  const nodes = [];
  const add = n => {
    byKey.set(n.key, n);
    nodes.push(n);
    return n;
  };

  for (const pr of prs) {
    const key = K(pr.repo, pr.number);
    if (byKey.has(key)) continue;
    const own = mine(pr.author);
    add({
      key,
      kind: own ? 'own' : 'dep',
      repo: pr.repo,
      number: pr.number,
      url: pr.url,
      title: pr.title,
      author: pr.author,
      foreign: Boolean(pr.author) && !own,
      hidden: Boolean(pr.hidden),
      // Only somebody else's node states its state: the page's whole premise is
      // that my own are open, so saying "open" on each of mine is noise.
      status: own ? undefined : pr.status || 'open',
      pr,
      needs: [],
      neededBy: []
    });
  }

  const edges = [];
  for (const pr of prs) {
    const to = byKey.get(K(pr.repo, pr.number));
    for (const d of [...(pr.deps || [])].sort(edgeOrder)) {
      const tk = K(d.repo, d.number);
      // The heart of it: if the target is already a node -- because it is one of
      // mine, or because another of my PRs needs it too -- we attach a second
      // edge to that ONE node instead of making a copy of it.
      const from =
        byKey.get(tk) ||
        add({
          key: tk,
          kind: 'dep',
          repo: d.repo,
          number: d.number,
          url: d.url,
          title: d.title,
          author: d.author,
          foreign: Boolean(d.foreign),
          hidden: Boolean(d.hidden),
          status: d.status,
          edge: d,
          needs: [],
          neededBy: []
        });
      const e = { from, to, edge: d };
      edges.push(e);
      to.needs.push(e);
      from.neededBy.push(e);
    }
  }

  const graph = { nodes, edges, byKey };
  graph.pruned = pruneComponents(graph, mine);
  rankNodes(graph);
  return graph;
}

// The connected components of the graph, with every edge treated as UNDIRECTED.
//
// Undirected is the point. "Joined to a PR of mine" has to mean joined, not
// reachable downstream of: if somebody else's PR waits on mine, and a third PR
// waits on theirs, all three are one piece of work and the picture is a lie if it
// shows only the middle of it. Following edges one way would draw a different
// slice of the same chain depending on which end happened to be mine.
export function componentsOf(nodes) {
  const seen = new Set();
  const out = [];
  for (const start of nodes) {
    if (seen.has(start.key)) continue;
    seen.add(start.key);
    const comp = [];
    const stack = [start];
    while (stack.length) {
      const n = stack.pop();
      comp.push(n);
      for (const e of [...n.needs, ...n.neededBy]) {
        const other = e.from === n ? e.to : e.from;
        if (seen.has(other.key)) continue;
        seen.add(other.key);
        stack.push(other);
      }
    }
    out.push(comp);
  }
  return out;
}

// THE RULE, in one function.
//
// A component is drawn in full -- every node in it, whoever wrote it -- if at
// least one PR in it is mine. A component with none of mine in it is dropped
// whole: not a lone node kept for context, not a stub, nothing. The keys of every
// PR dropped that way come back for `graph.pruned`, so what the page leaves out
// is stated rather than quietly filtered.
//
// Cycle-cut edges count as connections here. Ranking cuts the edge that closes a
// cycle so the layout terminates, but the two PRs it joins are still one piece of
// work -- which is why this runs BEFORE rankNodes().
export function pruneComponents(graph, mine = () => true) {
  const keep = new Set();
  const dropped = [];
  for (const comp of componentsOf(graph.nodes)) {
    if (comp.some(n => n.kind === 'own' || mine(n.author))) {
      for (const n of comp) keep.add(n.key);
    } else {
      for (const n of comp) dropped.push(n.key);
    }
  }
  if (!dropped.length) return [];

  // Everything a dropped node touches is in the same component and is dropped
  // too, so no surviving node is left holding an edge to one of them.
  graph.nodes = graph.nodes.filter(n => keep.has(n.key));
  graph.edges = graph.edges.filter(e => keep.has(e.from.key) && keep.has(e.to.key));
  for (const key of dropped) graph.byKey.delete(key);
  return dropped.sort();
}

// Dependency depth: rank 0 is a PR with no prerequisites, and a PR's rank is one
// past its deepest prerequisite -- the longest path, not the shortest, so a PR is
// never drawn level with something it waits on.
//
// A needs B needs A would recurse forever, so the edge that closes a cycle is
// marked `cycle`, contributes no depth, and is not drawn. The page says so
// rather than hanging the build or silently dropping the PRs involved.
export function rankNodes(graph) {
  const onStack = new Set();
  const rankOf = n => {
    if (typeof n.rank === 'number') return n.rank;
    onStack.add(n.key);
    let r = 0;
    for (const e of n.needs) {
      if (onStack.has(e.from.key)) {
        e.cycle = true;
        n.cycle = true;
        e.from.cycle = true;
        continue;
      }
      r = Math.max(r, rankOf(e.from) + 1);
    }
    onStack.delete(n.key);
    n.rank = r;
    return r;
  };
  for (const n of graph.nodes) rankOf(n);
  return graph;
}

// What markRepeats() used to annotate, this asserts. The tree HAD to duplicate a
// shared prerequisite, so the old build labelled every copy with where the others
// were. A graph has no such excuse: two nodes for one PR is a bug, and the build
// fails on it rather than shipping a page that shows one PR twice.
export function duplicateNodes(graph) {
  const seen = new Map();
  for (const n of graph.nodes) seen.set(n.key, (seen.get(n.key) || 0) + 1);
  return [...seen.entries()].filter(([, count]) => count > 1).map(([key]) => key);
}

// A node whose repo name is itself withheld cannot be filed under that name.
export const WITHHELD_GROUP = '__withheld__';

// The same graph, grouped by repo. This used to be RENDERED, as a per-PR list
// under the drawing; that list is gone. It survives as accounting -- it is what
// the build log reports, and it is what "a node is MINE only if I wrote it" is
// checked against -- so every node still lands in exactly one group, my PRs
// first, then everything else in that repo the component rule brought with them.
//
// `g.count` counts MY PRs only. Somebody else's is on the page because a chain of
// mine runs through it, and counting it among my open PRs would be a second way
// of implying it is mine.
export function groupNodes(graph) {
  const byRepo = new Map();
  const take = (key, label) => {
    if (!byRepo.has(key)) byRepo.set(key, { repo: key, label, mine: [], referenced: [] });
    return byRepo.get(key);
  };

  for (const n of graph.nodes) {
    const g = n.hidden
      ? take(WITHHELD_GROUP, 'private repos — names withheld')
      : take(n.repo, n.repo);
    (n.kind === 'own' ? g.mine : g.referenced).push(n);
  }

  const groups = [...byRepo.values()].sort(
    (a, b) =>
      Number(a.repo === WITHHELD_GROUP) - Number(b.repo === WITHHELD_GROUP) ||
      a.repo.localeCompare(b.repo)
  );

  for (const g of groups) {
    g.mine.sort((a, b) => a.number - b.number);
    g.referenced.sort((a, b) => a.number - b.number);
    g.withheld = g.repo === WITHHELD_GROUP;
    g.count = g.mine.length;
    g.nodes = [...g.mine, ...g.referenced];
    // Nothing on this page waits on these, so they are this repo's merge-last.
    g.last = g.mine.filter(n => n.neededBy.length === 0);
  }
  return groups;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch(e => {
    console.error(e);
    process.exit(1);
  });
}
