#!/usr/bin/env node
// Builds dist/index.html: my open PRs across an org, drawn as a DEPENDENCY
// GRAPH -- one node per PR, however many edges that PR happens to be on either
// end of.
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

// The graph is seeded from MY PRs only.
//
// Somebody else's PR earns a place on this page in exactly one way: one of mine
// depends on it. Then it is drawn as the TARGET of one of my edges, dashed and
// labelled with its author, so it never reads as my work. It is never listed as
// one of my PRs under a repo heading, and if nothing of mine points at it, it is
// not fetched or drawn at all.
//
// Today that rule bites once: sx-monorepo#2222 (mine) is branched off #2219
// (wa0x6e's). Dropping #2219 would hide why #2222 cannot merge, so it stays --
// one arrow into #2222, marked as another author's, never one of mine.
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

async function main() {
  const found = await searchOpenPrs(AUTHOR, ORG);
  console.log(`search: ${found.length} open PRs by ${AUTHOR} in ${ORG}`);

  // --- load each PR, plus the repo it lives in -------------------------
  const repoNames = [...new Set(found.map(i => i.repository_url.split('/repos/')[1]))];
  const repoMeta = new Map();
  for (const r of repoNames) {
    const meta = await getRepo(r);
    repoMeta.set(r, {
      private: meta ? meta.private : true,
      defaultBranch: meta ? meta.default_branch : null,
      name: r
    });
  }

  const prs = [];
  for (const item of found) {
    const repo = item.repository_url.split('/repos/')[1];
    const full = await getPr(repo, item.number);
    if (!full) continue;
    prs.push({
      repo,
      number: full.number,
      title: full.title,
      url: full.html_url,
      author: full.user.login,
      draft: full.draft,
      head: full.head.ref,
      headSha: full.head.sha,
      base: full.base.ref,
      baseRepo: full.base.repo.full_name,
      mergeable: full.mergeable_state,
      updatedAt: full.updated_at,
      body: full.body || '',
      private: repoMeta.get(repo).private
    });
  }
  prs.sort((a, b) => a.repo.localeCompare(b.repo) || a.number - b.number);

  // The search is already scoped to author:AUTHOR, so this drops nothing
  // today. It is here so the "only mine are listed as mine" rule survives a
  // widened query rather than depending on one word in a search string.
  const foreign = prs.filter(p => !isMine(p.author));
  if (foreign.length) {
    console.log(`dropped ${foreign.length} PR(s) not authored by ${AUTHOR} from the root set`);
  }
  const own = prs.filter(p => isMine(p.author));

  const withheldAll = own.filter(p => p.private && !INCLUDE_PRIVATE);
  const visible = INCLUDE_PRIVATE ? own : own.filter(p => !p.private);

  // --- edges ------------------------------------------------------------
  for (const pr of visible) {
    pr.deps = [];

    // 1. explicit stack: base branch is another OPEN PR's head branch.
    //    Any author -- a stack can sit on a colleague's branch (sx#2222 sits
    //    on wa0x6e's #2219). A colleague's PR reached this way is a
    //    prerequisite of mine and is drawn as one, beneath my PR; it is never
    //    promoted to a root.
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
  }

  // --- CI attribution ----------------------------------------------------
  for (const pr of visible) {
    const prChecks = await getChecks(pr.repo, pr.headSha);
    const baseSha = await getBranchHead(pr.repo, pr.base);
    const baseChecks = baseSha ? await getChecks(pr.repo, baseSha) : [];
    pr.ci = classify(prChecks, baseChecks);
    pr.ci.baseRef = pr.base;
    pr.ci.baseSha = baseSha ? baseSha.slice(0, 7) : null;
  }

  const graph = buildGraph(visible, isMine);
  const dupes = duplicateNodes(graph);
  if (dupes.length) {
    // Not a warning and not a footnote. One PR is one node, or the page is wrong.
    throw new Error(`a PR was built into more than one node: ${dupes.join(', ')}`);
  }
  graph.layout = layoutGraph(graph);
  const groups = groupNodes(graph);

  const withheld = accountWithheld(withheldAll, visible, isMine);
  console.log(
    `withheld: ${withheld.count} (${withheld.blocking} of them block a PR shown on the page)`
  );
  console.log(
    `graph: ${graph.nodes.length} node(s), ${graph.edges.length} edge(s), ` +
      `${graph.layout.maxRank + 1} rank(s), ${graph.layout.width}x${graph.layout.height} canvas`
  );
  for (const g of groups) {
    console.log(
      `${g.repo}: ${g.count} mine` +
        (g.referenced.length ? `, ${g.referenced.length} referenced but not mine` : '') +
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
    total: visible.length
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
// the page would otherwise have DRAWN. Under the only-mine-are-mine rule that
// is: my own PRs (each is a node of its own), plus anybody's PR that something
// visible depends on (a node at the tail of an edge). A PR that is neither is
// missing from the graph for reasons that have nothing to do with privacy, and
// counting it as "withheld" would overstate what privacy is hiding.
export function accountWithheld(withheldPrs, visible, mine) {
  const referenced = new Set();
  const blockers = new Set();
  for (const pr of visible) {
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
// Only MY PRs become nodes on their own. Somebody else's PR becomes a node only
// as the target of one of my edges, carrying `kind: 'dep'` and whatever
// decorateEdge() put on the edge, and it is never listed as one of mine. A
// foreign PR that nothing of mine points at is dropped and reported on
// `graph.pruned`, so the rule does not rest on the search string alone.
export function buildGraph(prs, mine = () => true) {
  const pruned = prs.filter(p => !mine(p.author)).map(p => `${p.repo}#${p.number}`);
  const own = prs.filter(p => mine(p.author));

  const K = (repo, number) => `${repo}#${number}`;
  const byKey = new Map();
  const nodes = [];
  const add = n => {
    byKey.set(n.key, n);
    nodes.push(n);
    return n;
  };

  for (const pr of own) {
    const key = K(pr.repo, pr.number);
    if (byKey.has(key)) continue;
    add({
      key,
      kind: 'own',
      repo: pr.repo,
      number: pr.number,
      url: pr.url,
      title: pr.title,
      author: pr.author,
      foreign: false,
      hidden: false,
      pr,
      needs: [],
      neededBy: []
    });
  }

  const edges = [];
  for (const pr of own) {
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

  const graph = { nodes, edges, byKey, pruned };
  rankNodes(graph);
  return graph;
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
// the build log reports, and it is what the "only mine are listed as mine" rule
// is checked against -- so every node still lands in exactly one group, my PRs
// first, then anything referenced there that is not mine.
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
