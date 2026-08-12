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

  const withheld = prs.filter(p => p.private && !INCLUDE_PRIVATE);
  const visible = INCLUDE_PRIVATE ? prs : prs.filter(p => !p.private);

  // --- edges ------------------------------------------------------------
  const byKey = new Map(visible.map(p => [`${p.repo}#${p.number}`, p]));

  for (const pr of visible) {
    pr.deps = [];

    // 1. explicit stack: base branch is another OPEN PR's head branch.
    //    Any author -- a stack can sit on a colleague's branch (sx#2222 sits
    //    on wa0x6e's #2219).
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
      pr.deps.push({
        kind: 'stack',
        repo: pr.repo,
        number: basePr.number,
        url: basePr.html_url,
        title: basePr.title,
        author: basePr.user.login,
        crossRepo: false,
        needsRelease: false,
        reason: `branched from ${pr.base}`,
        satisfied: false,
        status: 'open'
      });
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
        crossRepo: d.crossRepo,
        needsRelease: d.needsRelease,
        reason: d.reason,
        declared: d.raw,
        unreadable: !target
      };
      Object.assign(edge, await resolveStatus(edge, target));
      pr.deps.push(edge);
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

  const groups = buildGroups(visible, byKey);

  mkdirSync('dist', { recursive: true });
  const html = render({
    groups,
    author: AUTHOR,
    org: ORG,
    generatedAt: new Date().toISOString(),
    withheld: withheld.map(p => p.repo),
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

// Group by repo and lay each repo out as a forest ordered by merge order.
function buildGroups(prs, byKey) {
  const byRepo = new Map();
  for (const pr of prs) {
    if (!byRepo.has(pr.repo)) byRepo.set(pr.repo, []);
    byRepo.get(pr.repo).push(pr);
  }

  const groups = [];
  for (const [repo, list] of [...byRepo.entries()].sort()) {
    const local = new Map(list.map(p => [p.number, p]));

    for (const pr of list) {
      // In-repo, unsatisfied edges to a PR that is also on this page become
      // tree edges. Everything else stays an annotation on the node.
      pr.parents = pr.deps
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

    const roots = list.filter(p => !placed.has(p.number)).map(p => p.number);
    groups.push({
      repo,
      roots: roots.sort((a, b) => a - b),
      nodes: local,
      count: list.length
    });
  }
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
