#!/usr/bin/env node
// Builds dist/index.html: my open PRs across an org, as a merge-order tree.

import { mkdirSync, writeFileSync } from 'node:fs';
import {
  api,
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
import { render } from './src/render.mjs';

const AUTHOR = process.env.PR_AUTHOR || 'tony8713';
const ORG = process.env.PR_ORG || 'snapshot-labs';
// Private repos are withheld from the built page by default, because the page
// is served publicly. The page still SAYS they were withheld -- it never
// pretends the work does not exist.
const INCLUDE_PRIVATE = process.env.INCLUDE_PRIVATE === 'true';

// The tree roots on MY PRs only.
//
// Somebody else's PR earns a place on this page in exactly one way: one of
// mine depends on it. Then it is drawn as a dependency hanging off my PR and
// labelled with its author, so it never reads as my work. It is never a root,
// never the top of a subtree of its own, and if nothing of mine points at it
// it is not fetched or drawn at all.
//
// Today that rule bites once: sx-monorepo#2222 (mine) is branched off #2219
// (wa0x6e's). Dropping #2219 would hide why #2222 cannot merge, so it stays --
// as a dependency, marked, not as a root.
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
  // today. It is here so the "roots are mine" rule survives a widened query
  // rather than depending on one word in a search string.
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
    //    on wa0x6e's #2219). A colleague's PR reached this way is a dependency
    //    of mine and is drawn as one; it is not promoted to a node of the tree.
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

  const groups = buildGroups(visible, isMine);
  const withheld = accountWithheld(withheldAll, visible, isMine);
  console.log(
    `withheld: ${withheld.count} (${withheld.blocking} of them block a PR shown on the page)`
  );

  mkdirSync('dist', { recursive: true });
  const html = render({
    groups,
    author: AUTHOR,
    org: ORG,
    generatedAt: new Date().toISOString(),
    withheld,
    total: visible.length
  });
  writeFileSync('dist/index.html', html);
  console.log(`wrote dist/index.html (${html.length} bytes, ${apiCallCount()} API calls)`);
}

// Is a dependency already met?
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
// the page would otherwise have DRAWN. Under the roots-are-mine rule that is:
// my own PRs (each is a root of its own), plus anybody's PR that something
// visible depends on (drawn as a dependency). A PR that is neither is missing
// from the tree for reasons that have nothing to do with privacy, and counting
// it as "withheld" would overstate what privacy is hiding.
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

// Group by repo and lay each repo out as a forest ordered by merge order.
//
// Merge order runs root-first: a node's parent is the thing that has to land
// before it. That is exactly why somebody else's PR cannot be a tree node --
// as a dependency of mine it would have to sit ABOVE mine, which makes it a
// root, which is the thing being ruled out. So a foreign PR stays an edge
// drawn on my node (see decorateEdge) and never enters the forest.
export function buildGroups(prs, mine) {
  // Step one, before anything else is computed: the forest is built out of my
  // PRs only. A foreign PR here has nothing of mine hanging off it (if it did,
  // that would be an edge on my node, not a node of its own), so it is pruned.
  const pruned = prs.filter(p => !mine(p.author)).map(p => `${p.repo}#${p.number}`);

  const byRepo = new Map();
  for (const pr of prs) {
    if (!mine(pr.author)) continue;
    if (!byRepo.has(pr.repo)) byRepo.set(pr.repo, []);
    byRepo.get(pr.repo).push(pr);
  }

  const groups = [];
  for (const [repo, list] of [...byRepo.entries()].sort()) {
    const local = new Map(list.map(p => [p.number, p]));

    for (const pr of list) {
      // In-repo, unsatisfied edges to a PR that is also on this page become
      // tree edges. Everything else stays an annotation on the node -- which
      // is where a dependency on somebody else's PR lands, because `local`
      // holds none of theirs. sx#2222's edge to wa0x6e's #2219 goes down this
      // path: not a tree edge, still rendered, still explains the block.
      pr.parents = (pr.deps || [])
        .filter(d => !d.crossRepo && d.repo === repo && local.has(d.number) && !d.satisfied)
        .map(d => d.number);
      pr.children = [];
    }

    // A PR can depend on two others; a tree has one slot. It is placed under
    // the first parent and the rest are annotated, so no edge is lost.
    const placed = new Set();
    for (const pr of list) {
      pr.extraParents = pr.parents.slice(1);
      const p = pr.parents[0];
      if (p !== undefined && !createsCycle(pr.number, p, local)) {
        local.get(p).children.push(pr.number);
        placed.add(pr.number);
      } else if (p !== undefined) {
        pr.cycle = true;
      }
    }

    // Every remaining node is mine, so every root is mine.
    const roots = list.filter(p => !placed.has(p.number)).map(p => p.number);
    groups.push({
      repo,
      roots: roots.sort((a, b) => a - b),
      nodes: local,
      count: list.length
    });
  }
  groups.pruned = pruned;
  return groups;
}

function createsCycle(from, to, local) {
  const seen = new Set();
  let stack = [to];
  while (stack.length) {
    const n = stack.pop();
    if (n === from) return true;
    if (seen.has(n)) continue;
    seen.add(n);
    const node = local.get(n);
    if (node) stack.push(...node.parents);
  }
  return false;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch(e => {
    console.error(e);
    process.exit(1);
  });
}
