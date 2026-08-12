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
//   The predecessor of this layout stacked ranks vertically and wrapped a wide
//   rank onto extra rows, and those rows had exactly that defect -- twenty
//   independent PRs came out as four rows that read as four steps. Rotating the
//   drawing is what fixes it: same-rank PRs now share a column, and "same
//   column" is a categorical thing a reader sees rather than a 12px-against-54px
//   gap a reader has to measure.
//
//   A rank with twenty members is therefore one tall column, and a graph twenty
//   ranks deep is very wide and scrolls sideways. Both are the intended shape.
//
// It is a GRAPH and not a tree: a PR that TWO others need is ONE node with two
// arrows leaving it. No node is ever drawn twice, so there is no "also drawn
// under ..." footnote to write, and no copy of a PR that could read as a second
// piece of work.
//
// One page-wide graph, not one per repo. The edge that forced the rework --
// snapshot.js#1225 -> stamp#491 -- crosses repos, and an arrow cannot be drawn
// between two separate <svg> elements without either client-side code or
// hand-tuned absolute positioning of both. One canvas draws it as an ordinary
// arrow. Repo grouping survives underneath, in the text form.

import { CI_GLYPH, CI_ROLE, CI_SHORT } from './ci.mjs';

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
export const NODE_W = 150;
export const NODE_H = 40;
export const ROW_GAP = 12; // between two boxes stacked in one column
export const RANK_GAP = 96; // between rank columns: where the arrows live
export const LANE_H = 48; // header lane above every column, carrying its label
const PAD = 10;

const REF_CHARS = 20; // what fits NODE_W at 10.5px monospace
const MARK_CHARS = 25;
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

// A node's ref. A target in a private repo shows its number and NOT the repo
// name -- the page is public, and the repo name is part of what is withheld.
export const nodeRef = n => (n.hidden ? `#${n.number}` : shortRef(n.repo, n.number));

// The one line of state that fits inside a box. Authorship wins for a node that
// is not the dashboard author's, because "whose PR is this" outranks CI.
export function nodeMark(n) {
  if (n.kind === 'own') {
    const ci = n.pr.ci;
    return {
      role: CI_ROLE[ci.state],
      glyph: CI_GLYPH[ci.state],
      text: CI_SHORT[ci.state] + (n.pr.draft ? ' · draft' : '')
    };
  }
  if (n.hidden) return { role: 'foreign', glyph: '◇', text: 'private repo' };
  if (!n.author) return { role: 'foreign', glyph: '?', text: 'author unknown' };
  if (n.foreign) return { role: 'foreign', glyph: '◇', text: '@' + n.author };
  return { role: 'muted', glyph: '·', text: n.status || 'not in the open set' };
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
// than assumed from the invariant -- a column carrying a cut edge does not get
// to tell the reader its members are independent, because two of them are not.
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
// Three passes, and deliberately no more than three -- there are three edges on
// this page today, and a crossing minimiser for three edges would be a
// liability, not an asset.
//
//   1. order each rank, working left to right: by the barycentre of the
//      prerequisites already placed in the columns to its left. Rank 0 has
//      nothing to its left, so it instead leads with the nodes something waits
//      on, grouped by what waits on them -- which pulls them to the top of the
//      column, nearest where the rank that needs them will land.
//   2. y: each node is centred beside its own prerequisites, sliding DOWN only
//      as far as it must to stop two boxes in the column overlapping. Vertical
//      position is a packing artefact and carries no meaning; the column header
//      says exactly that.
//   3. x: column r sits at r * (NODE_W + RANK_GAP), so rank 0 is at the left
//      edge of the canvas and merge order reads rightward.
export function layoutGraph(graph) {
  const nodes = graph.nodes;
  const left = PAD;
  const top = PAD + LANE_H;
  const colX = r => left + r * (NODE_W + RANK_GAP);

  if (!nodes.length) {
    return { width: left + NODE_W + PAD, height: top + PAD, columns: [], left, top, maxRank: 0 };
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
      n.y = Math.max(cursor, want === null ? cursor : Math.round(want - NODE_H / 2));
      n.cy = n.y + NODE_H / 2;
      cursor = n.y + NODE_H + ROW_GAP;
    });
    ordered.push(list);
  }

  // Nothing floats above the header lane, and no column is left with a gap at
  // the top that no box explains.
  const drift = Math.min(...nodes.map(n => n.y)) - top;
  if (drift > 0) {
    for (const n of nodes) {
      n.y -= drift;
      n.cy = n.y + NODE_H / 2;
    }
  }

  const census = rankCensus(graph);
  const bottom = Math.max(...nodes.map(n => n.y + NODE_H));
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
// unordered -- see rankCensus().
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

// --- the drawing --------------------------------------------------------
//
// Colour is never the only carrier: every box states its status in words, the
// arrowheads carry the direction, and a dashed outline always arrives with the
// words that explain it. Geometry and the base ink are presentation attributes
// rather than CSS, so the diagram still draws with the stylesheet off; the CSS
// only re-themes it (dark mode, status ink, dash patterns).
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
  out.push(
    `<desc id="${dId}">Each pull request is drawn exactly once. The graph reads left to right: an` +
      ` arrow runs from a prerequisite rightward to the pull request that waits on it, so the` +
      ` leftmost column merges first and the rightmost column merges last. One column is one rank,` +
      ` and pull requests stacked in the same column are independent of one another: they can merge` +
      ` in any order or at the same time, so their vertical position carries no meaning. Every` +
      ` relationship drawn here is also written out in the per-repository list below this` +
      ` diagram.</desc>`
  );
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
        `<text class="rk" x="${c.x}" y="${PAD + 11}">${esc(c.label)}</text>` +
        `<text class="rksub" x="${c.x}" y="${PAD + 24}">${esc(c.sub)}</text>` +
        `<text class="rknote${c.unordered ? '' : ' cyc'}" x="${c.x}" y="${PAD + 36}">` +
        `${esc(c.note)}</text>` +
        `<line class="rkrule" x1="${c.x}" y1="${PAD + 42}" x2="${c.x + c.width}" y2="${PAD + 42}"` +
        ` stroke="currentColor" stroke-width="1"/>` +
        `</g>`
    );
  }

  // Two arrows arriving at one box on the same pixel read as one arrow, which is
  // exactly the fact this page exists to show, so they are fanned out across the
  // edge of the box they touch -- ordered by where the other end sits, so the
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
  const offset = (key, e) => {
    const list = fan.get(key);
    if (!list || list.length < 2) return 0;
    const span = Math.min(14, (NODE_H - 12) / (list.length - 1));
    return Math.round((list.indexOf(e) - (list.length - 1) / 2) * span);
  };

  // Arrows first, so a box always covers a line rather than the other way round.
  // Every one of them leaves the RIGHT edge of the prerequisite and arrives at
  // the LEFT edge of the PR that waits on it: the arrowhead points right.
  for (const e of edges) {
    const sx = e.from.x + NODE_W + 2;
    const sy = e.from.cy + offset(`out:${e.from.key}`, e);
    const tx = e.to.x - 5;
    const ty = e.to.cy + offset(`in:${e.to.key}`, e);
    const mid = Math.round((sx + tx) / 2);
    const cls = ['edge'];
    if (e.edge.crossRepo) cls.push('cross');
    if (e.edge.satisfied) cls.push('met');
    out.push(
      `<path class="${cls.join(' ')}" fill="none" stroke="currentColor" stroke-width="1.5"` +
        ` marker-end="url(#dep-arrow)" d="M${sx} ${sy} C ${mid} ${sy}, ${mid} ${ty}, ${tx} ${ty}"/>`
    );
    if (e.edge.needsRelease) {
      out.push(
        `<text class="elabel" x="${mid}" y="${Math.round((sy + ty) / 2) - 5}"` +
          ` text-anchor="middle">release-gated</text>`
      );
    }
  }

  for (const n of graph.nodes) {
    const m = nodeMark(n);
    const cls = ['node', n.kind === 'own' ? 'own' : 'dep', `is-${m.role}`];
    out.push(
      `<g class="${cls.join(' ')}">` +
        `<title>${esc(nodeRef(n))} — ${esc(n.title || 'title unavailable')}</title>` +
        `<a href="${esc(n.url)}">` +
        `<rect class="box" x="${n.x}" y="${n.y}" width="${NODE_W}" height="${NODE_H}" rx="5"` +
        ` fill="none" stroke="currentColor"/>` +
        `<text class="ref" x="${n.x + 10}" y="${n.y + 17}">${esc(clip(nodeRef(n), REF_CHARS))}</text>` +
        `<text class="mark" x="${n.x + 10}" y="${n.y + 31}">` +
        `<tspan class="g">${esc(m.glyph)}</tspan> ${esc(clip(m.text, MARK_CHARS))}</text>` +
        `</a></g>`
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
   being scaled to fit -- the refs are 10.5px already, and shrinking them to fit
   a phone would cost the page the thing it is for. The list below is the
   small-screen answer. */
.gwrap{overflow-x:auto;overflow-y:hidden;padding-bottom:6px}
svg.depgraph{display:block;width:${layout.width}px;height:${layout.height}px;max-width:none;
  color:var(--ink2)}
svg.depgraph .box{stroke:var(--rule);fill:var(--raised)}
svg.depgraph .node.dep .box{fill:none;stroke-dasharray:4 3}
svg.depgraph a{text-decoration:none}
svg.depgraph .ref{font:600 10.5px ui-monospace,SFMono-Regular,Menlo,monospace;fill:var(--ink)}
svg.depgraph .mark{font:9.5px ui-sans-serif,system-ui,sans-serif;fill:var(--muted)}
svg.depgraph .mark .g{font-family:ui-monospace,monospace}
svg.depgraph .is-good .mark{fill:var(--good-ink)}
svg.depgraph .is-warning .mark{fill:var(--warning-ink)}
svg.depgraph .is-serious .mark{fill:var(--serious-ink)}
svg.depgraph .is-critical .mark{fill:var(--critical-ink)}
svg.depgraph .is-foreign .mark{fill:var(--ink2)}
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
svg.depgraph .elabel{font:700 8.5px ui-sans-serif,system-ui,sans-serif;letter-spacing:.04em;
  fill:var(--serious-ink);text-transform:uppercase;paint-order:stroke;stroke:var(--surface);
  stroke-width:3px;stroke-linejoin:round}
.legend{margin:10px 0 0;font-size:11px;color:var(--muted);display:flex;gap:16px;flex-wrap:wrap}
.legend span{white-space:nowrap}
.legend .k{font-family:ui-monospace,monospace;color:var(--ink2)}
`;
