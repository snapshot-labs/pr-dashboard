#!/usr/bin/env node
// Builds dist/index.html: my open PRs across an org, drawn as a DEPENDENCY
// GRAPH -- one node per PR, however many edges that PR happens to be on either
// end of.
//
// Whose PRs are on it: whole connected components, drawn when ONE PR in them is
// TRACKED. Tracked means the page author (PR_AUTHOR) or one of the tracked bots
// (PR_BOT_AUTHORS, chai3-bot today). Anybody else's PR standing in a tracked
// chain is a full node, marked as not the page author's; a chain with nothing
// tracked in it is not drawn at all. See the block above isMineFor().
//
// Three kinds of node, and the outline is the channel that says which:
//
//   own   the page author's open PR          solid outline,  no author mark
//   bot   a tracked bot's open PR            dotted outline, `◇ @handle`
//   dep   anything else on the page          dashed outline, `◇ @handle`
//
// A bot's PR is first-class in every structural sense -- it seeds the search, it
// anchors its component, it takes edges in and out, it is release-gated like any
// other, it carries CI -- and marked in every presentational one. It is not
// counted in the open-PR total at the top of the page, which stays the page
// author's, and it gets its own count beside it instead.
//
// WHICH MERGED PRs are on it, which is a separate rule and a narrower one:
//
//   a merged PR is drawn if and only if something on the graph depends on it.
//
// So a merged prerequisite stays, and the trail is drawn whole including the
// links already walked -- "why can #491 not merge yet" is answered by the shape
// of the whole chain, and a chain that vanishes as it lands explains nothing. It
// is TRANSITIVE: a drawn merged PR's own declared prerequisites are on the same
// trail and are drawn too, so a merge partway along does not truncate the
// picture at the point it landed. The other half of the rule does the real work
// of keeping the page readable -- every PR this build fetches is open, so a
// merged PR nothing depends on is never swept in, and the org's whole merge
// history does not bury twenty open PRs. See expandMergedTrail().
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
// WHAT A CARD'S FILL MEANS: the state of the pull request -- open, draft, or
// merged (and closed, for a prerequisite that was abandoned). Derived in
// src/state.mjs from three separate fields, because GitHub has no "draft" state:
// a draft is an OPEN PR with `draft: true` on it, and a merged PR is a CLOSED
// one with a non-null `merged_at`. Every fill is also printed on the card as a
// glyph and a word, so nothing here is signalled by colour alone.
//
// Merged is the state that needed a decision, since every PR this build fetches
// is open. A merged PR is drawn only as a PREREQUISITE that has already landed,
// never as a card of its own -- see mergedNonPrerequisites(), which fails the
// build if one ever gets in another way.
//
// CI attribution is still computed and still keeps its distinction (red on its
// own vs red because the base is red), but it is not on the card face at all:
// the cards carry titles, and the fill spends the colour channel on state. It
// survives as one phrase in the card's hover text.
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
  getAvatar,
  getPr,
  getReleases,
  getRepo,
  getReviewInventory,
  openPrsInRepo,
  searchOpenPrs
} from './src/github.mjs';
import { parseDeclarations } from './src/declarations.mjs';
import { classify } from './src/ci.mjs';
import { openPrState, PR_STATES, prState } from './src/state.mjs';
import { layoutGraph, shortRef } from './src/graph.mjs';
import { render } from './src/render.mjs';
import { reviewQueues } from './src/reviews.mjs';

export { shortRef };

const AUTHOR = process.env.PR_AUTHOR || 'tony8713';
const ORG = process.env.PR_ORG || 'snapshot-labs';
const REVIEWER = process.env.PR_REVIEWER || 'wa0x6e';

// TRACKED AUTHORS: whose open PRs SEED this page.
//
// Two roles that used to be one word, and separating them is the whole of the
// chai3-bot change:
//
//   AUTHOR      the PAGE author. "Mine". An unmarked card is this person's, the
//               open-PR total at the top counts this person's, and the withheld
//               notice speaks in this person's name.
//   BOT_AUTHORS automation whose PRs are tracked HERE as first-class work. Their
//               open PRs seed the page and anchor a component exactly as the page
//               author's do -- so a bot's PR is drawn wherever it sits, alone or
//               mid-chain -- but they are never silently filed as the page
//               author's. Every one carries `◇ @handle` and a dotted outline.
//
// Why the bot list is not simply folded into AUTHOR: `isMine` decides four
// different things, and only ONE of them ("does this anchor a component") should
// widen. Folding chai3-bot into AUTHOR would also have made its PRs unmarked, put
// them in the open-PR total, and made the withheld notice say a bot's private PRs
// are the page author's own. Those are all wrong, and each is a separate line
// below.
const BOT_AUTHORS = (process.env.PR_BOT_AUTHORS ?? 'chai3-bot')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
export const TRACKED_AUTHORS = [AUTHOR, ...BOT_AUTHORS];
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
//
// WHAT THE COMPONENT RULE IS ANCHORED ON, since chai3-bot.
//
// "at least one PR in it is mine" is really "at least one PR in it is TRACKED",
// and the tracked set is the page author plus the bot authors. That is the only
// clause chai3-bot widened. It is worth being exact about what was and was NOT
// standing in a bot's way before, because the two are easily confused:
//
//   NOT a restriction: where a node may sit. There has been no leaf-or-root rule
//   here since the component rule replaced the old one (see the paragraph above).
//   Somebody else's PR is already drawn mid-graph today -- sx-monorepo#2219 is
//   drawn in column 2 of 3 with an arrow in and an arrow out.
//
//   The actual restriction: a component with no TRACKED PR anywhere in it is
//   dropped whole, and nothing but a tracked author's PRs is ever searched for in
//   the first place. chai3-bot's PRs declare no dependency and nothing of mine
//   declares them, so each was a component of one with nothing tracked in it, and
//   pruneComponents() dropped every one. Seeding them is what puts them on the
//   page; no positional rule had to be lifted, because there was none.
//
// Accepts one login or a list of them, so the same factory builds "is the page
// author" and "is any tracked author".
export const isMineFor = authors => {
  const set = new Set(
    (Array.isArray(authors) ? authors : [authors])
      .map(a => String(a || '').toLowerCase())
      .filter(Boolean)
  );
  return login => set.has(String(login || '').toLowerCase());
};
const isMine = isMineFor(AUTHOR);
// A tracked bot. Not "mine" -- the page says whose every card is -- but its work
// anchors a component, seeds the search, and is counted as withheld when private,
// all exactly as mine is.
const isBot = isMineFor(BOT_AUTHORS);
// The union, which is what the component rule and the candidate/withheld
// accounting are anchored on.
const isTracked = isMineFor(TRACKED_AUTHORS);

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
    // The avatar goes with the author, and for the same reason. An avatar is a
    // picture of WHO opened a withheld PR: it is authorship by another channel,
    // it survives having the name stripped, and the redaction scanner cannot see
    // it (that scanner looks for repo names, and an avatar carries none). So it
    // is nulled here, at the same instant as the name, rather than filtered
    // later where a future edit could route around it.
    edge.avatarUrl = null;
    // And so does the open date. Nothing prints it, but it is the sort key for
    // the card's position in its column, and a withheld card has no business
    // carrying a fact about withheld work into the drawing at all.
    edge.createdAt = null;
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
    // The author's avatar, as a URL only. The bytes are fetched later and only
    // for cards that survive the component rule, so a candidate that is never
    // drawn costs no request.
    avatarUrl: full.user ? full.user.avatar_url : null,
    // WHEN THE PR WAS OPENED. `created_at`, deliberately: not `updated_at`,
    // which a bot comment moves, and not `merged_at`, which most of these do not
    // have. It is the sort key for a card's position WITHIN its column.
    createdAt: full.created_at || null,
    draft: Boolean(full.draft),
    // What the card is filled with. Derived from the payload rather than
    // assumed: see src/state.mjs on why `draft` is a flag on an OPEN PR and why
    // `merged_at` has to be read before `state`.
    state: prState(full),
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
  // Authorship by picture is still authorship: see decorateEdge(). A hidden card
  // is a number and a nothing else, and that includes the face of whoever opened
  // it and the day they opened it.
  rec.avatarUrl = null;
  rec.createdAt = null;
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
  //    Any author -- a stack can sit on a colleague's branch (sx#2222 sat on
  //    wa0x6e's #2219 until that merged), and under the component rule a
  //    colleague's PR reached this way is a full node with prerequisites of its
  //    own.
  //
  //    OPEN is the whole limitation of this source, and it is not a soft one.
  //    GitHub retargets a child onto the default branch within seconds of its
  //    parent merging, so the base ref does not go stale, it is overwritten --
  //    #2222's base is `master` now and nothing about #2219 survives in it. That
  //    is why a stack is worth DECLARING in the body as well: the declaration is
  //    what the merged-trail rule reads, and it is the only reason #2219 is
  //    still drawn. See src/declarations.mjs.
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
        status: 'open',
        // A stack parent comes from the open-PR list, so it is open or draft.
        // "open" and "draft" are both true of a draft PR -- the flag does not
        // contradict the status, it refines it.
        targetState: prState(basePr)
      })
    );
  }

  // 2 + 3. declared edges, same-repo and cross-repo.
  //
  // A well-formed stacked PR now hits BOTH sources: its base ref says it and its
  // body says it. One pair is one edge, so the declaration is skipped when the
  // computed stack already covers that target -- the stack edge wins, and with
  // it the `branched from <branch>` reason, which is the more precise of the two
  // (it names the branch git is actually pointing at). Once the parent merges
  // the computed edge is gone and the declaration is all there is, which is the
  // handover this dedup is quietly performing.
  for (const d of parseDeclarations(pr.body, pr.repo)) {
    if (pr.deps.some(e => e.repo === d.repo && e.number === d.number)) continue;
    pr.deps.push(markAuthor(await declaredEdge(d)));
  }
  return pr.deps;
}

// One parsed declaration, resolved into an edge.
//
// The target is looked up BY NUMBER: getPr() is /repos/{repo}/pulls/{number},
// which answers for a merged or closed PR exactly as it does for an open one.
// That is deliberately not the query stack detection uses -- openPrsInRepo()
// lists only OPEN PRs, and so does the candidate sweep -- so a merged target
// still arrives with its real title, its author and its merged_at instead of
// degrading to a bare number.
export async function declaredEdge(d) {
  const target = await getPr(d.repo, d.number);
  const edge = {
    kind: d.crossRepo ? 'cross-repo' : 'implicit',
    repo: d.repo,
    number: d.number,
    url: target ? target.html_url : `https://github.com/${d.repo}/pull/${d.number}`,
    title: target ? target.title : null,
    author: target ? target.user.login : null,
    avatarUrl: target && target.user ? target.user.avatar_url : null,
    createdAt: target ? target.created_at || null : null,
    targetPrivate: Boolean(target && target.base && target.base.repo && target.base.repo.private),
    crossRepo: d.crossRepo,
    needsRelease: d.needsRelease,
    reason: d.reason,
    declared: d.raw,
    unreadable: !target,
    // The fill the target's card gets. Same derivation as any other PR (see
    // src/state.mjs); a merged target is the whole reason this is read from the
    // payload rather than assumed to be "open".
    targetState: prState(target)
  };
  Object.assign(edge, await resolveStatus(edge, target));
  return edge;
}

// How far the already-merged part of a chain is followed before the build gives
// up and says so. The seen-set terminates the walk on its own; this only stops a
// pathological chain from spending the rate limit.
export const TRAIL_LIMIT = 200;

// THE MERGED-TRAIL RULE.
//
//   A merged PR is drawn if and only if something on the graph depends on it.
//
// Both halves matter. A merged prerequisite is kept, because the trail a PR is
// waiting at the end of is the thing this page is for and half a trail explains
// nothing -- "why is #491 still open" is answered by the whole chain, including
// the links already done. A merged PR that nothing depends on is NOT drawn: the
// seed search and the candidate sweep are both `is:open`, so a merged PR only
// ever arrives as the target of an edge. Sweeping them in would bury twenty open
// PRs under every PR the org has ever merged.
//
// The rule is TRANSITIVE, which is what this walk is for. If a drawn merged PR
// declared a prerequisite of its own, that prerequisite is part of the same
// trail and is drawn too -- so the chain is followed backwards through merged
// PRs until it runs out, and one PR's merge does not silently truncate the
// picture at the point it landed.
//
// THE TRAIL IS MERGED AT BOTH ENDS OF EVERY LINK.
//
// Only a merged node extends the trail. An open prerequisite is followed no
// further from here: the component rule already decides how far open work
// reaches, and following open PRs out of a merged body as well would pull in
// chains nothing on the page is joined to.
//
// And a merged PR's declaration is followed only to a target that ALSO merged.
// That is a correctness guard, not tidiness. A declaration in the body of a PR
// that has since merged is a claim about the past, and if its target is still
// open then the claim was not honoured -- the PR merged anyway, so the gate was
// never real. Drawing that edge would put an OPEN card to the LEFT of a merged
// one and assert it has to merge first, which is not only untrue, it is
// unsatisfiable. Those stale links are dropped and counted rather than drawn.
//
// The consequence worth naming: every node the trail adds is merged, so a column
// the trail alone fills is genuinely a finished one.
//
// `declaredBy(repo, number)` returns the resolved edges that PR declares, which
// keeps the network out of the control flow and makes the rule testable.
export async function expandMergedTrail(seeds, declaredBy, limit = TRAIL_LIMIT) {
  const records = [];
  const visited = [];
  const stale = [];
  const seen = new Set();
  const queue = (seeds || []).filter(d => d && d.merged);
  let truncated = false;

  while (queue.length) {
    const d = queue.shift();
    const key = `${d.repo}#${d.number}`;
    // A cycle through merged PRs cannot happen in git, but a body can still
    // declare one, and the walk must not spin on it.
    if (seen.has(key)) continue;
    if (seen.size >= limit) {
      truncated = true;
      break;
    }
    seen.add(key);
    visited.push(key);

    const declared = (await declaredBy(d.repo, d.number)) || [];
    const deps = declared.filter(nd => nd.merged);
    for (const nd of declared) {
      if (!nd.merged) stale.push(`${key} -> ${nd.repo}#${nd.number} (${nd.status})`);
    }
    if (deps.length) records.push({ repo: d.repo, number: d.number, deps });
    for (const nd of deps) queue.push(nd);
  }

  return { records, visited, stale, truncated };
}

async function main() {
  // One search per tracked author rather than one query with two `author:`
  // qualifiers. GitHub does OR repeated qualifiers, but the page's whole seed set
  // would then rest on that being true, and it costs one API call to not depend
  // on it. Deduped by repo#number: an author cannot appear twice, but a future
  // tracked list with an alias in it could.
  const found = [];
  const seenItem = new Set();
  for (const who of TRACKED_AUTHORS) {
    const items = await searchOpenPrs(who, ORG);
    console.log(`search: ${items.length} open PRs by ${who} in ${ORG}`);
    for (const item of items) {
      const key = `${item.repository_url.split('/repos/')[1]}#${item.number}`;
      if (seenItem.has(key)) continue;
      seenItem.add(key);
      found.push(item);
    }
  }

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

  const fetched = [];
  for (const item of found) {
    const repo = item.repository_url.split('/repos/')[1];
    const full = await getPr(repo, item.number);
    if (!full) continue;
    fetched.push(prRecord(full, repo, repoMeta.get(repo)));
  }
  // The search said open; the payload is what actually decides. See seedRecords().
  const { seed, stale } = seedRecords(fetched);
  if (stale.length) {
    console.log(
      `seed: ${stale.length} PR(s) came back from an \`is:open\` search but are no longer ` +
        `open, so they are not drawn: ${stale.join(', ')}`
    );
  }
  seed.sort((a, b) => a.repo.localeCompare(b.repo) || a.number - b.number);

  // The searches are scoped to the tracked authors, so this reclassifies nothing
  // today. It is here so "a node is MINE only if I wrote it" survives a widened
  // query rather than depending on one word in a search string: a PR by anybody
  // untracked that arrives through the seed search is treated as a candidate like
  // any other, marked as not mine, and kept only if it lands in a tracked
  // component. This is exactly the check chai3-bot must NOT be allowed to
  // short-circuit -- a bot's PR is seeded, but it is still not mine.
  const misfiled = seed.filter(p => !isTracked(p.author));
  if (misfiled.length) {
    console.log(
      `${misfiled.length} seed PR(s) not authored by ${TRACKED_AUTHORS.join(' or ')}: ` +
        `treated as anybody else's`
    );
  }

  // A tracked author's private-repo PR is WITHHELD and counted, never redacted
  // and drawn. Same deal for the bot as for me: the page says the work exists and
  // says nothing else about it.
  const withheldAll = seed.filter(p => isTracked(p.author) && p.private && !INCLUDE_PRIVATE);

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
      if (isTracked(rec.author)) return null; // withheld, and counted as withheld
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
  let feed = [];
  let trail = { records: [], visited: [], stale: [], truncated: false };
  for (let pass = 1; ; pass++) {
    for (const name of new Set([...pool.values()].map(p => p.repo))) await scanRepo(name);
    for (const p of pool.values()) await resolveDeps(p, repoMeta);

    // A candidate on no dependency edge at all was never in a chain, so it is not
    // something the component rule "left out" -- it is simply somebody else's
    // unrelated PR, and handing it to buildGraph would make `graph.pruned` a list
    // of every other open PR in the org instead of the chains this page declined
    // to draw. A TRACKED author's PRs go in regardless: each is at least a
    // component of one, which is the whole reason a lone chai3-bot PR with no
    // declared dependency is on the page at all.
    const onAnEdge = new Set();
    for (const p of pool.values()) {
      for (const d of p.deps) {
        onAnEdge.add(p.key);
        onAnEdge.add(`${d.repo}#${d.number}`);
      }
    }
    feed = [...pool.values()].filter(p => isTracked(p.author) || onAnEdge.has(p.key));
    graph = buildGraph(feed, isMine, trail.records, isBot);

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

  // --- the part of the trail that is already walked ----------------------
  //
  // Seeded from the edges of the graph AS IT STANDS, so a merged PR is followed
  // only when something actually drawn depends on it: a chain the component rule
  // already dropped is never walked. Merged targets resolve by number, so this
  // needs no further repo sweeping, and the graph is rebuilt once with the trail
  // records folded in. See expandMergedTrail().
  trail = await expandMergedTrail(
    graph.edges.map(e => e.edge),
    async (repo, number) => {
      const target = await getPr(repo, number);
      if (!target) return [];
      const out = [];
      for (const d of parseDeclarations(target.body || '', repo)) {
        if (out.some(e => e.repo === d.repo && e.number === d.number)) continue;
        out.push(markAuthor(await declaredEdge(d)));
      }
      return out.sort(edgeOrder);
    }
  );
  if (trail.records.length) graph = buildGraph(feed, isMine, trail.records, isBot);
  console.log(
    `trail: ${trail.visited.length} merged PR(s) walked, ${trail.records.length} of them carrying ` +
      `prerequisites of their own`
  );
  if (trail.truncated) {
    console.log(`trail: stopped at the ${TRAIL_LIMIT}-node limit, the drawing is incomplete`);
  }
  for (const st of trail.stale) {
    console.log(`trail: not drawn, a merged PR declared something that never landed: ${st}`);
  }

  const dupes = duplicateNodes(graph);
  if (dupes.length) {
    // Not a warning and not a footnote. One PR is one node, or the page is wrong.
    throw new Error(`a PR was built into more than one node: ${dupes.join(', ')}`);
  }
  const strays = mergedNonPrerequisites(graph);
  if (strays.length) {
    throw new Error(
      `a merged PR was drawn as something other than a prerequisite: ${strays.join(', ')}`
    );
  }

  // --- CI attribution ----------------------------------------------------
  //
  // The TRACKED authors' own open PRs, and only the ones actually drawn. An
  // untracked node states whose it is instead: "whose PR is this" outranks CI in
  // the one line a box has, and under the component rule that line is the only
  // thing standing between a foreign root and a reader who assumes the page is
  // all mine.
  //
  // A tracked bot's PR gets CI attributed because it is first-class work here --
  // it is drawn to be merged, and the same hover phrase should answer the same
  // question on it as on mine. It costs two or three API calls per bot PR, which
  // is why it is scoped to DRAWN nodes rather than to the pool.
  const drawnMine = graph.nodes.filter(n => n.kind === 'own').map(n => n.pr);
  const drawnBot = graph.nodes.filter(n => n.kind === 'bot').map(n => n.pr);
  const reviewInventory = await getReviewInventory(AUTHOR, ORG);
  const workflow = reviewQueues(drawnMine, reviewInventory, AUTHOR, REVIEWER);
  console.log(
    `review handoff: ${workflow.waitingForWan.length} waiting for @${REVIEWER}, ` +
      `${workflow.needsTony.length} need ${AUTHOR} to address feedback`
  );
  for (const pr of [...drawnMine, ...drawnBot]) {
    const prChecks = await getChecks(pr.repo, pr.headSha);
    const baseSha = await getBranchHead(pr.repo, pr.base);
    const baseChecks = baseSha ? await getChecks(pr.repo, baseSha) : [];
    pr.ci = classify(prChecks, baseChecks);
    pr.ci.baseRef = pr.base;
    pr.ci.baseSha = baseSha ? baseSha.slice(0, 7) : null;
  }

  // BEFORE the layout, because a card that carries an avatar reserves room for
  // it on its ref line, and cardOf() is what layoutGraph() measures with.
  graph.avatars = await collectAvatars(graph.nodes, getAvatar);
  const withAvatar = graph.nodes.filter(n => n.avatarId).length;
  console.log(
    `avatars: ${graph.avatars.length} inlined for ${withAvatar} of ${graph.nodes.length} card(s), ` +
      `${graph.avatars.reduce((n, a) => n + a.href.length, 0)} bytes of data URI; ` +
      `${graph.nodes.filter(n => n.hidden).length} withheld card(s) got none`
  );

  graph.layout = layoutGraph(graph);
  const groups = groupNodes(graph);

  const withheld = accountWithheld(
    withheldAll,
    graph.nodes.map(n => n.pr).filter(Boolean),
    isTracked,
    trail.records.flatMap(r => r.deps)
  );
  console.log(
    `withheld: ${withheld.count} (${withheld.blocking} of them block a PR shown on the page)`
  );
  console.log(
    `graph: ${graph.nodes.length} node(s), ${graph.edges.length} edge(s), ` +
      `${graph.layout.maxRank + 1} rank(s), ${graph.layout.width}x${graph.layout.height} canvas`
  );
  console.log(
    'card fill: ' +
      PR_STATES.map(st => `${st} ${graph.nodes.filter(n => n.state === st).length}`).join(', ')
  );
  for (const a of graph.abandoned) {
    console.log(
      `not drawn, a declared prerequisite was closed without merging: ${a.to.key} -> ` +
        `${a.hidden ? `#${a.number}` : `${a.repo}#${a.number}`} ` +
        `(the dependent is marked blocked instead)`
    );
  }
  const tracked = TRACKED_AUTHORS.join(' or ');
  console.log(
    `components: ${componentsOf(graph.nodes).length} drawn, each holding at least one PR by ` +
      `${tracked}; ${graph.pruned.length} candidate PR(s) dropped for being in a component with ` +
      `none of theirs${graph.pruned.length ? `: ${graph.pruned.join(', ')}` : ''}`
  );
  if (drawnBot.length) {
    console.log(
      `tracked bots: ${drawnBot.length} node(s) drawn as first-class work, marked but not counted ` +
        `among ${AUTHOR}'s: ` +
        graph.nodes
          .filter(n => n.kind === 'bot')
          .map(n => `${n.key} (@${n.author})`)
          .join(', ')
    );
  }
  const others = graph.nodes.filter(n => n.kind === 'dep');
  if (others.length) {
    console.log(
      `not ${tracked}'s, drawn because a component says so: ` +
        others
          .map(n => `${n.hidden ? `#${n.number}` : n.key}${n.author ? ` (@${n.author})` : ''}`)
          .join(', ')
    );
  }
  for (const g of groups) {
    console.log(
      `${g.repo}: ${g.count} mine` +
        (g.bots.length ? `, ${g.bots.length} by a tracked bot` : '') +
        (g.referenced.length ? `, ${g.referenced.length} in the graph but not tracked` : '') +
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
    total: drawnMine.length,
    bots: BOT_AUTHORS,
    botTotal: drawnBot.length,
    workflow,
    reviewer: REVIEWER
  });
  writeFileSync('dist/index.html', html);
  console.log(`wrote dist/index.html (${html.length} bytes, ${apiCallCount()} API calls)`);
}

// AUTHOR AVATARS, fetched once per AUTHOR and inlined into the SVG.
//
// The economics are the whole argument for inlining. There are twenty cards and
// three authors, so the cost is three images, not twenty: the bytes go in
// `<defs>` once each and every card is a `<use>` pointing at one. Hotlinking
// would instead cost the page its one defining property -- that it loads nothing
// at view time -- and would hand GitHub the IP of every visitor to a public page.
//
// THE PRIVACY RULE, and it is the only rule here that matters:
//
//   a hidden card contributes NO avatar, and no avatar is fetched for it.
//
// An avatar is authorship in a second channel. It survives the name being
// stripped, it is a picture of who opened a withheld PR, and the redaction
// scanner cannot see it -- that scanner matches repo names, and an avatar URL
// carries none. So hidden cards are skipped here as well as blanked upstream in
// redactPrivate() and decorateEdge(): three independent places, because this is
// the failure this page has already had twice by other means.
//
// The ids are `av1`, `av2`, ... and never the handle. An id built from a login
// would put the author's name back into the markup of a card that spent the rest
// of its existence not printing it.
//
// `fetchAvatar(url)` is passed in so this is testable without the network. A url
// that fails to fetch yields no id, and that card simply has no avatar: the
// geometry reserves room only when there is one, so nothing shifts either way.
export async function collectAvatars(nodes, fetchAvatar) {
  const byUrl = new Map();
  for (const n of nodes || []) {
    if (n.hidden || !n.avatarUrl) continue;
    if (!byUrl.has(n.avatarUrl)) byUrl.set(n.avatarUrl, { id: null, href: null });
  }

  const defs = [];
  let seq = 0;
  for (const [url, rec] of byUrl) {
    const href = await fetchAvatar(url);
    if (!href) continue;
    rec.id = `av${++seq}`;
    rec.href = href;
    defs.push({ id: rec.id, href });
  }

  for (const n of nodes || []) {
    const rec = !n.hidden && n.avatarUrl ? byUrl.get(n.avatarUrl) : null;
    n.avatarId = rec && rec.id ? rec.id : null;
  }
  return defs;
}

// WHAT STATE A CARD OF ITS OWN MAY BE IN.
//
// This page lists OPEN pull requests. Every query it seeds from says so -- the
// search is `is:pr is:open`, the sweep reads a repo's open PRs -- so in principle
// nothing else can arrive as a card of its own. In practice two things get past
// that, and both were live holes:
//
//   GitHub's SEARCH INDEX LAGS. A PR closed or merged seconds ago still comes
//   back from `is:open` for a while. The build then fetches the full payload,
//   which tells the truth, and believes the search string instead. A merged one
//   arriving this way trips mergedNonPrerequisites() and FAILS the build, which
//   is what aborted a publish earlier; a closed one trips nothing at all and is
//   simply drawn, as a full card, as though it were still work to do.
//
// The payload wins. It is the later and more specific fact, and it is the one
// the card is filled from anyway. Anything not open-or-draft is dropped from the
// seed and named in the log rather than silently discarded.
export const SEEDABLE_STATES = ['open', 'draft'];
export const seedable = rec => SEEDABLE_STATES.includes(rec && rec.state);

// Split what the search returned into what may actually be drawn and what has
// moved on since the index was written. Separated from main() so the WIRING is
// testable and not just the predicate: a guard that is never called is the same
// as no guard, and the first version of this was exactly that.
export function seedRecords(records) {
  const seed = [];
  const stale = [];
  for (const rec of records || []) {
    if (seedable(rec)) seed.push(rec);
    else stale.push(`${rec.key} (${rec.state})`);
  }
  return { seed, stale };
}

// Is a prerequisite already met?
//
// `merged` and `satisfied` are two different facts and both are reported, which
// is the same split `state` and `status` already make on a card: a release-gated
// prerequisite that has landed but not shipped is merged and NOT satisfied. The
// card is filled as merged because that is what the PR is; the edge stays live
// because the gate has not opened.
export async function resolveStatus(edge, target) {
  if (!target) return { satisfied: false, merged: false, status: 'unreadable' };

  if (!target.merged_at) {
    return {
      satisfied: false,
      merged: false,
      status: target.state === 'closed' ? 'closed unmerged' : 'open'
    };
  }

  if (!edge.needsRelease) return { satisfied: true, merged: true, status: 'merged' };

  // Release-gated: merging is not enough, it needs a published release AFTER
  // the merge landed.
  // The release that CARRIED the change is the EARLIEST one published after the
  // merge. getReleases() returns newest-first, so searching that order names the
  // newest release instead and the label drifts onto every later publish. Search
  // oldest-first. The copy matters: the list is cached and shared, and the
  // awaiting-release branch below still reads releases[0] as the newest.
  const releases = await getReleases(edge.repo);
  const mergedAt = new Date(target.merged_at);
  const after = [...releases]
    .sort((a, b) => new Date(a.publishedAt) - new Date(b.publishedAt))
    .find(r => new Date(r.publishedAt) > mergedAt);
  if (after) {
    return { satisfied: true, merged: true, status: `released in ${after.tag}`, release: after };
  }
  return {
    satisfied: false,
    merged: true,
    status: 'merged, awaiting release',
    latestRelease: releases[0] || null
  };
}

// What the "N PRs withheld" notice is allowed to count.
//
// The notice exists to admit the page is incomplete, so it must count only PRs
// the page would otherwise have DRAWN. Under the component rule that is: every
// TRACKED author's PRs (each is at least a component of one, so each is always
// drawn), plus anybody's PR that something drawn depends on. `tracked` is
// therefore the union predicate, not "is it mine" -- a bot's private-repo PR
// would have been drawn had the repo been public, so withholding it is something
// this notice has to own up to. A PR that is neither is missing
// from the graph for reasons that have nothing to do with privacy -- most often
// because no PR of mine is anywhere in its component -- and counting it as
// "withheld" would overstate what privacy is hiding.
//
// `drawn` is every PR record the graph kept, not only mine: somebody else's node
// can now carry the edge that makes one of my private PRs a blocker.
// `trailDeps` are the edges declared by already-merged PRs on the trail. A merged
// node has no PR record of its own -- it arrives as an edge target -- so its
// edges are handed in separately, and they put nodes on the page exactly as a
// drawn PR's own edges do.
export function accountWithheld(withheldPrs, drawn, tracked, trailDeps = []) {
  const referenced = new Set();
  const blockers = new Set();
  const take = d => {
    const key = `${d.repo}#${d.number}`;
    referenced.add(key);
    if (!d.satisfied) blockers.add(key);
  };
  for (const pr of drawn) for (const d of pr.deps || []) take(d);
  for (const d of trailDeps) take(d);

  const key = p => `${p.repo}#${p.number}`;
  const counted = withheldPrs.filter(p => tracked(p.author) || referenced.has(key(p)));
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
//
// `trail` carries the merged-trail rule into the graph: each record is
// `{repo, number, deps}` for a MERGED PR that declared prerequisites of its own.
// A record is spent only on a PR that is ALREADY a node -- which, since every PR
// this build fetches is open, means only when something depends on it. So the
// transitive half cannot pull in a merged PR nothing waits on, and a merged trail
// node is subject to the component rule like anything else: joined to a component
// with one of mine in it, or dropped with the rest of it.
//
// A merged PR is never `kind: 'own'`, even when it is mine. `own` means one of my
// OPEN PRs -- the ones that carry CI and that the total at the top counts -- and
// a merged one is neither. mergedNonPrerequisites() asserts it.
//
// `kind: 'bot'` is the third value, and it is exactly parallel to `own`: a
// TRACKED BOT's open PR. First-class in every structural sense -- it anchors its
// component, it is drawn wherever the ranking puts it, it carries CI -- and
// marked in every presentational one: `◇ @handle` on the card and a dotted
// outline, so it never reads as the page author's.
//
// Parallel to `own` includes the merged rule: a merged PR is never `kind: 'bot'`
// either. A merged PR reaches this page only as the target of somebody's edge,
// where attach() files it `dep`, and it is dashed there whoever wrote it --
// mine, the bot's, or a stranger's. Whose it is still shows, in the `◇ @handle`
// mark; what changes at the merge is that it stops being work to schedule and
// becomes a link of the trail. mergedNonPrerequisites() asserts both halves.
export function buildGraph(prs, mine = () => true, trail = [], bot = () => false) {
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
    const tracked = own || bot(pr.author);
    add({
      key,
      kind: own ? 'own' : bot(pr.author) ? 'bot' : 'dep',
      repo: pr.repo,
      number: pr.number,
      url: pr.url,
      title: pr.title,
      author: pr.author,
      // `foreign` is "not the PAGE author's", and a tracked bot's PR is foreign:
      // that is what earns it the `◇ @handle` mark, which is the same mark
      // anybody else's card gets and needs no new vocabulary. What separates the
      // two is `kind`, which the outline reads.
      foreign: Boolean(pr.author) && !own,
      hidden: Boolean(pr.hidden),
      // Both already nulled on a hidden record by redactPrivate(). Carried
      // through rather than re-derived, so there is ONE place a withheld card
      // loses its face and its date.
      avatarUrl: pr.hidden ? null : pr.avatarUrl || null,
      createdAt: pr.hidden ? null : pr.createdAt || null,
      // Only an UNTRACKED node states its status: every PR this build seeds is
      // open by construction, mine or the bot's, so printing "open" on one is the
      // same noise either way. The state is on the card regardless.
      status: tracked ? undefined : pr.status || 'open',
      // The fill. Every PR this build FETCHES is open, mine or not: the search
      // is `is:open` and the component sweep reads open PRs only. So a card
      // built from a record is open or draft, and merged reaches the page by
      // exactly one other route -- as an edge target, just below.
      state: pr.state || openPrState(pr),
      pr,
      needs: [],
      neededBy: []
    });
  }

  const edges = [];
  // A dependency on a pull request that was CLOSED WITHOUT MERGING.
  //
  // Merged and closed-unmerged are two different facts and this page has always
  // said so on a card; it did not act on the difference. A merged prerequisite is
  // drawn because it is a wait that is OVER: real merge-order information. A
  // closed-unmerged one is a wait that will never end. Nobody is going to merge
  // it, so drawing it to the LEFT of its dependent asserts a merge order that
  // cannot happen -- the same objection the merged-trail rule already makes to
  // following a merged PR's declaration to a target that is still open.
  //
  // So the card is not drawn and the edge is not drawn. What replaces them is
  // louder, not quieter: the DEPENDENT is marked `⊗ blocked` on its own card,
  // says so in its hover text and in the <desc>, and the page carries a fold
  // naming every one of them with the count in the summary. Dropping the edge and
  // saying nothing would be the worst of the three options, because a card with
  // no arrow arriving at it reads as ready to merge, and this one is the opposite
  // of ready.
  const abandoned = [];
  const isAbandoned = d =>
    Boolean(d) && !d.merged && (d.targetState === 'closed' || d.status === 'closed unmerged');

  const attach = (to, d) => {
    if (isAbandoned(d)) {
      abandoned.push({ to, repo: d.repo, number: d.number, url: d.url, hidden: Boolean(d.hidden) });
      (to.blockedBy ||= []).push({
        repo: d.repo,
        number: d.number,
        hidden: Boolean(d.hidden)
      });
      return null;
    }
    {
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
          // Same for an edge target: decorateEdge() nulled these the moment it
          // nulled the author, so a private target arrives here already blank.
          avatarUrl: d.hidden ? null : d.avatarUrl || null,
          createdAt: d.hidden ? null : d.createdAt || null,
          status: d.status,
          // A prerequisite is the ONLY way a merged PR reaches this page, and
          // this is where that happens: it is the target of somebody's edge, so
          // drawing it says something about merge order. `status` is how the
          // EDGE resolved ("merged, awaiting release"); `state` is what the PR
          // itself is. A release-gated prerequisite can be merged and still not
          // satisfy its edge, so the two are kept apart deliberately.
          state: d.targetState || 'unknown',
          // The same two facts the drawing reads separately. `merged` decides
          // whether this card is a link of the trail that is already walked;
          // `satisfied` decides whether the edge leaving it still holds its
          // dependent back. A release-gated prerequisite is the first and not
          // the second.
          merged: Boolean(d.merged),
          satisfied: Boolean(d.satisfied),
          edge: d,
          needs: [],
          neededBy: []
        });
      const e = { from, to, edge: d };
      edges.push(e);
      to.needs.push(e);
      from.neededBy.push(e);
      return from;
    }
  };

  for (const pr of prs) {
    const to = byKey.get(K(pr.repo, pr.number));
    for (const d of [...(pr.deps || [])].sort(edgeOrder)) attach(to, d);
  }

  // The transitive half of the merged-trail rule. A trail record is spent only
  // on a PR that is ALREADY a node, and following it can put new nodes on the
  // page, which may in turn be trail records themselves -- so this repeats until
  // nothing new appears rather than assuming the records arrive in chain order.
  //
  // It runs BEFORE pruneComponents(), so a merged trail belongs to the component
  // of the PR that needs it and is kept or dropped with it, in one piece.
  const trailByKey = new Map((trail || []).map(r => [K(r.repo, r.number), r]));
  const expanded = new Set();
  for (let grew = true; grew; ) {
    grew = false;
    for (const n of [...nodes]) {
      const rec = trailByKey.get(n.key);
      if (!rec || expanded.has(n.key)) continue;
      expanded.add(n.key);
      grew = true;
      for (const d of [...rec.deps].sort(edgeOrder)) {
        if (n.needs.some(e => e.from.key === K(d.repo, d.number))) continue;
        attach(n, d);
      }
    }
  }

  const graph = { nodes, edges, byKey };
  // Carried on the graph so the page can name what it declined to draw, exactly
  // as `pruned` and the cycle-cut edges are. Nothing declared is dropped in
  // silence.
  graph.abandoned = abandoned;
  graph.pruned = pruneComponents(graph, login => mine(login) || bot(login));
  // A note about a card that is no longer on the page is not a note about
  // anything. Filtered AFTER pruning for that reason.
  graph.abandoned = graph.abandoned.filter(a => byKey.has(a.to.key));
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
// least one PR in it is TRACKED. A component with nothing tracked in it is
// dropped whole: not a lone node kept for context, not a stub, nothing. The keys
// of every PR dropped that way come back for `graph.pruned`, so what the page
// leaves out is stated rather than quietly filtered.
//
// `anchors` is the tracked-author predicate: the page author, plus any tracked
// bot. It is deliberately read off the node's AUTHOR and not off its kind, so a
// tracked author's MERGED PR -- which arrives as an edge target and is therefore
// `kind: 'dep'` -- anchors its component too. That was already true of mine and
// is now true of the bot's, for the same reason: a merged PR of ours is still
// ours, and the chain it sits in is still work this page is about.
//
// This is the ONLY clause that decides whether a bot's PR is on the page. There
// is no rule anywhere in this build about WHERE an untracked or bot node may sit
// -- no leaf rule, no root rule. Rank is computed from edges alone.
//
// Cycle-cut edges count as connections here. Ranking cuts the edge that closes a
// cycle so the layout terminates, but the two PRs it joins are still one piece of
// work -- which is why this runs BEFORE rankNodes().
export function pruneComponents(graph, anchors = () => true) {
  const keep = new Set();
  const dropped = [];
  for (const comp of componentsOf(graph.nodes)) {
    if (comp.some(n => n.kind === 'own' || n.kind === 'bot' || anchors(n.author))) {
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
// WHEN A MERGED PR IS ALLOWED ON THIS PAGE.
//
// Every PR this build fetches is open: the seed search is `is:pr is:open`, and
// the component sweep reads a repo's OPEN pull requests. So nothing merged is
// ever picked up as a card of its own. A merged PR earns a place in exactly one
// way -- something drawn here declares it as a prerequisite -- and then drawing
// it is real merge-order information: that is a blocker which has already gone
// away. It is the target of an edge and nothing else, so it always sits to the
// LEFT of the PR it unblocked and always has at least one arrow leaving it.
//
// The alternative, sweeping in every merged PR in the org, would bury the twenty
// open ones under hundreds of finished ones and answer a question nobody asked.
//
// So: merged means prerequisite, and this asserts it instead of trusting the
// search string -- the same reason duplicateNodes() is an assertion and not a
// footnote.
// `kind: 'bot'` is checked alongside `own` for the same reason: both mean "a
// tracked author's OPEN pull request", and a merged PR is neither.
export function mergedNonPrerequisites(graph) {
  return graph.nodes
    .filter(
      n =>
        n.state === 'merged' &&
        (n.kind === 'own' || n.kind === 'bot' || n.neededBy.length === 0)
    )
    .map(n => n.key);
}

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
// of implying it is mine. A tracked bot's PR gets its own bucket, `g.bots`, for
// exactly that reason: it is neither mine nor merely referenced, and folding it
// into either would misstate one of the two.
export function groupNodes(graph) {
  const byRepo = new Map();
  const take = (key, label) => {
    if (!byRepo.has(key))
      byRepo.set(key, { repo: key, label, mine: [], bots: [], referenced: [] });
    return byRepo.get(key);
  };

  for (const n of graph.nodes) {
    const g = n.hidden
      ? take(WITHHELD_GROUP, 'private repos — names withheld')
      : take(n.repo, n.repo);
    (n.kind === 'own' ? g.mine : n.kind === 'bot' ? g.bots : g.referenced).push(n);
  }

  const groups = [...byRepo.values()].sort(
    (a, b) =>
      Number(a.repo === WITHHELD_GROUP) - Number(b.repo === WITHHELD_GROUP) ||
      a.repo.localeCompare(b.repo)
  );

  for (const g of groups) {
    g.mine.sort((a, b) => a.number - b.number);
    g.bots.sort((a, b) => a.number - b.number);
    g.referenced.sort((a, b) => a.number - b.number);
    g.withheld = g.repo === WITHHELD_GROUP;
    g.count = g.mine.length;
    g.botCount = g.bots.length;
    g.nodes = [...g.mine, ...g.bots, ...g.referenced];
    // Nothing on this page waits on these, so they are this repo's merge-last.
    // A tracked bot's PR counts: this is about what is schedulable, and a bot's
    // open PR is as schedulable as mine.
    g.last = [...g.mine, ...g.bots].filter(n => n.neededBy.length === 0);
  }
  return groups;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch(e => {
    console.error(e);
    process.exit(1);
  });
}
