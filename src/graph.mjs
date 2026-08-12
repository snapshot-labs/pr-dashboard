// The dependency graph: a layered layout, and the inline SVG it is drawn as.
//
// Generated at BUILD TIME, which is the constraint that shaped this file. The
// dashboard is one static HTML file served from GitHub Pages, so there is no
// Mermaid, no d3, no CDN and no <script> tag anywhere: build.mjs asks for a
// finished <svg> string and writes it into the document. Nothing is computed in
// the browser.
//
// DIRECTION -- unchanged from the tree this replaced, and the one thing a
// dependency picture must never leave ambiguous:
//
//   a PR sits ABOVE the things it needs. Every arrow runs from a prerequisite
//   UP to the PR that waits on it, so the bottom rank merges FIRST, the top
//   rank merges LAST, and reading the picture bottom-up IS merge order.
//
// It is a GRAPH and not a tree, which is the whole change: a PR that TWO others
// need is ONE node with two arrows leaving it. No node is ever drawn twice, so
// there is no "also drawn under ..." footnote to write, and no copy of a PR that
// could read as a second piece of work.
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

// Geometry. Sized so the whole canvas fits the 940px column without scaling.
export const NODE_W = 150;
export const NODE_H = 40;
const COL_GAP = 12;
const ROW_GAP = 12;
const BAND_GAP = 54; // vertical gap between ranks: where the arrows live
const LANE_W = 108; // left gutter carrying the rank label
const PAD = 10;
const PER_ROW = 5; // a rank wider than this wraps onto more rows

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

// --- layout -------------------------------------------------------------
//
// Layered by dependency depth, the way a Sugiyama drawing is: rank 0 is every PR
// with no prerequisites at all, rank 1 is everything whose longest prerequisite
// chain is one edge, and so on. Three passes, and deliberately no more than
// three -- there are three edges on this page today, and a crossing minimiser
// for three edges would be a liability, not an asset.
//
//   1. order each rank, bottom-up: by the barycentre of the prerequisites
//      already placed below. Rank 0 has nothing below it, so it instead leads
//      with the nodes something waits on, grouped by what waits on them.
//   2. x: a rank that fits one row is centred over its prerequisites; a rank
//      wider than PER_ROW wraps into a grid, with the nodes that have an arrow
//      leaving them on the row nearest the rank above, so no arrow crosses a box.
//   3. y: stack the bands from the bottom, so rank 0 sits at the bottom of the
//      canvas and merge order reads upward.
export function layoutGraph(graph, opts = {}) {
  const perRow = opts.perRow || PER_ROW;
  const nodes = graph.nodes;
  const left = PAD + LANE_W;
  const contentW = perRow * NODE_W + (perRow - 1) * COL_GAP;
  const width = left + contentW + PAD;

  if (!nodes.length) return { width, height: PAD * 2, bands: [], left, contentW, maxRank: 0 };

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

  const rowCount = [];
  const ordered = [];

  for (let r = 0; r <= maxRank; r++) {
    // Where the things waiting on this node sit, provisionally.
    const waitsAbove = n => {
      const at = n.neededBy
        .filter(e => !e.cycle && prov[e.to.rank])
        .map(e => prov[e.to.rank].get(e.to.key))
        .filter(v => typeof v === 'number');
      return at.length ? Math.min(...at) : null;
    };
    // Where this node's own prerequisites actually ended up.
    const barycentre = n => {
      const xs = n.needs.filter(e => !e.cycle && typeof e.from.cx === 'number').map(e => e.from.cx);
      return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
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
      const ua = waitsAbove(a);
      const ub = waitsAbove(b);
      if (ua === null && ub === null) return plain(a, b);
      if (ua === null) return 1;
      if (ub === null) return -1;
      return ua - ub || plain(a, b);
    });

    if (list.length > perRow) {
      list.forEach((n, i) => {
        n.row = Math.floor(i / perRow);
        n.x = left + (i % perRow) * (NODE_W + COL_GAP);
        n.cx = n.x + NODE_W / 2;
      });
      rowCount[r] = Math.ceil(list.length / perRow);
    } else {
      // One row, each node centred over its prerequisites, sliding right only as
      // far as it must to stop two boxes overlapping.
      let cursor = left;
      for (const n of list) {
        const want = barycentre(n);
        n.row = 0;
        n.x = Math.max(cursor, want === null ? cursor : Math.round(want - NODE_W / 2));
        cursor = n.x + NODE_W + COL_GAP;
      }
      const overflow = cursor - COL_GAP - (left + contentW);
      if (overflow > 0) for (const n of list) n.x = Math.max(left, n.x - overflow);
      for (const n of list) n.cx = n.x + NODE_W / 2;
      rowCount[r] = 1;
    }
    ordered.push(list);
  }

  const bandH = rowCount.map(rows => rows * NODE_H + (rows - 1) * ROW_GAP);
  const height = PAD * 2 + bandH.reduce((a, b) => a + b, 0) + BAND_GAP * Math.max(0, maxRank);

  const bands = [];
  let y = height - PAD;
  for (let r = 0; r <= maxRank; r++) {
    const top = y - bandH[r];
    bands.push({ rank: r, top, height: bandH[r], count: ordered[r].length, ...bandLabel(r, maxRank) });
    for (const n of ordered[r]) n.y = top + n.row * (NODE_H + ROW_GAP);
    y = top - BAND_GAP;
  }

  return { width, height, bands, left, contentW, maxRank };
}

function bandLabel(r, maxRank) {
  if (maxRank === 0) return { label: 'NO ORDER TO KEEP', sub: 'nothing waits on anything' };
  if (r === 0) return { label: 'MERGES FIRST', sub: 'nothing to wait for' };
  if (r === maxRank) return { label: 'MERGES LAST', sub: 'waits on the rest' };
  return { label: 'THEN', sub: 'after the rank below' };
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
    `<desc id="${dId}">Each pull request is drawn exactly once. An arrow runs from a prerequisite` +
      ` upward to the pull request that waits on it, so the bottom rank merges first and the top` +
      ` rank merges last. Every relationship drawn here is also written out in the per-repository` +
      ` list below this diagram.</desc>`
  );
  out.push(
    '<defs><marker id="dep-arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="9"' +
      ' markerHeight="9" markerUnits="userSpaceOnUse" orient="auto">' +
      '<path class="ahead" d="M0 0 L10 5 L0 10 Z" fill="currentColor"/></marker></defs>'
  );

  for (const b of L.bands) {
    out.push(
      `<text class="rk" x="${PAD}" y="${b.top + 16}">${esc(b.label)}</text>` +
        `<text class="rksub" x="${PAD}" y="${b.top + 30}">${esc(b.sub)}</text>`
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
    const by = key.startsWith('in:') ? e => e.from.cx : e => e.to.cx;
    list.sort((a, b) => by(a) - by(b));
  }
  const offset = (key, e) => {
    const list = fan.get(key);
    if (!list || list.length < 2) return 0;
    const span = Math.min(18, (NODE_W - 24) / (list.length - 1));
    return Math.round((list.indexOf(e) - (list.length - 1) / 2) * span);
  };

  // Arrows first, so a box always covers a line rather than the other way round.
  for (const e of edges) {
    const sx = e.from.cx + offset(`out:${e.from.key}`, e);
    const sy = e.from.y - 2;
    const tx = e.to.cx + offset(`in:${e.to.key}`, e);
    const ty = e.to.y + NODE_H + 5;
    const mid = Math.round((sy + ty) / 2);
    const cls = ['edge'];
    if (e.edge.crossRepo) cls.push('cross');
    if (e.edge.satisfied) cls.push('met');
    out.push(
      `<path class="${cls.join(' ')}" fill="none" stroke="currentColor" stroke-width="1.5"` +
        ` marker-end="url(#dep-arrow)" d="M${sx} ${sy} C ${sx} ${mid}, ${tx} ${mid}, ${tx} ${ty}"/>`
    );
    if (e.edge.needsRelease) {
      out.push(
        `<text class="elabel" x="${Math.round((sx + tx) / 2)}" y="${mid - 4}"` +
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
export const graphCss = width => `
.graph{margin:0 0 22px}
.graph figcaption{font-size:12px;color:var(--ink2);margin:0 0 10px}
.graph figcaption strong{color:var(--ink)}
.gwrap{overflow-x:auto}
svg.depgraph{display:block;width:${width}px;max-width:100%;height:auto;color:var(--ink2)}
/* On a narrow screen the whole canvas scaled to fit would put the refs at about
   four pixels. Scroll it instead -- the list below is the small-screen answer. */
@media (max-width:${width + 40}px){svg.depgraph{min-width:600px}}
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
svg.depgraph .rk{font:700 9px ui-sans-serif,system-ui,sans-serif;letter-spacing:.06em;fill:var(--ink2)}
svg.depgraph .rksub{font:9px ui-sans-serif,system-ui,sans-serif;fill:var(--muted)}
svg.depgraph .elabel{font:700 8.5px ui-sans-serif,system-ui,sans-serif;letter-spacing:.04em;
  fill:var(--serious-ink);text-transform:uppercase;paint-order:stroke;stroke:var(--surface);
  stroke-width:3px;stroke-linejoin:round}
.legend{margin:10px 0 0;font-size:11px;color:var(--muted);display:flex;gap:16px;flex-wrap:wrap}
.legend span{white-space:nowrap}
.legend .k{font-family:ui-monospace,monospace;color:var(--ink2)}
`;
