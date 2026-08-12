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
// Rules that keep prose from turning into edges:
//   * the line must START with the keyword (an optional "-" or "*" bullet is fine)
//   * fenced code blocks are skipped
//   * blockquoted lines ("> ...") are skipped, so quoting another PR's body,
//     and GitHub's [!IMPORTANT] callouts, never declare anything

const DECL = new RegExp(
  '^\\s{0,3}' + // little indent, so it survives a nested bullet
    '(?:[-*+]\\s+)?' + // optional list marker
    '(?:\\*\\*)?' + // optional bold
    'depends\\s+on\\s+' +
    '(release\\s+of\\s+)?' + // the release-gated variant
    '(?:\\*\\*)?' +
    '(?:([A-Za-z0-9._-]+/[A-Za-z0-9._-]+))?' + // optional owner/repo for cross-repo
    '#(\\d+)' +
    '\\s*(?:[-–—:]\\s*(.*?))?\\s*$', // optional trailing reason
  'i'
);

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

    const [, releaseOf, repoRef, number, reason] = m;
    out.push({
      repo: repoRef || selfRepo,
      number: Number(number),
      needsRelease: Boolean(releaseOf),
      crossRepo: Boolean(repoRef) && repoRef !== selfRepo,
      reason: (reason || '').trim() || null,
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
