#!/usr/bin/env node
// Builds dist/index.html: my open PRs across an org, drawn so that the LEAVES
// MERGE FIRST.
//
// Direction of the tree, which is the whole idea:
//
//   a PR is drawn ABOVE the things it needs. A node's children are its
//   prerequisites. You read each list bottom-up -- the deepest leaf is the
//   next thing that can merge, the root is the last.
//
// Why this direction and not the other one. A PR can have SEVERAL independent
// prerequisites: stamp#491 needs stamp#504 merged AND snapshot.js#1225
// released, and neither of those depends on the other. Drawn the other way
// round -- prerequisites as ancestors -- #491 has two parents. Two parents is a
// graph, and a graph does not fit in a nested list, so the previous build had
// to pick one parent and demote the rest to a footnote. Inverted, #491 has two
// children, which is exactly a tree, and no edge has to be dropped. Reading
// order then IS merge order.
//
// The honest caveat: inverting does not make the structure a tree in general,
// it moves where the duplication lands. If ONE PR is a prerequisite of TWO of
// mine, it is now drawn twice, once under each. That is the rarer direction in
// practice, but it is real -- snapshot.js#1225 is a root of its own repo AND a
// prerequisite of stamp#491 today -- so every node drawn more than once says
// so and names the other place. Nothing is silently duplicated.

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
// mine depends on it. Then it is drawn as a prerequisite hanging BENEATH my PR
// and labelled with its author, so it never reads as my work. It is never a
// root, and if nothing of mine points at it, it is not fetched or drawn at all.
//
// Today that rule bites once: sx-monorepo#2222 (mine) is branched off #2219
// (wa0x6e's). Dropping #2219 would hide why #2222 cannot merge, so it stays --
// beneath #2222, marked as another author's, never as a root.
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

  const groups = buildGroups(visible, isMine);
  const withheld = accountWithheld(withheldAll, visible, isMine);
  console.log(
    `withheld: ${withheld.count} (${withheld.blocking} of them block a PR shown on the page)`
  );
  for (const g of groups) {
    console.log(
      `${g.repo}: ${g.count} mine, ${g.roots.length} merge-last root(s), ${g.drawn} node(s) drawn` +
        (g.repeats ? `, ${g.repeats} of them a repeat` : '')
    );
  }

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

export const shortRef = (repo, number) => `${String(repo).split('/').pop()}#${number}`;

// --- the tree, inverted so the LEAVES MERGE FIRST -----------------------
//
// One list per repo. A root is one of MY PRs in that repo that no other of my
// PRs in that repo needs -- the thing that merges LAST. Beneath each node hang
// its prerequisites, and beneath those, theirs.
//
// Roots are still mine and only mine. Under this direction that rule is easier
// to hold, not harder: somebody else's PR can only ever be reached by
// following one of MY edges downward, so it lands as a leaf beneath my PR and
// there is no way for it to surface as a root. It is still pruned from the
// root set explicitly, so the rule does not rest on that argument alone.
//
// A prerequisite that is itself one of my PRs in the same repo is expanded in
// place, with its own subtree. Anything else -- another author's PR, a PR in
// another repo, a PR the token cannot read -- is drawn as a marked leaf and
// deliberately NOT expanded: it is not this repo's work, and following it would
// drag another repo's whole stack into this list.
export function buildGroups(prs, mine = () => true) {
  // A foreign PR is never a node of the root set. It reaches the page only by
  // being on the far end of one of my edges, and it is drawn there, marked.
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

    // An edge expands in place only when it lands on one of my PRs in THIS repo.
    const expands = d => !d.crossRepo && d.repo === repo && local.has(d.number);

    // Same-repo prerequisites first, then cross-repo, numerically within each,
    // so a repo's own stack reads contiguously before the outside world.
    const order = (a, b) =>
      Number(Boolean(a.crossRepo)) - Number(Boolean(b.crossRepo)) ||
      a.repo.localeCompare(b.repo) ||
      a.number - b.number;

    const leaf = d => ({
      kind: 'dep',
      key: `${d.repo}#${d.number}`,
      repo: d.repo,
      number: d.number,
      url: d.url,
      title: d.title,
      author: d.author,
      foreign: Boolean(d.foreign),
      hidden: Boolean(d.hidden),
      crossRepo: Boolean(d.crossRepo),
      edge: d,
      children: []
    });

    const build = (pr, edge, path) => {
      const node = {
        kind: 'own',
        key: `${repo}#${pr.number}`,
        repo,
        number: pr.number,
        url: pr.url,
        title: pr.title,
        author: pr.author,
        foreign: false,
        crossRepo: false,
        pr,
        edge,
        children: []
      };
      // A needs B needs A. Stop and say so rather than recurse forever.
      if (path.has(node.key)) {
        node.cycle = true;
        return node;
      }
      const next = new Set(path).add(node.key);
      for (const d of [...(pr.deps || [])].sort(order)) {
        node.children.push(expands(d) ? build(local.get(d.number), d, next) : leaf(d));
      }
      return node;
    };

    // Roots are the PRs nothing else here waits on: they merge last.
    const needed = new Set();
    for (const pr of list) for (const d of pr.deps || []) if (expands(d)) needed.add(d.number);
    const roots = list
      .filter(p => !needed.has(p.number))
      .sort((a, b) => a.number - b.number)
      .map(p => build(p, null, new Set()));

    let drawn = 0;
    const tally = n => {
      drawn++;
      n.children.forEach(tally);
    };
    roots.forEach(tally);

    groups.push({ repo, roots, count: list.length, drawn, repeats: 0 });
  }

  markRepeats(groups);
  groups.pruned = pruned;
  return groups;
}

// Inverting moves the duplication, it does not remove it: a PR that TWO of
// mine need is now drawn under both. Every copy is labelled with where the
// others are, so two drawings of one PR never read as two pieces of work.
export function markRepeats(groups) {
  const seen = new Map();
  const owner = new Map();

  for (const g of groups) {
    const walk = (n, where) => {
      if (!seen.has(n.key)) seen.set(n.key, []);
      seen.get(n.key).push({ node: n, where });
      owner.set(n, g);
      const under = `under ${shortRef(n.repo, n.number)}`;
      for (const c of n.children) walk(c, under);
    };
    for (const r of g.roots) walk(r, `at the top of ${r.repo.split('/').pop()}`);
  }

  for (const copies of seen.values()) {
    if (copies.length < 2) continue;
    for (const c of copies) {
      c.node.repeat = {
        total: copies.length,
        others: copies.filter(o => o !== c).map(o => o.where)
      };
      const g = owner.get(c.node);
      if (g) g.repeats++;
    }
  }
  return groups;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch(e => {
    console.error(e);
    process.exit(1);
  });
}
