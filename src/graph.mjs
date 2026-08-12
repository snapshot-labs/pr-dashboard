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
// CI wording, draft, rank, "no prerequisites" -- is off the card: it made the
// card wide and told the reader nothing about what merges before what. Three
// markers survive, because each of them changes when or whether an edge clears,
// and each has a legend entry under the drawing:
//
//   ◇ @handle   this PR is not the dashboard author's, so it is not theirs to merge
//   ⊘ ...       the PR's OWN TITLE says do not merge (lifted out of the title so
//               that truncating the title can never hide it)
//   GATED       on an EDGE: satisfied by a published release, not by a merge
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
bucket(0.88, 'w#+<=>^~⊘✓✗');
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

// The markers a card is allowed to carry. Everything else that used to be a
// badge is gone; these three stay because each one changes whether or when
// something can merge, and each is explained in the legend under the drawing.
//
// The authorship marker earns its place twice over since the page started drawing
// whole components. It used to sit on a card that could only ever be the target of
// one of the author's arrows; now somebody else's PR can be the leftmost card in
// the picture with prerequisites of its own, and this marker plus the dashed
// outline are the only things saying whose it is.
export function nodeMarks(n, hold) {
  const out = [];
  if (hold) out.push({ role: 'critical', glyph: '⊘', text: hold });
  if (n.hidden) out.push({ role: 'foreign', glyph: '◇', text: 'private repo' });
  else if (n.kind !== 'own') {
    if (!n.author) out.push({ role: 'foreign', glyph: '?', text: 'author unknown' });
    else if (n.foreign) out.push({ role: 'foreign', glyph: '◇', text: `@${n.author}` });
  }
  return out.slice(0, 2);
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
  return {
    ref: clipToWidth(nodeRef(n), TEXT_W, REF_SIZE, true),
    title: shown,
    fullTitle: n.title || null,
    hold,
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
  if (n.kind === 'own') {
    if (n.pr && n.pr.ci) bits.push(CI_LABEL[n.pr.ci.state] || 'CI state unknown');
    if (n.pr && n.pr.draft) bits.push('draft');
  } else if (n.hidden) bits.push('private repo, details withheld');
  else if (!n.author) bits.push('author unknown');
  else if (n.foreign) bits.push(`@${n.author} — not yours to merge`);
  if (n.status) bits.push(n.status);

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

  const plain = (a, b) => a.repo.localeCompare(b.repo) || a.number - b.number;

  // Provisional order per rank, used only to seed the pass below.
  const prov = ranks.map(list => {
    const m = new Map();
    [...list].sort(plain).forEach((n, i) => m.set(n.key, i));
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
        return plain(a, b);
      }
      const ua = waitedOnBy(a);
      const ub = waitedOnBy(b);
      if (ua === null && ub === null) return plain(a, b);
      if (ua === null) return 1;
      if (ub === null) return -1;
      return ua - ub || plain(a, b);
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

  const columns = ordered.map((list, r) => ({
    rank: r,
    x: colX(r),
    width: NODE_W,
    top,
    count: list.length,
    unordered: census.unordered(r),
    ...columnLabel(r, maxRank, list.length, census.unordered(r))
  }));

  return { width, height, columns, left, top, maxRank, laneH: LANE_H };
}

// The label above a column.
//
// `note` is the part that says the vertical stacking means nothing. It is on
// every column, because "any order" is the fact a stacked column is most likely
// to be misread about, and it is only claimed for a column that is genuinely
// unordered -- see rankCensus(). With the per-PR list gone this header is the
// ONLY place the rank of a PR is stated, which is why it stays.
export function columnLabel(r, maxRank, count, unordered = true) {
  const note = !unordered
    ? `${count} PR${count === 1 ? '' : 's'} · a cycle is cut here`
    : count === 1
      ? '1 PR'
      : `${count} PRs · any order`;
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
export const descRef = n =>
  nodeRef(n) +
  (n.hidden
    ? ' (private repository, details withheld)'
    : n.kind === 'own'
      ? ''
      : !n.author
        ? ' (author unknown)'
        : n.foreign
          ? ` (by @${n.author}, not the page author's)`
          : '');

export function graphDesc(graph) {
  const drawn = (graph.edges || []).filter(e => !e.cycle);
  const cut = (graph.edges || []).filter(e => e.cycle);

  const ranks = [];
  for (const n of graph.nodes) (ranks[n.rank || 0] ||= []).push(n);
  for (const list of ranks) list.sort((a, b) => (a.y || 0) - (b.y || 0) || a.number - b.number);
  const total = ranks.length;

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
    // stop.
    'A whole dependency chain is drawn whenever at least one pull request in it belongs to the' +
      ' page author, so some of the cards below are somebody else\'s. Every one that is not the' +
      ' page author\'s names its author where it is listed; the rest are the page author\'s own.',
    'The whole structure follows, in words.'
  ];

  ranks.forEach((list, r) => {
    const where =
      total === 1
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
                  : '')
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
  out.push(
    '<defs><marker id="dep-arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="9"' +
      ' markerHeight="9" markerUnits="userSpaceOnUse" orient="auto">' +
      '<path class="ahead" d="M0 0 L10 5 L0 10 Z" fill="currentColor"/></marker></defs>'
  );

  // The column headers, which is where the rank labels live now that a rank is a
  // column: MERGES FIRST sits at the left end of the canvas, MERGES LAST at the
  // right end, and each header carries the count and the "any order" note for
  // the column standing under it.
  for (const c of L.columns) {
    out.push(
      `<g class="colhead">` +
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
    out.push(
      `<g class="edgeg"><title>${esc(edgeTitleText(e))}</title>` +
        `<path class="${cls.join(' ')}" fill="none" stroke="currentColor" stroke-width="1.5"` +
        ` marker-end="url(#dep-arrow)" d="M${sx} ${sy} C ${mid} ${sy}, ${mid} ${ty}, ${tx} ${ty}"/>` +
        `${gate}</g>`
    );
  }

  for (const n of graph.nodes) {
    const c = n.card || cardOf(n);
    const rows = c.lines.length || 1;
    const inner = [
      `<rect class="box" x="${n.x}" y="${n.y}" width="${NODE_W}" height="${c.height}" rx="6"` +
        ` fill="none" stroke="currentColor"/>`,
      `<text class="ref" x="${n.x + CARD_PAD_X}" y="${n.y + REF_Y}"` +
        ` font-size="${REF_SIZE}">${esc(c.ref)}</text>`
    ];
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
    const body = n.hidden ? inner.join('') : `<a href="${esc(n.url)}">${inner.join('')}</a>`;
    out.push(
      `<g class="node ${n.kind === 'own' ? 'own' : 'dep'}">` +
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
svg.depgraph .node.dep .box{fill:none;stroke-dasharray:4 3}
svg.depgraph a{text-decoration:none}
/* the card: the ref identifies it, the TITLE is what it is */
svg.depgraph .ref{font:600 10.5px ui-monospace,SFMono-Regular,Menlo,monospace;fill:var(--ink2)}
svg.depgraph .ttl{font:11px ui-sans-serif,system-ui,sans-serif;fill:var(--ink)}
svg.depgraph .ttl.dim{fill:var(--muted);font-style:italic}
svg.depgraph .mark{font:9.5px ui-sans-serif,system-ui,sans-serif;fill:var(--ink2)}
svg.depgraph .mark .g{font-family:ui-monospace,monospace}
svg.depgraph .mark.m-critical{fill:var(--critical-ink);font-weight:700}
svg.depgraph .mark.m-foreign{fill:var(--ink2);font-weight:600}
svg.depgraph .edge{stroke:var(--ink2)}
svg.depgraph .edge.cross{stroke-dasharray:5 4}
svg.depgraph .ahead{fill:var(--ink2)}
/* the column header: rank name, what it waits for, and how many PRs stand under
   it with no order between them */
svg.depgraph .rk{font:700 9px ui-sans-serif,system-ui,sans-serif;letter-spacing:.06em;fill:var(--ink2)}
svg.depgraph .rksub{font:9px ui-sans-serif,system-ui,sans-serif;fill:var(--muted)}
svg.depgraph .rknote{font:9px ui-sans-serif,system-ui,sans-serif;fill:var(--ink2)}
svg.depgraph .rknote.cyc{fill:var(--critical-ink)}
svg.depgraph .rkrule{stroke:var(--rule)}
svg.depgraph .elabel{font:700 8.5px ui-sans-serif,system-ui,sans-serif;letter-spacing:.06em;
  fill:var(--serious-ink);paint-order:stroke;stroke:var(--surface);
  stroke-width:3px;stroke-linejoin:round}
.legend{margin:10px 0 0;font-size:11px;color:var(--muted);display:flex;gap:14px;flex-wrap:wrap}
.legend span{white-space:nowrap}
.legend .k{font-family:ui-monospace,monospace;color:var(--ink2)}
.legend .k.crit{color:var(--critical-ink);font-weight:700}
.legend .k.gate{color:var(--serious-ink);font-weight:700;letter-spacing:.06em}
`;
