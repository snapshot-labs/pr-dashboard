// PR STATE -- the thing a card's fill colour encodes.
//
// GitHub has no "draft" state, and this is the trap the mapping has to avoid.
// A pull request payload carries THREE independent fields:
//
//   state      "open" | "closed"   -- and nothing else, ever
//   draft      true | false        -- `isDraft` in GraphQL, a FLAG, not a state
//   merged_at  null | timestamp    -- null until the PR actually merges
//
// So a draft is an OPEN pull request with a flag set, not a third value of
// `state`; and "merged" is not a value of `state` at all -- a merged PR reads
// `state: "closed"` with a non-null `merged_at`, which is the only field that
// separates it from a PR that was closed and thrown away.
//
// Hence the order below. `merged_at` is checked FIRST, because every merged PR
// is also closed and testing `state` first would file it as closed. `draft` is
// checked only inside the open branch, because GitHub leaves the flag set on a
// PR that was closed while still a draft, and "draft" would then hide the fact
// that it is closed.
//
// Nothing here reads `payload.merged`: the pulls LIST endpoint does not return
// that field, only the single-PR endpoint does, so trusting it would classify
// every stack parent as unmerged.

export const PR_STATES = ['open', 'draft', 'merged', 'closed', 'unknown'];

export function prState(payload) {
  if (!payload) return 'unknown';
  if (payload.merged_at) return 'merged';
  if (payload.state === 'closed') return 'closed';
  if (payload.state === 'open') return payload.draft === true ? 'draft' : 'open';
  return 'unknown';
}

// The dashboard's own PRs arrive from an `is:pr is:open` search, so their state
// is open-or-draft by construction and the flag alone decides it. This is the
// fallback for a PR object that carries the flag but not a derived state; the
// build sets `state` explicitly from the full payload.
export const openPrState = pr => (pr && pr.draft === true ? 'draft' : 'open');

// Colour is never the only carrier. Every state ships a glyph as well as a
// fill, and the glyphs are a greyscale progression -- hollow, dotted, solid --
// so they separate with no colour vision at all, on a monochrome screen, and in
// print. The legend prints the glyph next to the swatch and the word.
export const STATE_GLYPH = {
  open: '○',
  draft: '◌',
  merged: '●',
  closed: '✕',
  unknown: '?'
};

export const STATE_WORD = {
  open: 'open',
  draft: 'draft',
  merged: 'merged',
  closed: 'closed',
  unknown: 'state unknown'
};

// The long form, for the card's hover text and the legend. No dash inside any of
// them: the hover text joins its parts with one, and a label carrying its own
// would read as two facts.
export const STATE_LABEL = {
  open: 'open, and marked ready for review',
  draft: 'draft, not yet marked ready for review',
  merged: 'merged, a prerequisite that has already landed',
  closed: 'closed without being merged',
  unknown: 'state unknown, the PR could not be read'
};

// Which fill a state gets. Kept as one map so the SVG, the legend swatch and
// the list badge cannot drift apart: they all name the same CSS variable.
export const STATE_CLASS = s => `st-${PR_STATES.includes(s) ? s : 'unknown'}`;
