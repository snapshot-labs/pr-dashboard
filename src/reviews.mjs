// HUMAN APPROVAL -- the thing a card's BORDER WEIGHT encodes.
//
// A card is drawn with a thicker border when a human teammate has approved that
// pull request. It is a second, independent axis from the fill: the fill is what
// the PR IS (open, draft, merged), the border weight is whether somebody has
// signed it off. A PR can be any state and approved, or any state and not.
//
// TWO THINGS THIS FILE IS CAREFUL ABOUT, because both of them are ways to
// overstate an approval that is not there.
//
// 1. THE LATEST REVIEW PER REVIEWER, NEVER A HISTORICAL ONE.
//
// GitHub's reviews endpoint is an append-only LOG, not a verdict: every review
// anyone ever submitted is in it, in submission order. So a reviewer who
// approved in July and requested changes in August appears as both, and reading
// "is there an APPROVED row" would report that PR as approved for good. What
// counts is each reviewer's LAST word.
//
// Only three states are a word about the change: APPROVED, CHANGES_REQUESTED
// and DISMISSED. COMMENTED and PENDING are deliberately NOT deciding states --
// that is GitHub's own semantics, and it is the common case in this org's data:
// nearly every approval here is followed by more COMMENTED rows, from the
// approver and from others, and treating a comment as a retraction would erase
// almost every approval on the page. A dismissed approval, on the other hand,
// is not a new row at all: GitHub rewrites that review's own state to
// DISMISSED, so the latest-state rule drops it with no special case.
//
// 2. A BOT IS NOT A TEAMMATE, AND NEITHER IS THE PAGE AUTHOR.
//
// The point of the marker is that a HUMAN OTHER THAN THE PAGE AUTHOR has looked
// at it. So two exclusions, and they work in opposite directions on purpose:
//
//   - the page author is excluded through the SAME predicate the rest of the
//     build uses for "mine" (build.mjs isMineFor), so this is not a second
//     place PR_AUTHOR is spelled out.
//   - bots are excluded BY TYPE first: `user.type === 'Bot'` is what the API
//     says about a GitHub App, and the `[bot]` login suffix catches the same
//     account when a payload arrives without the type. That covers
//     copilot-pull-request-reviewer[bot] and anything else installed later with
//     no code change here.
//
// REVIEW_BOTS is the exception list, and it is deliberately as short as it can
// be. `chai3-bot` is a bot by NAME only -- it is an ordinary user account, so
// the API calls it `type: "User"` and neither test above sees it. There is no
// way to know it is automation except to know it, so it is named. Everybody
// else is a human: a new colleague's approval counts the day they join, with no
// edit to this file. That asymmetry is the whole design -- the list of humans is
// never enumerated, only the two accounts that are not.

// The named non-App bots. Lowercase; matching is case-insensitive.
export const REVIEW_BOTS = new Set(['chai3-bot']);

// Review states that are a verdict on the change. Everything else -- COMMENTED,
// PENDING -- leaves the reviewer's last verdict standing.
export const DECIDING_REVIEW_STATES = new Set(['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED']);

export function isBotReviewer(user) {
  // No user on a review at all: not a human approval. An approval nobody can be
  // named for is not one this page will draw a border for.
  if (!user) return true;
  if (String(user.type || '').toLowerCase() === 'bot') return true;
  const login = String(user.login || '');
  if (/\[bot\]$/i.test(login)) return true;
  return REVIEW_BOTS.has(login.toLowerCase());
}

// Every reviewer's LAST deciding review, keyed by lowercased login.
//
// Ordered by `submitted_at` rather than by array position: the endpoint does
// return the log in order, but the whole correctness of the marker rests on
// "latest", so it is read off the timestamps and the array index is only the
// tie-break for two reviews submitted in the same second.
export function latestReviewByReviewer(reviews) {
  const latest = new Map();
  (reviews || []).forEach((r, i) => {
    const state = String(r && r.state ? r.state : '').toUpperCase();
    if (!DECIDING_REVIEW_STATES.has(state)) return;
    const user = r.user || null;
    const login = user && user.login ? String(user.login) : null;
    if (!login) return;
    const at = Date.parse(r.submitted_at || '') || 0;
    const key = login.toLowerCase();
    const prev = latest.get(key);
    if (prev && (prev.at > at || (prev.at === at && prev.i > i))) return;
    latest.set(key, { login, state, at, i, user });
  });
  return latest;
}

// The handles of the humans whose latest word on this PR is APPROVED.
//
// `isSelf` is the build's own "is this mine" predicate, so the page author's own
// approval never counts here and PR_AUTHOR is not named twice in the codebase.
// Ordered by when the approval landed, so the first person to sign off reads
// first.
export function humanApprovers(reviews, isSelf = () => false) {
  return [...latestReviewByReviewer(reviews).values()]
    .filter(r => r.state === 'APPROVED')
    .filter(r => !isBotReviewer(r.user))
    .filter(r => !isSelf(r.login))
    .sort((a, b) => a.at - b.at || a.i - b.i)
    .map(r => r.login);
}

// The marker glyph. A tick, because that is what an approval is; the word
// "approved" travels with it everywhere it is printed, so the glyph is never
// asked to carry the meaning on its own.
export const APPROVED_GLYPH = '✓';

// The card marker, which has one card-width line to say it in. Two handles fit;
// past that the rest are counted, because a truncated list of handles would name
// some reviewers and silently drop others.
export function approvedText(logins) {
  const list = (logins || []).filter(Boolean);
  if (!list.length) return null;
  const shown = list.slice(0, 2).map(l => `@${l}`);
  const rest = list.length - shown.length;
  return `approved ${shown.join(', ')}${rest ? ` +${rest}` : ''}`;
}

// The long form, for the card's hover text and the text alternative. Nothing is
// truncated here: every approver is named.
export function approvedLabel(logins) {
  const list = (logins || []).filter(Boolean);
  if (!list.length) return null;
  return `approved by ${list.map(l => `@${l}`).join(', ')}`;
}
