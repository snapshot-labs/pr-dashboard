// The dependency graph: a layered layout, and the inline SVG it is drawn as.
//
// Generated at BUILD TIME, which is the constraint that shaped this file. The
// dashboard is one static HTML file served from GitHub Pages, so there is no
// Mermaid, no d3, no CDN and no <script> tag anywhere: build.mjs asks for a
// finished <svg> string and writes it into the document. Nothing is computed in
// the browser.
//
// DIRECTION -- the one thing a dependency picture must never leave ambiguous:
//
//   the graph reads LEFT TO RIGHT. A PR sits to the RIGHT of the things it
//   needs. Every arrow runs from a prerequisite RIGHTWARD to the PR that waits
//   on it, so the leftmost column merges FIRST, the rightmost column merges
//   LAST, and reading the picture left to right IS merge order.
//
// THE TWO AXES, which is the other thing it must not leave ambiguous:
//
//   x carries order, y carries none. One rank is one COLUMN, and two PRs in the
//   same column can never have an edge between them -- a drawn edge always
//   pushes its head into a later column -- so the vertical stacking inside a
//   column is packing and nothing more.
//
//   That is why a rank is NEVER folded into a second column, however tall it
//   gets: a folded rank reads as two ranks, which is an order that is not there.
//   A rank with twenty members is one tall column, and a graph twenty ranks deep
//   is very wide and scrolls sideways. Both are the intended shape.
//
// WHAT A CARD SAYS. A card is the PR's ref and the PR's TITLE, because a bare
// number is not a thing anyone recognises. Everything that was a status label --
// CI wording, rank, "no prerequisites" -- is off the card: it made the card wide
// and told the reader nothing about what merges before what. Five markers
// survive, because each of them changes when or whether an edge clears, and each
// has a legend entry under the drawing:
//
//   ◇ @handle   this PR is not the dashboard author's, so it is not theirs to merge
//   ⊘ ...       the PR's OWN TITLE says do not merge (lifted out of the title so
//               that truncating the title can never hide it)
//   ⊗ blocked   waits on a prerequisite that was closed without merging
//   ✓ approved  a human teammate has approved it -- see src/reviews.mjs for what
//               counts as one, and the thicker border below
//   GATED       on an EDGE: satisfied by a published release, not by a merge
//
// WHAT A CARD'S BORDER WEIGHT MEANS: approved by a human. A thicker outline is
// the second channel for the ✓ marker above, and it is deliberately a channel
// the fill does not use, so "what state is it" and "has anybody signed it off"
// never compete for the same ink. A stroke width is not readable on its own --
// nobody measures a border -- which is exactly why the marker line and the
// legend entry are not optional extras to it.
//
// It also has to coexist with the DASHED outline that says "not mine": a PR can
// be somebody else's AND approved, so the two facts are drawn as weight and as
// dash pattern rather than both as one stroke, and an approved foreign card is a
// thick dashed box with both markers on it.
//
// WHAT A CARD IS FILLED WITH: the STATE of that pull request -- open, draft,
// merged, or closed for a prerequisite that was abandoned. Colour on this canvas
// means that and only that, which is what makes the fill readable at all.
// "draft" left the marker lines and became a fill, so it costs no room.
//
// Never colour alone. Every card prints its state as a glyph AND a word on the
// ref line, opposite the ref: hollow for open, dotted for draft, solid for
// merged. The glyphs are a greyscale progression, so the states separate with no
// colour vision, on a monochrome screen and on a monochrome printer, and the
// word is there for a reader who takes neither.
//
// It is a GRAPH and not a tree: a PR that TWO others need is ONE node with two
// arrows leaving it. No node is ever drawn twice.
//
// One page-wide graph, not one per repo. The edge that forced this shape --
// snapshot.js#1225 -> stamp#491 -- crosses repos, and an arrow cannot be drawn
// between two separate <svg> elements without client-side code.
//
// THE SVG IS ALSO THE PAGE'S TEXT ALTERNATIVE. The per-PR list that used to sit
// underneath is gone, so <desc> carries the whole structure in words -- every
// column, who stands in it, and every edge -- and every node and every edge
// carries a <title> of its own.

import { CI_LABEL } from './ci.mjs';
import { APPROVED_GLYPH, approvedLabel, approvedText } from './reviews.mjs';
import { PR_STATES, STATE_CLASS, STATE_GLYPH, STATE_LABEL, STATE_WORD } from './state.mjs';

export const esc = s =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

export const shortRef = (repo, number) => `${String(repo).split('/').pop()}#${number}`;

// Geometry. The canvas is as deep as the graph is long and as tall as its
// biggest rank, and neither is capped: shrinking the text or folding a rank
// costs more than a scrollbar does.
//
// The card is wide enough for a real PR title on two or three lines. That is
// what made it grow from 150x40; it is the point of the rework, not a side
// effect of it.
export const NODE_W = 270;
export const NODE_H = 44; // the MINIMUM card height; a card is as tall as its title
export const ROW_GAP = 12; // between two cards stacked in one column
export const RANK_GAP = 96; // between rank columns: where the arrows live
export const LANE_H = 48; // header lane above every column, carrying its label
const PAD = 10;

// The card outline, and the one case that thickens it: a human has approved the
// PR. Emitted as a presentation attribute rather than a CSS rule, like the rest
// of the geometry, so the border weight survives the stylesheet being stripped.
// 1 to 2.5 is a difference that reads at a glance next to an ordinary card; it
// is still never the only thing saying so (see nodeMarks()).
export const BOX_STROKE = 1;
export const BOX_STROKE_APPROVED = 2.5;

// Inside a card.
const CARD_PAD_X = 10;
const CARD_PAD_B = 9;
const REF_Y = 15;
const REF_SIZE = 10.5;
const TITLE_TOP = 30;
const TITLE_SIZE = 11;
const TITLE_LINES = 3;
const LINE_H = 13;
const MARK_GAP = 3;
const MARK_H = 12;
const MARK_SIZE = 9.5;
const TEXT_W = NODE_W - 2 * CARD_PAD_X;

// The author's avatar, on the ref line at the left of the card.
//
// It sits THERE, and not in a corner, for a layout reason and a meaning reason.
// The layout reason: the ref line is the one row whose contents are clipped to a
// measured width, so taking room from it costs one subtraction and cannot push
// anything out of the card -- the title rows are wrapped to TEXT_W and moving
// them would change every card's height. The meaning reason: the card then reads
// who, what, and what state, left to right, in one line.
//
// It is 14px because it is a reinforcement and not a channel of its own. Whose a
// card is, is said by the outline and by `◇ @handle`; the avatar agrees with them
// and carries nothing they do not.
const AV = 14;
const AV_GAP = 6;
export const AVATAR_PX = AV;

const lastTitleY = rows => TITLE_TOP + (Math.max(1, rows) - 1) * LINE_H;
const markY = (rows, j) => lastTitleY(rows) + MARK_GAP + MARK_H + j * MARK_H;
const cardHeight = (rows, marks) =>
  Math.max(NODE_H, (marks ? markY(rows, marks - 1) : lastTitleY(rows)) + CARD_PAD_B);

// --- fitting text into a box without a browser ---------------------------
//
// There is no measuring API at build time, so character advance has to be
// estimated -- and a title is only as safe as that estimate, because a card
// sized by a wrong one puts text out through its own side. "MMM" and "iii" are
// not the same width, so this is a per-character table rather than an average.
//
// The numbers are MEASURED, not guessed: every printable character was rendered
// in a headless browser in this exact font stack and size, its advance divided
// out, and each bucket then rounded UP by five to eight per cent. Two reasons
// for the rounding. The measuring font here is DejaVu Sans, one of the widest
// common UI sans faces, so a narrower face elsewhere only leaves extra padding;
// and an unlisted character (an accent, a CJK glyph) falls through to a wide
// default rather than a cheap one. The failure mode is a slightly short line,
// never an overflowing one.
const CHAR_EM = new Map();
const bucket = (w, chars) => {
  for (const c of chars) CHAR_EM.set(c, w);
};
bucket(0.3, "'ijl");
bucket(0.32, 'IJ');
bucket(0.34, ' ,.·’‘');
bucket(0.36, '/:;\\');
bucket(0.38, 'f-');
bucket(0.42, '()[]tr!|');
bucket(0.5, '"');
bucket(0.54, '*_`–∥“”sz');
bucket(0.58, '?cLF');
bucket(0.62, 'kvxyTPYoae');
bucket(0.66, 'EhnuSbdgpq$0123456789{}K');
bucket(0.72, 'VXZBRCA');
bucket(0.78, 'UNHD◇');
bucket(0.82, 'GQO&');
bucket(0.88, 'w#+<=>^~⊘✓✗○◌●✕');
bucket(0.92, 'M');
bucket(1.0, '%mW');
bucket(1.06, '@…—');
const EM_DEFAULT = 0.8;
const EM_WIDE_SCRIPT = 1.1; // CJK and friends are full-width
const EM_MONO = 0.62; // measured 0.6021 in the monospace stack

export function textWidth(s, size, mono = false) {
  const str = String(s ?? '');
  if (mono) return [...str].length * EM_MONO * size;
  let em = 0;
  for (const ch of str) {
    const w = CHAR_EM.get(ch);
    if (w !== undefined) em += w;
    else em += ch.codePointAt(0) > 0x2e80 ? EM_WIDE_SCRIPT : EM_DEFAULT;
  }
  return em * size;
}

// Greedy word wrap to a pixel budget. A word too long for a line on its own is
// hard-broken rather than allowed to overflow. Past `maxLines` the text is cut
// and the last line ends in an ellipsis -- and the FULL title is always still on
// the node's <title>, so truncating never loses it.
export function wrapText(s, maxPx, size, maxLines) {
  const words = String(s ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const all = [];
  let cur = '';

  for (const word of words) {
    let w = word;
    while (textWidth(w, size) > maxPx) {
      if (cur) {
        all.push(cur);
        cur = '';
      }
      let cut = w.length;
      while (cut > 1 && textWidth(w.slice(0, cut), size) > maxPx) cut--;
      all.push(w.slice(0, cut));
      w = w.slice(cut);
    }
    if (!w) continue;
    const next = cur ? `${cur} ${w}` : w;
    if (cur && textWidth(next, size) > maxPx) {
      all.push(cur);
      cur = w;
    } else {
      cur = next;
    }
  }
  if (cur) all.push(cur);

  if (all.length <= maxLines) return all;
  const kept = all.slice(0, maxLines);
  let last = kept[maxLines - 1];
  while (last.length > 1 && textWidth(`${last}…`, size) > maxPx) last = last.slice(0, -1);
  kept[maxLines - 1] = `${last.replace(/[\s,.;:·-]+$/, '')}…`;
  return kept;
}

export function clipToWidth(s, maxPx, size, mono = false) {
  const str = String(s ?? '');
  if (textWidth(str, size, mono) <= maxPx) return str;
  let cut = str.length;
  while (cut > 1 && textWidth(`${str.slice(0, cut)}…`, size, mono) > maxPx) cut--;
  return `${str.slice(0, cut)}…`;
}

// A node's ref. A target in a private repo shows its number and NOT the repo
// name -- the page is public, and the repo name is part of what is withheld.
export const nodeRef = n => (n.hidden ? `#${n.number}` : shortRef(n.repo, n.number));

// A PR whose own title says DO NOT MERGE.
//
// The words are lifted OUT of the title and onto a marker line of their own, for
// one reason: a title is wrapped and can be truncated, and a truncated
// "[DO NOT MERGE until migration is run]" would leave the PR reading as ready.
// On its own line it cannot be cut away by a long title.
export function splitHold(title) {
  const s = String(title ?? '');
  const bracketed = s.match(/[[(]\s*(do\s*not\s*merge\b[^\])]*)[\])]/i);
  if (bracketed) {
    return {
      title: (s.slice(0, bracketed.index) + s.slice(bracketed.index + bracketed[0].length))
        .replace(/\s+/g, ' ')
        .trim(),
      hold: bracketed[1].replace(/\s+/g, ' ').trim()
    };
  }
  const bare = s.match(/\bdo\s*not\s*merge\b[^.;:]*/i);
  // Not bracketed: the title is left exactly as its author wrote it, and the
  // phrase is repeated on the marker line so truncation cannot hide it.
  if (bare) return { title: s, hold: bare[0].replace(/\s+/g, ' ').trim() };
  return { title: s, hold: null };
}

// WHAT THE CARD IS FILLED WITH: the state of the pull request.
//
// One place, so the fill, the glyph and word on the card, the swatch in the
// legend and the sentence in the <desc> are all reading the same value and
// cannot disagree. The glyph is not decoration: it is the second channel, so a
// reader who cannot separate the fills still separates the states.
export function nodeState(n) {
  const state = PR_STATES.includes(n.state) ? n.state : 'unknown';
  return {
    state,
    cls: STATE_CLASS(state),
    glyph: STATE_GLYPH[state],
    word: STATE_WORD[state],
    label: STATE_LABEL[state]
  };
}

// Who has approved this PR, as the build attached it (build.mjs
// attachApprovals): the humans whose latest review is an approval, page author
// and bots already filtered out.
//
// A WITHHELD CARD NAMES NOBODY, REVIEWER INCLUDED. A card out of a private repo
// has already lost its title, its author and its repo name; a reviewer handle is
// the same kind of fact about work this page is not showing, so it is dropped
// here as well rather than trusted not to have been fetched. The build does not
// fetch reviews for a hidden node either -- this is the second lock on the same
// door, because the border is drawn from this function.
export const nodeApprovers = n =>
  !n || n.hidden || !Array.isArray(n.approvedBy) ? [] : n.approvedBy.filter(Boolean);
export const nodeApproved = n => nodeApprovers(n).length > 0;

// The markers a card is allowed to carry. Everything else that used to be a
// badge is gone; these stay because each one changes whether or when something
// can merge, and each is explained in the legend under the drawing.
//
// "draft" is not among them: it is the card's FILL now, which costs no line.
//
// The authorship marker earns its place twice over since the page started drawing
// whole components. It used to sit on a card that could only ever be the target of
// one of the author's arrows; now somebody else's PR can be the leftmost card in
// the picture with prerequisites of its own, and this marker plus the dashed
// outline are the only things saying whose it is.
//
// A tracked bot's card takes the SAME marker, by the same test -- it is not the
// page author's, so it says whose it is. What separates it from an ordinary
// foreign card is the outline (dotted, not dashed), which is a second channel and
// not the one carrying the handle. Nothing here rests on telling one dash pattern
// from another: the handle is printed.
// How a blocked-on-abandoned dependency is named on a card. A withheld target
// keeps its number and loses its repo name here exactly as it does everywhere
// else: a card that is careful not to print a private repo name must not print
// one in the reason it is blocked either.
export const blockedRef = b => (b.hidden ? `#${b.number}` : shortRef(b.repo, b.number));

// The approval marker goes LAST and the cap is three, not two, for one reason:
// a card can be somebody else's and approved at the same time, and either fact
// alone is a different picture from both together. Dropping the approval to keep
// the card two lines shorter would silently unmark the exact case the border
// weight exists for.
export function nodeMarks(n, hold) {
  const out = [];
  if (hold) out.push({ role: 'critical', glyph: '⊘', text: hold });
  // A prerequisite that was closed without merging. The card it pointed at is
  // NOT drawn -- nobody will merge it, so putting it in the merge order would
  // assert an order that cannot happen -- and this mark is what stops the
  // dependent reading as ready just because no arrow arrives at it.
  if (n.blockedBy && n.blockedBy.length) {
    const refs = n.blockedBy.map(blockedRef).join(', ');
    out.push({ role: 'critical', glyph: '⊗', text: `blocked: ${refs} closed unmerged` });
  }
  if (n.hidden) out.push({ role: 'foreign', glyph: '◇', text: 'private repo' });
  else if (n.kind !== 'own') {
    if (!n.author) out.push({ role: 'foreign', glyph: '?', text: 'author unknown' });
    else if (n.foreign) out.push({ role: 'foreign', glyph: '◇', text: `@${n.author}` });
  }
  const approvers = nodeApprovers(n);
  if (approvers.length) {
    out.push({ role: 'approved', glyph: APPROVED_GLYPH, text: approvedText(approvers) });
  }
  return out.slice(0, 3);
}

// Everything drawn inside one card, and how tall that makes it.
export function cardOf(n) {
  const { title, hold } = splitHold(n.title);
  const known = Boolean(String(title || '').trim());
  const shown = known ? title : n.hidden ? 'title withheld (private repo)' : 'title unavailable';
  const lines = wrapText(shown, TEXT_W, TITLE_SIZE, TITLE_LINES);
  const marks = nodeMarks(n, hold).map(m => ({
    ...m,
    text: clipToWidth(m.text, TEXT_W - 12, MARK_SIZE)
  }));
  // The state shares the ref's line, pinned to the right edge, so it costs the
  // card no height at all -- and the ref is measured against what is left rather
  // than against the whole width, so the two can never collide.
  const state = nodeState(n);
  const stateText = `${state.glyph} ${state.word}`;
  // A withheld card never carries an avatar, whatever else it is holding. This
  // is the third of the three independent gates -- build.mjs blanks the url on
  // the record and again on the edge -- and it is the last one before markup.
  const avatar = n.hidden ? null : n.avatarId || null;
  const avRoom = avatar ? AV + AV_GAP : 0;
  const refRoom = TEXT_W - textWidth(stateText, MARK_SIZE) - 10 - avRoom;
  return {
    avatar,
    avRoom,
    ref: clipToWidth(nodeRef(n), refRoom, REF_SIZE, true),
    state,
    stateText,
    title: shown,
    fullTitle: n.title || null,
    hold,
    // The border weight, decided once here so the rect and the <g> class cannot
    // disagree about it.
    approved: nodeApproved(n),
    approvedBy: nodeApprovers(n),
    dim: !known,
    lines: lines.length ? lines : [shown],
    marks,
    height: cardHeight(lines.length || 1, marks.length)
  };
}

// The hover text for one card: the whole PR, untruncated, plus the edges it sits
// on. With the per-PR list gone this is where a reader gets the detail back.
export function nodeTitleText(n) {
  const bits = [nodeRef(n)];
  bits.push(n.title || (n.hidden ? 'title withheld (private repo)' : 'title unavailable'));
  // The state in words, for every card and not only for a draft: this is the
  // fill spelled out, and it is what a reader gets who cannot use the colour.
  bits.push(nodeState(n).label);
  // CI is attributed to the tracked authors' own open PRs, mine and a tracked
  // bot's alike, so the same phrase answers the same question on both.
  if (n.kind === 'own' || n.kind === 'bot') {
    if (n.pr && n.pr.ci) bits.push(CI_LABEL[n.pr.ci.state] || 'CI state unknown');
  }
  if (n.hidden) bits.push('private repo, details withheld');
  else if (n.kind === 'bot')
    bits.push(`@${n.author} — a tracked bot's PR, drawn and scheduled like the page author's`);
  else if (n.kind !== 'own') {
    if (!n.author) bits.push('author unknown');
    else if (n.foreign) bits.push(`@${n.author} — not yours to merge`);
  }
  // Said in full words. The hover text is where a reader gets the detail back
  // now that the per-PR list is gone, and "already merged" is the detail that
  // decides whether a card to the left is still in anybody's way.
  if (n.merged)
    bits.push(
      n.satisfied
        ? 'already merged — drawn because something here still depends on it, and nothing is waiting on it any more'
        : 'already merged, but release-gated: the merge landed and the gate has not opened, so it is still in the way'
    );
  // The border weight, spelled out. Same argument as the state: a reader who
  // cannot see the outline gets the fact here, with the handles the card face
  // may have had to abbreviate.
  if (nodeApproved(n)) bits.push(approvedLabel(nodeApprovers(n)));
  if (n.status) bits.push(n.status);
  if (n.blockedBy && n.blockedBy.length) {
    bits.push(
      `blocked on ${n.blockedBy.map(blockedRef).join(', ')}, closed without merging — nothing will` +
        ' merge that, so this cannot proceed as declared'
    );
  }

  const live = (n.needs || []).filter(e => !e.cycle);
  const out = (n.neededBy || []).filter(e => !e.cycle);
  bits.push(
    live.length
      ? `merges after ${live.map(e => nodeRef(e.from)).join(', ')}`
      : 'nothing on this page has to merge before it'
  );
  bits.push(
    out.length
      ? `merges before ${out.map(e => nodeRef(e.to)).join(', ')}`
      : 'nothing on this page waits on it'
  );
  return bits.join(' — ');
}

export function edgeTitleText(e) {
  const bits = [
    `${nodeRef(e.from)} → ${nodeRef(e.to)}`,
    `merge ${nodeRef(e.from)} before ${nodeRef(e.to)}`
  ];
  if (e.edge.needsRelease)
    bits.push('release-gated: satisfied by a published release, not by a merge');
  if (e.edge.crossRepo) bits.push('crosses repositories');
  if (e.edge.reason) bits.push(e.edge.reason);
  if (e.edge.status) bits.push(e.edge.status);
  if (e.cycle) bits.push('closes a dependency cycle, so it is not drawn');
  return bits.join(' — ');
}

// --- what a rank actually is ---------------------------------------------
//
// Who shares a rank, and whether that rank is genuinely unordered.
//
// Two nodes at one rank cannot depend on each other: rankNodes() gives a node
// one rank past its deepest prerequisite, so a drawn edge always forces its head
// at least one rank later than its tail. The single exception is an edge cut to
// break a cycle, which contributes no depth and can therefore leave both of its
// ends on the same rank. So `unordered` is CHECKED against the edge list rather
// than assumed from the invariant.
export function rankCensus(graph) {
  const nodes = graph.nodes || [];
  const maxRank = nodes.reduce((m, n) => Math.max(m, n.rank || 0), 0);
  const counts = new Array(maxRank + 1).fill(0);
  for (const n of nodes) counts[n.rank || 0]++;

  const tangled = new Set();
  for (const e of graph.edges || []) if (e.from.rank === e.to.rank) tangled.add(e.from.rank);

  return { maxRank, counts, tangled, unordered: r => !tangled.has(r) };
}

// --- layout -------------------------------------------------------------
//
// Layered by dependency depth, the way a Sugiyama drawing is: rank 0 is every PR
// with no prerequisites at all, rank 1 is everything whose longest prerequisite
// chain is one edge, and so on. Rank r is drawn as the column at x = r, so the
// horizontal axis IS merge order.
//
// Cards are no longer all the same height -- a one-line title makes a short card
// and a three-line title a tall one -- so the packing works off each card's own
// height rather than a constant.
export function layoutGraph(graph) {
  const nodes = graph.nodes;
  const left = PAD;
  const top = PAD + LANE_H;
  const colX = r => left + r * (NODE_W + RANK_GAP);

  if (!nodes.length) {
    return { width: left + NODE_W + PAD, height: top + PAD, columns: [], left, top, maxRank: 0 };
  }

  // Measure before placing: a card's height depends on its own title.
  for (const n of nodes) {
    n.card = cardOf(n);
    n.h = n.card.height;
  }

  const maxRank = nodes.reduce((m, n) => Math.max(m, n.rank), 0);
  const ranks = [];
  for (let r = 0; r <= maxRank; r++) ranks.push([]);
  for (const n of nodes) ranks[n.rank].push(n);

  // The final, total tiebreak. `key` is `repo#number` and is unique per node, so
  // two cards can never compare equal: the layout is deterministic whatever order
  // buildGraph happened to hand the nodes over in.
  const plain = (a, b) => a.repo.localeCompare(b.repo) || a.number - b.number;

  // WITHIN A COLUMN: most recently opened first.
  //
  // What this replaced: `plain` alone, i.e. repository name A to Z and then PR
  // number ascending, which put the oldest work at the top of every column and
  // grouped it by repo. Nothing about that grouping was load-bearing -- own,
  // bot and dep cards were never separated, nor were drafts from open ones, so
  // no grouping is broken by this. The kinds are told apart by the outline and
  // the marker, which is where that job belongs.
  //
  // WHAT IT DOES NOT TOUCH, which is the point:
  //
  //   This is the LAST key, not the first. The crossing-reduction keys below --
  //   `waitedOnBy` at rank 0, `barycentre` above it -- still decide first, so a
  //   card is still placed beside the thing it is joined to and the arrows still
  //   do not cross. Recency only settles cards that those keys leave tied, which
  //   on this page is most of them, because most PRs have no edges at all.
  //
  //   And it can never contradict a dependency, structurally rather than by
  //   care: rank is the LONGEST path to a node, so a drawn edge a -> b forces
  //   rank(b) >= rank(a) + 1. Two cards in the same column therefore have no
  //   drawn edge between them, and an ordering inside a column cannot put
  //   anything ahead of something it depends on. The one exception is an edge
  //   CUT to break a cycle, which can join two cards of equal rank; that edge is
  //   not drawn, the column is headed "a cycle is cut here" rather than "any
  //   order" (see rankCensus), and a cycle has no satisfiable order to get wrong.
  //
  // `createdAt` is the PR's `created_at`: the day it was OPENED. Not
  // `updated_at`, which any comment moves, and not `merged_at`, which most of
  // these do not have. A card with no readable date -- an unreadable target, or a
  // withheld one, whose date is blanked with its name -- sinks below the dated
  // ones rather than claiming a position, and is then settled by `plain`.
  // DRAFTS SINK, and they sink UNDER the crossing keys and OVER recency.
  //
  // A draft is not ready to be looked at, so it belongs below the work that is;
  // but it is still a real node with real edges, so this must never override a
  // positional constraint. It is layered as the second-to-last key for exactly
  // that reason: a draft something depends on is still placed by `waitedOnBy` or
  // `barycentre` first and can still lead its column, the same way an old merged
  // prerequisite does.
  //
  // Among the drafts themselves the newest-first order still applies, so the
  // rule reads the same on both sides of the split rather than leaving drafts in
  // whatever order they happened to arrive in.
  const draftLast = (a, b) =>
    Number(a.state === 'draft') - Number(b.state === 'draft');

  const opened = n => (n.createdAt ? Date.parse(n.createdAt) : NaN);
  const recent = (a, b) => {
    const ta = opened(a);
    const tb = opened(b);
    const ua = Number.isNaN(ta);
    const ub = Number.isNaN(tb);
    if (ua && ub) return plain(a, b);
    if (ua) return 1;
    if (ub) return -1;
    return tb - ta || plain(a, b);
  };

  // The whole tiebreak, in the order Wan asked for it: non-drafts before drafts,
  // then newest first, then repo and number to make it total.
  const settle = (a, b) => draftLast(a, b) || recent(a, b);

  // Provisional order per rank, used only to seed the pass below.
  const prov = ranks.map(list => {
    const m = new Map();
    [...list].sort(settle).forEach((n, i) => m.set(n.key, i));
    return m;
  });

  const ordered = [];

  for (let r = 0; r <= maxRank; r++) {
    // Where the things waiting on this node sit, provisionally, in the column to
    // its right.
    const waitedOnBy = n => {
      const at = n.neededBy
        .filter(e => !e.cycle && prov[e.to.rank])
        .map(e => prov[e.to.rank].get(e.to.key))
        .filter(v => typeof v === 'number');
      return at.length ? Math.min(...at) : null;
    };
    // Where this node's own prerequisites actually ended up, vertically.
    const barycentre = n => {
      const ys = n.needs.filter(e => !e.cycle && typeof e.from.cy === 'number').map(e => e.from.cy);
      return ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : null;
    };

    const list = [...ranks[r]];
    list.sort((a, b) => {
      if (r > 0) {
        const ba = barycentre(a);
        const bb = barycentre(b);
        if (ba !== null && bb !== null && ba !== bb) return ba - bb;
        if (ba !== null && bb === null) return -1;
        if (ba === null && bb !== null) return 1;
        return settle(a, b);
      }
      const ua = waitedOnBy(a);
      const ub = waitedOnBy(b);
      if (ua === null && ub === null) return settle(a, b);
      if (ua === null) return 1;
      if (ub === null) return -1;
      return ua - ub || settle(a, b);
    });

    // One rank, one column, however tall. See the header of this file.
    const x = colX(r);
    let cursor = top;
    list.forEach((n, i) => {
      const want = barycentre(n);
      n.col = r;
      n.slot = i;
      n.x = x;
      n.cx = x + NODE_W / 2;
      n.y = Math.max(cursor, want === null ? cursor : Math.round(want - n.h / 2));
      n.cy = n.y + n.h / 2;
      cursor = n.y + n.h + ROW_GAP;
    });
    ordered.push(list);
  }

  // Nothing floats above the header lane, and no column is left with a gap at
  // the top that no card explains.
  const drift = Math.min(...nodes.map(n => n.y)) - top;
  if (drift > 0) {
    for (const n of nodes) {
      n.y -= drift;
      n.cy = n.y + n.h / 2;
    }
  }

  const census = rankCensus(graph);
  const bottom = Math.max(...nodes.map(n => n.y + n.h));
  const width = colX(maxRank) + NODE_W + PAD;
  const height = bottom + PAD;

  const columns = ordered.map((list, r) => {
    const allMerged = list.length > 0 && list.every(n => n.merged);
    return {
      rank: r,
      x: colX(r),
      width: NODE_W,
      top,
      count: list.length,
      unordered: census.unordered(r),
      allMerged,
      ...columnLabel(r, maxRank, list.length, census.unordered(r), allMerged)
    };
  });

  return { width, height, columns, left, top, maxRank, laneH: LANE_H };
}

// The label above a column.
//
// `note` is the part that says the vertical stacking means nothing. It is on
// every column, because "any order" is the fact a stacked column is most likely
// to be misread about, and it is only claimed for a column that is genuinely
// unordered -- see rankCensus(). With the per-PR list gone this header is the
// ONLY place the rank of a PR is stated, which is why it stays.
// `allMerged` is the merged-trail case. A column made entirely of PRs that have
// already landed has no merge left in its future, so heading it MERGES FIRST
// would be a prediction about finished work -- the same mistake as drawing it as
// work still to do. One open PR in the column is enough to keep the ordinary
// label, because the order it names is still real for that one.
export function columnLabel(r, maxRank, count, unordered = true, allMerged = false) {
  const note = !unordered
    ? `${count} PR${count === 1 ? '' : 's'} · a cycle is cut here`
    : count === 1
      ? '1 PR'
      : `${count} PRs · any order`;
  if (allMerged) return { label: 'ALREADY MERGED', sub: 'this part is done', note };
  if (maxRank === 0) return { label: 'NO ORDER TO KEEP', sub: 'nothing waits on anything', note };
  if (r === 0) return { label: 'MERGES FIRST', sub: 'nothing to wait for', note };
  if (r === maxRank) return { label: 'MERGES LAST', sub: 'waits on the rest', note };
  return { label: 'THEN', sub: 'after the column on its left', note };
}

// --- the text alternative ------------------------------------------------
//
// The page used to write every relationship out in a list under the diagram, and
// that list is gone. So <desc> is no longer a summary of the picture: it IS the
// picture, in words. Every column, everything standing in it, and every edge,
// including the ones cut to break a cycle -- a declared dependency is never
// silently dropped just because it cannot be drawn.
//
// It uses nodeRef(), so a withheld repo name is withheld here too.
// How a card is named in the description: its ref, and its author when that
// author is not the page's. Same rule as the `◇` marker on the card itself, in
// the one place a reader who cannot see the card will find it.
export const descRef = n => {
  const notes = [];
  if (n.hidden) notes.push('private repository, details withheld');
  // A tracked bot is named as one. The picture separates it from an ordinary
  // foreign card with a dotted outline rather than a dashed one, and a reader who
  // is not looking at the picture gets that same distinction in words here --
  // otherwise the text alternative would flatten two different reasons a card is
  // on the page into one phrase.
  else if (n.kind === 'bot') notes.push(`by @${n.author}, a tracked bot`);
  else if (n.kind !== 'own') {
    if (!n.author) notes.push('author unknown');
    else if (n.foreign) notes.push(`by @${n.author}, not the page author's`);
  }
  // And what state it is in, for the same reason: open is what nearly every
  // card is, so it is left unsaid, and anything else is named. A reader who
  // never sees the fill still learns that a prerequisite has already landed.
  const state = nodeState(n).state;
  if (state !== 'open') notes.push(nodeState(n).word);
  // And who approved it, for the same reason again: the thicker border is the
  // one channel that is pure geometry, so it has to be a sentence here or a
  // reader not looking at the picture never learns the PR was signed off.
  if (nodeApproved(n)) notes.push(approvedLabel(nodeApprovers(n)));
  return notes.length ? `${nodeRef(n)} (${notes.join('; ')})` : nodeRef(n);
};

export function graphDesc(graph) {
  const drawn = (graph.edges || []).filter(e => !e.cycle);
  const cut = (graph.edges || []).filter(e => e.cycle);
  // Only explain the tracked-bot distinction when one is actually on the canvas.
  // A key to a mark nothing uses is noise here for the same reason it is in the
  // legend, and a page with no bot on it reads exactly as it always did.
  const hasBots = graph.nodes.some(n => n.kind === 'bot');

  const ranks = [];
  for (const n of graph.nodes) (ranks[n.rank || 0] ||= []).push(n);
  for (const list of ranks) list.sort((a, b) => (a.y || 0) - (b.y || 0) || a.number - b.number);
  const total = ranks.length;

  const blocked = graph.nodes.filter(n => n.blockedBy && n.blockedBy.length);
  const parts = [
    'Each pull request is drawn exactly once, as a card carrying its repository, its number and' +
      ' its title.',
    'The graph reads left to right: an arrow runs from a prerequisite rightward to the pull' +
      ' request that waits on it, so the leftmost column merges first and the rightmost column' +
      ' merges last.',
    'One column is one rank, and pull requests stacked in the same column are independent of one' +
      ' another: they can merge in any order or at the same time, so their vertical position' +
      ' carries no meaning.',
    // Whose a card is has to be IN HERE, not only in the marker on the card and
    // the hover title. Under role="img" this description is the whole of what a
    // reader who is not looking at the picture gets, and the page draws entire
    // dependency chains on the strength of one pull request in them belonging to
    // the page author -- so a card named here without its author would read as
    // the page author's by default, which is the one thing the marking exists to
    // stop. The same argument applies to the fill: a card named by its ref alone
    // would read as open, since open is what nearly all of them are.
    'A whole dependency chain is drawn whenever at least one pull request in it belongs to the' +
      ' page author' +
      (hasBots ? ' or to a tracked bot' : '') +
      ', so some of the cards below are somebody else\'s. Every one that is not the' +
      ' page author\'s names its author where it is listed; the rest are the page author\'s own.' +
      (hasBots
        ? ' A tracked bot\'s pull request is named as one: it is scheduled here like the page' +
          ' author\'s own work, whereas a card named only as somebody else\'s is on the page' +
          ' because it stands in the way of work that is.'
        : ''),
    'The fill colour of a card is the state of that pull request, and every card also prints that' +
      ' state as a word beside its reference, so nothing here is carried by colour alone. Open is' +
      ' the usual case and is left unmarked below; anything else is named in brackets after the' +
      ' reference. The only merged pull requests drawn are prerequisites that have already' +
      ' landed.',
    // The border weight, which is the one channel that is nothing but geometry.
    // A stroke width cannot be described to a reader who is not looking at the
    // drawing, so it is stated here as a fact about the pull request instead, and
    // every approved card is named as such where it is listed.
    'A card is drawn with a thicker border when a human other than the page author has approved' +
      ' that pull request, and every one of those cards also prints a tick and the approving' +
      ' handles, so the border weight is never the only thing saying it. An approval is counted' +
      ' from each reviewer\'s latest review only, so a reviewer who approved and later requested' +
      ' changes is not an approval; a review by a bot is not one either, and neither is the page' +
      ' author\'s own. Where an approved pull request is listed below, its approvers are named in' +
      ' brackets after the reference.',
    'The whole structure follows, in words.'
  ];
  // Said before the column list, like the merged set is, because a reader who is
  // not looking at the picture would otherwise meet a pull request with nothing
  // to its left and conclude it was ready.
  if (blocked.length) {
    parts.splice(
      parts.length - 1,
      0,
      `${blocked.length} pull request${blocked.length === 1 ? '' : 's'} here declare${
        blocked.length === 1 ? 's' : ''
      } a prerequisite that was closed without being merged: ` +
        blocked
          .map(n => `${descRef(n)} waits on ${n.blockedBy.map(blockedRef).join(', ')}`)
          .join('; ') +
        '. Those prerequisites are not drawn, because nothing will merge them and a merge order' +
        ' that cannot happen is not merge order; the pull requests waiting on them cannot proceed' +
        ' as declared.'
    );
  }
  // The merged cards, named as a set. A reader who is not looking at the picture
  // needs to know that some of what follows is finished work and why it is here
  // at all, before they read a column list that mixes the two.
  const merged = graph.nodes.filter(n => n.merged);
  if (merged.length) {
    parts.splice(
      parts.length - 1,
      0,
      `${merged.length} of these ${merged.length === 1 ? 'has' : 'have'} already merged and` +
        ` ${merged.length === 1 ? 'is' : 'are'} drawn because something here still depends on` +
        ` ${merged.length === 1 ? 'it' : 'them'}: ` +
        merged.map(descRef).join(', ') +
        `. Each of those is a wait that is already over: the card is drawn so the chain behind an` +
        ` open pull request can be read whole, not because anything is still held up by it.`
    );
  }

  ranks.forEach((list, r) => {
    const allMerged = list.length > 0 && list.every(n => n.merged);
    const where = allMerged
      ? `Column ${r + 1} of ${total}, which has already merged,`
      : total === 1
        ? 'The only column'
        : r === 0
          ? `Column 1 of ${total}, which merges first,`
          : r === total - 1
            ? `Column ${total} of ${total}, which merges last,`
            : `Column ${r + 1} of ${total},`;
    const how =
      list.length === 1
        ? 'holds 1 pull request'
        : `holds ${list.length} pull requests, in any order among themselves`;
    // descRef() already names each card's state as well as its author, so a
    // column that is only PARTLY merged says which of its cards are finished
    // without any extra suffix here.
    parts.push(`${where} ${how}: ${list.map(descRef).join(', ')}.`);
  });

  parts.push(
    drawn.length
      ? `${drawn.length} dependency edge${drawn.length === 1 ? '' : 's'}, each naming the` +
          ` prerequisite first and then the pull request that waits on it: ` +
          drawn
            .map(
              e =>
                `${nodeRef(e.from)} before ${nodeRef(e.to)}` +
                (e.edge.needsRelease
                  ? ', release-gated, which is satisfied by a published release and not by a merge'
                  : '') +
                (e.edge.satisfied ? ', already met' : '')
            )
            .join('; ') +
          '.'
      : 'There are no dependency edges: nothing on this page waits on anything else on it.'
  );

  if (cut.length) {
    parts.push(
      `${cut.length} declared dependenc${cut.length === 1 ? 'y closes' : 'ies close'} a cycle and` +
        ` cannot be drawn, but ${cut.length === 1 ? 'it is' : 'they are'} not dropped: ` +
        cut.map(e => `${nodeRef(e.from)} before ${nodeRef(e.to)}`).join('; ') +
        '.'
    );
  }

  return parts.join(' ');
}

// --- the drawing --------------------------------------------------------
//
// Colour is never the only carrier: the arrowheads carry the direction, every
// marker ships a glyph and words, and a dashed outline always arrives with a
// legend entry that explains it. Geometry, the base ink and the font sizes are
// presentation attributes rather than CSS, so the diagram still draws with the
// stylesheet off; the CSS only re-themes it.
export function graphSvg(graph, ids = {}) {
  const L = graph.layout;
  const tId = ids.title || 'graph-title';
  const dId = ids.desc || 'graph-desc';
  const edges = graph.edges.filter(e => !e.cycle);
  const plural = (n, s) => `${n} ${s}${n === 1 ? '' : 's'}`;

  const out = [];
  out.push(
    `<svg class="depgraph" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${L.width} ${L.height}"` +
      ` width="${L.width}" height="${L.height}" role="img" aria-labelledby="${tId} ${dId}">`
  );
  out.push(
    `<title id="${tId}">Dependency graph: ${plural(graph.nodes.length, 'pull request')},` +
      ` ${plural(edges.length, 'dependency edge')}</title>`
  );
  out.push(`<desc id="${dId}">${esc(graphDesc(graph))}</desc>`);
  // Two arrowheads, because an SVG marker does not inherit the stroke of the path
  // that references it: the met one is the same shape in the satisfied ink, so an
  // already-walked link of the trail is one consistent colour end to end.
  const marker = (id, cls) =>
    `<marker id="${id}" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="9"` +
    ' markerHeight="9" markerUnits="userSpaceOnUse" orient="auto">' +
    `<path class="${cls}" d="M0 0 L10 5 L0 10 Z" fill="currentColor"/></marker>`;
  // The avatars, ONCE EACH. Twenty cards by three authors put three images in
  // here and twenty <use> references out there, which is the whole reason
  // inlining is affordable at all. The href is a data: URI built at build time,
  // so opening this page fetches nothing and tells GitHub nothing.
  //
  // `slice` rather than `meet`: GitHub avatars are square, but a non-square one
  // must fill the disc and be cropped rather than letterboxed inside it.
  const avatars = graph.avatars || [];
  const avDefs = avatars.length
    ? `<clipPath id="av-clip"><circle cx="${AV / 2}" cy="${AV / 2}" r="${AV / 2}"/></clipPath>` +
      avatars
        .map(
          a =>
            `<image id="${esc(a.id)}" width="${AV}" height="${AV}" clip-path="url(#av-clip)"` +
            ` preserveAspectRatio="xMidYMid slice" href="${esc(a.href)}"/>`
        )
        .join('')
    : '';
  out.push(
    `<defs>${marker('dep-arrow', 'ahead')}${marker('dep-arrow-met', 'ahead met')}${avDefs}</defs>`
  );

  // The column headers, which is where the rank labels live now that a rank is a
  // column: MERGES FIRST sits at the left end of the canvas, MERGES LAST at the
  // right end, and each header carries the count and the "any order" note for
  // the column standing under it.
  for (const c of L.columns) {
    out.push(
      `<g class="colhead${c.allMerged ? ' done' : ''}">` +
        `<text class="rk" x="${c.x}" y="${PAD + 11}" font-size="9">${esc(c.label)}</text>` +
        `<text class="rksub" x="${c.x}" y="${PAD + 24}" font-size="9">${esc(c.sub)}</text>` +
        `<text class="rknote${c.unordered ? '' : ' cyc'}" x="${c.x}" y="${PAD + 36}"` +
        ` font-size="9">${esc(c.note)}</text>` +
        `<line class="rkrule" x1="${c.x}" y1="${PAD + 42}" x2="${c.x + c.width}" y2="${PAD + 42}"` +
        ` stroke="currentColor" stroke-width="1"/>` +
        `</g>`
    );
  }

  // Two arrows arriving at one card on the same pixel read as one arrow, which is
  // exactly the fact this page exists to show, so they are fanned out across the
  // edge of the card they touch -- ordered by where the other end sits, so the
  // fan never introduces a crossing.
  const fan = new Map();
  const port = (key, e) => {
    if (!fan.has(key)) fan.set(key, []);
    fan.get(key).push(e);
  };
  for (const e of edges) {
    port(`in:${e.to.key}`, e);
    port(`out:${e.from.key}`, e);
  }
  for (const [key, list] of fan) {
    const by = key.startsWith('in:') ? e => e.from.cy : e => e.to.cy;
    list.sort((a, b) => by(a) - by(b));
  }
  const offset = (key, e, h) => {
    const list = fan.get(key);
    if (!list || list.length < 2) return 0;
    const span = Math.min(14, Math.max(6, (h - 12) / (list.length - 1)));
    return Math.round((list.indexOf(e) - (list.length - 1) / 2) * span);
  };

  // Arrows first, so a card always covers a line rather than the other way round.
  // Every one of them leaves the RIGHT edge of the prerequisite and arrives at
  // the LEFT edge of the PR that waits on it: the arrowhead points right.
  for (const e of edges) {
    const sx = e.from.x + NODE_W + 2;
    const sy = e.from.cy + offset(`out:${e.from.key}`, e, e.from.h);
    const tx = e.to.x - 5;
    const ty = e.to.cy + offset(`in:${e.to.key}`, e, e.to.h);
    const mid = Math.round((sx + tx) / 2);
    const cls = ['edge'];
    if (e.edge.crossRepo) cls.push('cross');
    if (e.edge.satisfied) cls.push('met');
    const gate = e.edge.needsRelease
      ? `<text class="elabel" x="${mid}" y="${Math.round((sy + ty) / 2) - 5}"` +
        ` font-size="8.5" text-anchor="middle">GATED</text>`
      : '';
    // A prerequisite that has already landed is the only reason anything merged
    // is drawn here, so the arrow leaving it has to SAY it is cleared: a merged
    // card with an ordinary arrow on it reads as a live blocker. Below the
    // midpoint, so it never lands on GATED -- an edge can be released and met at
    // the same time.
    const met = e.edge.satisfied
      ? `<text class="elabel met" x="${mid}" y="${Math.round((sy + ty) / 2) + 12}"` +
        ` font-size="8.5" text-anchor="middle">✓ MET</text>`
      : '';
    out.push(
      `<g class="edgeg"><title>${esc(edgeTitleText(e))}</title>` +
        `<path class="${cls.join(' ')}" fill="none" stroke="currentColor" stroke-width="1.5"` +
        ` marker-end="url(#dep-arrow${e.edge.satisfied ? '-met' : ''})"` +
        ` d="M${sx} ${sy} C ${mid} ${sy}, ${mid} ${ty}, ${tx} ${ty}"/>` +
        `${gate}${met}</g>`
    );
  }

  for (const n of graph.nodes) {
    const c = n.card || cardOf(n);
    const rows = c.lines.length || 1;
    const inner = [
      // The border weight is the approval channel, and it is a presentation
      // attribute for the same reason the rest of the geometry is: with the
      // stylesheet stripped an approved card still draws thicker.
      `<rect class="box" x="${n.x}" y="${n.y}" width="${NODE_W}" height="${c.height}" rx="6"` +
        ` fill="none" stroke="currentColor"` +
        ` stroke-width="${c.approved ? BOX_STROKE_APPROVED : BOX_STROKE}"/>`,
      `<text class="ref" x="${n.x + CARD_PAD_X + c.avRoom}" y="${n.y + REF_Y}"` +
        ` font-size="${REF_SIZE}">${esc(c.ref)}</text>`,
      // The fill, said in a glyph and a word, pinned to the right edge of the
      // ref line. No <title> of its own: the card already carries one, and it
      // names the state in full there.
      `<text class="st" x="${n.x + NODE_W - CARD_PAD_X}" y="${n.y + REF_Y}"` +
        ` font-size="${MARK_SIZE}" text-anchor="end">${esc(c.stateText)}</text>`
    ];
    // The avatar, and the ring that is also its fallback. If the image does not
    // render -- a data URI a browser rejects, an <image> element it does not
    // support -- what is left is an empty disc, not a hole and not a shifted
    // card: this is SVG, so the graphic is placed by coordinate and nothing
    // around it reflows. A card with no avatar reserved no room in the first
    // place, so that case does not shift anything either.
    //
    // aria-hidden, because it is decoration in the strict sense: whose the card
    // is, is already in the card's own <title> and in the graph's <desc>, in
    // words. An alt text here would be a second, weaker copy of a fact the page
    // already states properly -- and on a withheld card there is no avatar to
    // describe and nothing that may be said about its author.
    if (c.avatar) {
      const ax = n.x + CARD_PAD_X;
      const ay = n.y + REF_Y - 11;
      inner.push(
        `<g class="av" aria-hidden="true">` +
          `<use href="#${esc(c.avatar)}" x="${ax}" y="${ay}"/>` +
          `<circle class="avring" cx="${ax + AV / 2}" cy="${ay + AV / 2}" r="${AV / 2}"` +
          ` fill="none" stroke="currentColor" stroke-width="0.5"/>` +
          `</g>`
      );
    }
    c.lines.forEach((line, i) => {
      inner.push(
        `<text class="ttl${c.dim ? ' dim' : ''}" x="${n.x + CARD_PAD_X}"` +
          ` y="${n.y + TITLE_TOP + i * LINE_H}" font-size="${TITLE_SIZE}">${esc(line)}</text>`
      );
    });
    c.marks.forEach((m, j) => {
      inner.push(
        `<text class="mark m-${m.role}" x="${n.x + CARD_PAD_X}"` +
          ` y="${n.y + markY(rows, j)}" font-size="${MARK_SIZE}">` +
          `<tspan class="g">${esc(m.glyph)}</tspan> ${esc(m.text)}</text>`
      );
    });
    // A withheld target is not linked: the href would carry the repo name the
    // rest of the card is careful not to print.
    //
    // This is an SVG 2 <a>, so the link is a plain href and takes the same
    // target/rel/download attributes an HTML anchor does -- no xlink:href, and
    // so no xlink:show either. The card opens GitHub in a new tab: the graph is
    // a place you come back to, and a whole page of dependencies is expensive to
    // lose to a click. rel="noopener" goes with it because this page is served
    // publicly, and a tab we opened has no business holding a window handle back
    // to the one that opened it.
    const body = n.hidden
      ? inner.join('')
      : `<a href="${esc(n.url)}" target="_blank" rel="noopener">${inner.join('')}</a>`;
    out.push(
      `<g class="node ${n.kind === 'bot' ? 'bot' : n.kind === 'own' ? 'own' : 'dep'} ` +
        `${c.state.cls}${c.approved ? ' approved' : ''}">` +
        `<title>${esc(nodeTitleText(n))}</title>${body}</g>`
    );
  }

  out.push('</svg>');
  return out.join('\n');
}

// The stylesheet for the drawing, kept next to the geometry it themes.
export const graphCss = layout => `
.graph{margin:0 0 22px}
.graph figcaption{font-size:12px;color:var(--ink2);margin:0 0 10px}
.graph figcaption strong{color:var(--ink)}
/* A wide graph is the expected shape: one column per rank, and merge order is
   the horizontal axis, so depth costs width. It SCROLLS sideways rather than
   being scaled to fit -- the card text is 11px already, and shrinking it to fit
   a phone would cost the page the thing it is for. */
.gwrap{overflow-x:auto;overflow-y:hidden;padding-bottom:6px}
svg.depgraph{display:block;width:${layout.width}px;height:${layout.height}px;max-width:none;
  color:var(--ink2)}
svg.depgraph .box{stroke:var(--rule);fill:var(--raised)}
/* THE FILL IS THE STATE. One rule per state, naming the same variables the
   legend swatch names, so the key and the card cannot drift apart. Never colour
   on its own: .st prints the same thing as a glyph and a word. */
svg.depgraph .st-open .box{fill:var(--state-open);stroke:var(--state-open-line)}
svg.depgraph .st-draft .box{fill:var(--state-draft);stroke:var(--state-draft-line)}
svg.depgraph .st-merged .box{fill:var(--state-merged);stroke:var(--state-merged-line)}
svg.depgraph .st-closed .box{fill:var(--state-closed);stroke:var(--state-closed-line)}
svg.depgraph .st-unknown .box{fill:var(--raised);stroke:var(--rule)}
svg.depgraph .st{font:9.5px ui-sans-serif,system-ui,sans-serif;fill:var(--ink2);letter-spacing:.02em}
svg.depgraph .st-open .st{fill:var(--state-open-line)}
svg.depgraph .st-draft .st{fill:var(--state-draft-line)}
svg.depgraph .st-merged .st{fill:var(--state-merged-line)}
svg.depgraph .st-closed .st{fill:var(--state-closed-line)}
/* Not one of the author's own PRs: still filled by its state, but dashed, so
   "whose PR" and "what state" stay two separate channels. */
svg.depgraph .node.dep .box{stroke-dasharray:4 3}
/* A TRACKED BOT's open PR: dotted, between the author's solid card and the dashed
   card of a PR that is merely in the way. The three patterns are one channel with
   three values -- whose work this is -- and it is the SECOND channel, not the
   first: every card that is not the page author's also prints the author's handle
   next to a diamond, so nothing rests on telling one dash pattern from another,
   and nothing here rests on colour at all. */
svg.depgraph .node.bot .box{stroke-dasharray:1 3}
/* The author's avatar. Inlined at build time, so it is not a request: this page
   still loads nothing at all. It REINFORCES the identity the card already
   states -- the outline says whose kind of work it is, the diamond marker names
   the author -- and it is never the only carrier of either, so a reader with images
   off, or a browser that cannot draw it, loses no fact. The ring doubles as the
   placeholder: an avatar that fails to draw leaves a disc, not a hole. */
svg.depgraph .avring{stroke:var(--rule)}
/* APPROVED BY A HUMAN = a thicker border. The width itself is a presentation
   attribute on the rect (see graphSvg), so this rule only has to keep the DASH
   readable at the heavier weight: 4-on-3 at 2.5px starts to read as a solid
   line, which would take the "not mine" channel away from a card that is both.
   An approved foreign card is a thick DASHED box, and it carries both markers. */
svg.depgraph .node.dep.approved .box{stroke-dasharray:6 4}
svg.depgraph a{text-decoration:none}
/* the card: the ref identifies it, the TITLE is what it is */
svg.depgraph .ref{font:600 10.5px ui-monospace,SFMono-Regular,Menlo,monospace;fill:var(--ink2)}
svg.depgraph .ttl{font:11px ui-sans-serif,system-ui,sans-serif;fill:var(--ink)}
svg.depgraph .ttl.dim{fill:var(--muted);font-style:italic}
svg.depgraph .mark{font:9.5px ui-sans-serif,system-ui,sans-serif;fill:var(--ink2)}
svg.depgraph .mark .g{font-family:ui-monospace,monospace}
svg.depgraph .mark.m-critical{fill:var(--critical-ink);font-weight:700}
svg.depgraph .mark.m-foreign{fill:var(--ink2);font-weight:600}
/* The words that carry the thicker border. Not decoration: a stroke width is
   not something a reader can measure, so this line is what the border means. */
svg.depgraph .mark.m-approved{fill:var(--good-ink);font-weight:600}
svg.depgraph .edge{stroke:var(--ink2)}
svg.depgraph .edge.cross{stroke-dasharray:5 4}
/* An arrow whose tail has already landed. Lighter, and labelled -- the label is
   the part that carries it, since a lighter grey is a difference a reader has to
   notice rather than one they can read. */
svg.depgraph .edge.met{stroke:var(--muted)}
svg.depgraph .ahead{fill:var(--ink2)}
/* The arrowhead has to lighten with its line: an SVG marker does not inherit the
   stroke of the path that references it, so a met edge that kept the default
   head came out as a light line with a full-weight point on the end of it. Hence
   the second <marker> def rather than a class on the path. */
svg.depgraph .ahead.met{fill:var(--muted)}
/* the column header: rank name, what it waits for, and how many PRs stand under
   it with no order between them */
svg.depgraph .rk{font:700 9px ui-sans-serif,system-ui,sans-serif;letter-spacing:.06em;fill:var(--ink2)}
svg.depgraph .rksub{font:9px ui-sans-serif,system-ui,sans-serif;fill:var(--muted)}
svg.depgraph .rknote{font:9px ui-sans-serif,system-ui,sans-serif;fill:var(--ink2)}
svg.depgraph .rknote.cyc{fill:var(--critical-ink)}
svg.depgraph .colhead.done .rk,svg.depgraph .colhead.done .rksub{fill:var(--good-ink)}
svg.depgraph .rkrule{stroke:var(--rule)}
svg.depgraph .elabel{font:700 8.5px ui-sans-serif,system-ui,sans-serif;letter-spacing:.06em;
  fill:var(--serious-ink);paint-order:stroke;stroke:var(--surface);
  stroke-width:3px;stroke-linejoin:round}
svg.depgraph .elabel.met{fill:var(--good-ink)}
.legend{margin:10px 0 0;font-size:11px;color:var(--muted);display:flex;gap:14px;flex-wrap:wrap}
.legend span{white-space:nowrap}
.legend .k{font-family:ui-monospace,monospace;color:var(--ink2)}
.legend .k.crit{color:var(--critical-ink);font-weight:700}
.legend .k.gate{color:var(--serious-ink);font-weight:700;letter-spacing:.06em}
.legend .k.met{color:var(--good-ink);font-weight:700;letter-spacing:.06em}
.legend .k.appr{color:var(--good-ink);font-weight:700}
/* The card-fill key. The swatch shows the fill AND the glyph that goes with it,
   so the entry still reads as three different things in greyscale. Not scoped to
   the legend: the banner uses the same swatch, and one rule keeps them equal. */
.sw{display:inline-flex;align-items:center;justify-content:center;width:20px;height:13px;
  border:1px solid var(--rule);border-radius:3px;background:var(--raised);color:var(--ink2);
  font:9px ui-monospace,SFMono-Regular,Menlo,monospace;margin-right:5px;vertical-align:-2px}
.sw.st-open{background:var(--state-open);border-color:var(--state-open-line);
  color:var(--state-open-line)}
.sw.st-draft{background:var(--state-draft);border-color:var(--state-draft-line);
  color:var(--state-draft-line)}
.sw.st-merged{background:var(--state-merged);border-color:var(--state-merged-line);
  color:var(--state-merged-line)}
.sw.st-closed{background:var(--state-closed);border-color:var(--state-closed-line);
  color:var(--state-closed-line)}
`;
