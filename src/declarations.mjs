// Parses dependency declarations out of a PR body.
//
// Nothing here is inferred. A declaration is an edge only when the author
// wrote one, because a wrong edge is worse than a missing one.
//
//   Depends on #504
//   Depends on snapshot-labs/snapshot.js#1225
//   Depends on release of snapshot-labs/snapshot.js#1225
//   Depends on #504 - reason shown on the page
//
// THREE SPELLINGS, ONE MEANING.
//
//   Stacked on #2219 - retarget to `master` after it merges.
//   Stacked on top of #2188 (`feat/safesnap-execution`) - review/merge that first.
//   On top of #2188
//
// `depends on` was the only spelling this understood, and nobody at Snapshot
// writes it. `stacked on`, `stacked on top of` and `on top of` declare exactly
// what `depends on` declares, so they are read as the same thing.
//
// That gap had a cost worth naming, because it looked like a display bug and
// was not. An explicit stack is ALSO computed from the base branch, but only
// while the prerequisite is still OPEN: the computation matches a PR's base ref
// against the head refs of the repo's open PRs, and GitHub retargets the child
// onto the default branch within seconds of the parent merging. So the base-ref
// signal does not merely go stale, it is destroyed at the exact moment the
// merged-trail rule needs it. sx-monorepo#2219 vanished off this page when it
// merged and took the top of #2222's chain with it, while #2222's body had said
// "Stacked on #2219" the whole time. A declaration is permanent; a base ref is
// a fact about right now.
//
// THE TRAILING TEXT IS NOT A REASON ON THE STACK SPELLINGS.
//
// After `Depends on #504 - ` comes a description of the dependency, and it is
// shown as the arrow's label. After `Stacked on #2219 - ` comes, in practice, an
// instruction to whoever is reading the PR: "retarget to `master` after it
// merges", "review/merge that first". Neither describes why the edge exists,
// and both read as nonsense hanging off an arrow between two cards -- worse,
// "retarget after it merges" is advice that expired the moment it did merge,
// which is precisely when the label finally gets drawn.
//
// So the trailing text is kept as the arrow's label for `depends on` and
// dropped for the stack spellings. The rule is SYNTACTIC, decided by the words
// the author chose and nothing else, because sniffing prose to guess whether it
// is an instruction is the kind of inference this file exists to refuse. The
// author's line is not lost either way: `raw` carries it verbatim.
//
// What the stack spellings label an arrow with instead is the branch name, when
// the author put one in parentheses after the number. `stacked on
// feat/safesnap-execution` says the same thing as the computed edge's `branched
// from feat/safesnap-execution` -- so the label survives the parent's merge
// rather than changing under the reader, which is the whole point. A
// parenthetical containing whitespace is not a branch name (git refs cannot
// hold a space) and is not used as one; that arrow simply carries no label.
//
// Rules that keep prose from turning into edges:
//   * the line must START with the keyword (an optional "-" or "*" bullet is fine)
//   * the line must be NOTHING BUT the declaration, give or take a parenthetical
//     branch and a dash-separated tail, so "Together with #2219, this will..."
//     declares nothing
//   * fenced code blocks are skipped
//   * blockquoted lines ("> ...") are skipped, so quoting another PR's body,
//     and GitHub's [!IMPORTANT] callouts, never declare anything

const DECL = new RegExp(
  '^\\s{0,3}' + // little indent, so it survives a nested bullet
    '(?:[-*+]\\s+)?' + // optional list marker
    '(?:\\*\\*)?' + // optional bold
    '(depends\\s+on|stacked\\s+on(?:\\s+top\\s+of)?|on\\s+top\\s+of)\\s+' + // the keyword
    '(release\\s+of\\s+)?' + // the release-gated variant
    '(?:\\*\\*)?' +
    '(?:([A-Za-z0-9._-]+/[A-Za-z0-9._-]+))?' + // optional owner/repo for cross-repo
    '#(\\d+)' +
    '(?:\\s*\\(([^)]*)\\))?' + // optional parenthetical, in practice the branch
    '\\s*(?:[-–—:]\\s*(.*?))?\\s*$', // optional trailing text
  'i'
);

// A git branch name, if the parenthetical can be one. Backticks are markdown,
// not part of the ref; whitespace disqualifies it outright.
function branchOf(paren) {
  const inner = (paren || '').replace(/`/g, '').trim();
  return inner && !/\s/.test(inner) ? inner : null;
}

export function parseDeclarations(body, selfRepo) {
  if (!body) return [];

  const out = [];
  let inFence = false;

  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trimEnd();

    if (/^\s{0,3}(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (/^\s*>/.test(line)) continue; // blockquote / callout

    const m = line.match(DECL);
    if (!m) continue;

    const [, keyword, releaseOf, repoRef, number, paren, trailing] = m;
    // "depends on" is the only spelling whose tail describes the dependency.
    const stacked = !/^depends/i.test(keyword);
    const branch = branchOf(paren);
    out.push({
      repo: repoRef || selfRepo,
      number: Number(number),
      needsRelease: Boolean(releaseOf),
      crossRepo: Boolean(repoRef) && repoRef !== selfRepo,
      stacked,
      branch,
      reason: stacked
        ? branch && `stacked on ${branch}`
        : (trailing || '').trim() || null,
      raw: line.trim()
    });
  }

  // De-dupe, keeping the strictest (release-gated) variant of a repeated edge.
  const seen = new Map();
  for (const d of out) {
    const key = `${d.repo}#${d.number}`;
    const prev = seen.get(key);
    if (!prev || (d.needsRelease && !prev.needsRelease)) seen.set(key, d);
  }
  return [...seen.values()];
}
