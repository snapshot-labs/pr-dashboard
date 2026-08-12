import { CI_GLYPH, CI_LABEL, CI_ROLE } from './ci.mjs';
import { esc, graphCss, graphSvg, layoutGraph, rankCensus } from './graph.mjs';

function ciBadge(ci) {
  const role = CI_ROLE[ci.state];
  let detail = '';
  if (ci.state === 'base-red') {
    detail = ` <span class="dim">(${esc(ci.baseFailures.map(f => f.name).join(', '))} also failing on ${esc(ci.baseRef)})</span>`;
  } else if (ci.state === 'own-red' || ci.state === 'mixed') {
    detail = ` <span class="dim">(${esc(ci.ownFailures.map(f => f.name).join(', '))})</span>`;
  }
  return `<span class="badge ${role}"><span class="g">${CI_GLYPH[ci.state]}</span>${esc(CI_LABEL[ci.state])}</span>${detail}`;
}

const EDGE_LABEL = {
  stack: 'stacked on',
  'cross-repo': 'needs first, other repo',
  implicit: 'needs first'
};

// The badge for one edge. It is drawn on the PR that WAITS, next to the ref of
// the thing it waits for, so the text form states the direction of every edge
// individually and not only in the banner.
function edgeBadge(e) {
  const role = e.satisfied ? 'good' : e.crossRepo ? 'serious' : 'warning';
  const glyph = e.satisfied ? '✓' : '⊘';
  return `<span class="badge ${role}"><span class="g">${glyph}</span>${esc(EDGE_LABEL[e.kind] || 'needs first')}</span>`;
}

// Whose PR this is. Stated only when it is NOT the dashboard's author, or when
// we genuinely do not know: an unbadged node is the author's own work.
// Unknown authorship is never reported as somebody else's -- guessing reads as
// an accusation.
function ownerBadge(n) {
  if (n.kind === 'own') return '';
  if (n.hidden)
    return '<span class="badge foreign"><span class="g">◇</span>private repo — details withheld</span>';
  if (!n.author)
    return '<span class="badge foreign"><span class="g">?</span>author unknown</span>';
  if (n.foreign)
    return `<span class="badge foreign"><span class="g">◇</span>not yours · @${esc(n.author)}</span>`;
  return '';
}

// Which rank this PR is in, and whether that rank has an order inside it.
//
// The text form is the page without the SVG, and a plain vertical list has
// exactly the defect the drawing had: it reads as a sequence. Grouping by repo
// makes that worse, because it scatters the PRs that share a rank -- twenty
// independent PRs come out as twenty numbered lines under five headings, in an
// order that is alphabetical and means nothing. So each row carries its rank and
// says, on itself, how many PRs share that rank and that there is no order among
// them. Structural, not advice: it names the absence of a constraint.
function rankBadge(n, census) {
  const where = `rank ${n.rank + 1} of ${census.maxRank + 1}`;
  if (census.tangled.has(n.rank))
    return `<span class="badge critical"><span class="g">!</span>${where} · a cycle links two in it</span>`;
  const count = census.counts[n.rank] || 1;
  const rest = count > 1 ? `any order among the ${count} in it` : 'the only PR in it';
  return `<span class="badge step"><span class="g">∥</span>${where} · ${rest}</span>`;
}

// How a node refers to another node: bare number inside its own repo's section,
// fully qualified when the edge leaves the repo. A target in a private repo
// never prints the repo name.
const refTo = (from, to) =>
  to.hidden ? `#${to.number}` : to.repo === from.repo ? `#${to.number}` : `${to.repo}#${to.number}`;

// One node, in the text form. This is the whole graph written out as an
// adjacency list: every PR appears once, and every edge it is on is named on it,
// with the direction spelled out both ways round ("needs first" in, "needed by"
// out). It is what the page falls back to when the SVG does not render.
function nodeRow(n, census) {
  const ref = `#${n.number}`;

  const badges = [];
  const owner = ownerBadge(n);
  if (owner) badges.push(owner);

  if (n.kind === 'own') {
    const blockers = n.needs.filter(e => !e.edge.satisfied);
    if (n.pr.draft) badges.push('<span class="badge muted"><span class="g">·</span>draft</span>');
    // Deliberately structural, not an instruction: sx#2251 is titled
    // "[DO NOT MERGE until migration is run]" and has no prerequisites on this
    // page. "no prerequisites" is a fact about the graph. "ready to merge" would
    // be advice, and would be wrong.
    badges.push(
      blockers.length === 0
        ? '<span class="badge good"><span class="g">✓</span>no prerequisites</span>'
        : `<span class="badge warning"><span class="g">⊘</span>blocked ×${blockers.length}</span>`
    );
    badges.push(rankBadge(n, census));
    if (n.cycle)
      badges.push(
        '<span class="badge critical"><span class="g">!</span>in a dependency cycle</span>'
      );
    badges.push(ciBadge(n.pr.ci));
  } else {
    // A referenced PR carries the state of the thing itself, which is what tells
    // you whether the PRs pointing at it are still blocked.
    badges.push(rankBadge(n, census));
    const e = n.neededBy[0];
    if (e) badges.push(`<span class="status">${esc(e.edge.status)}</span>`);
  }

  const title = n.title
    ? `<span class="title">${esc(n.title)}</span>`
    : `<span class="title dim">${n.hidden ? 'title withheld (private repo)' : 'title unavailable'}</span>`;

  const needs = n.needs
    .map(e => {
      const d = e.edge;
      const bits = [
        edgeBadge(d),
        `<a class="num" href="${esc(e.from.url)}">${esc(refTo(n, e.from))}</a>`,
        `<span class="status">${esc(d.status)}</span>`
      ];
      if (d.needsRelease) bits.push('<span class="gate">release-gated</span>');
      if (e.cycle) bits.push('<span class="badge critical"><span class="g">!</span>cycle — not drawn</span>');
      const why = d.reason ? `<div class="why">${esc(d.reason)}</div>` : '';
      const stale = d.latestRelease
        ? `<div class="why">latest release ${esc(d.latestRelease.tag)} predates the merge</div>`
        : '';
      return `<li class="in">${bits.join(' ')}${why}${stale}</li>`;
    })
    .join('');

  const out = n.neededBy.length
    ? `<li class="out"><span class="dir">needed by</span> ${n.neededBy
        .map(e => `<a class="num" href="${esc(e.to.url)}">${esc(refTo(n, e.to))}</a>`)
        .join(' ')}</li>`
    : '';

  const edges = needs || out ? `<ul class="edges">${needs}${out}</ul>` : '';

  return `<li>
    <div class="${n.kind === 'own' ? 'pr' : 'pr dep'}">
      <div class="line1"><a class="num" href="${esc(n.url)}">${esc(ref)}</a> ${title}</div>
      <div class="line2">${badges.join(' ')}</div>
      ${edges}
    </div>
  </li>`;
}

export function render({ graph, groups, author, org, generatedAt, withheld, total }) {
  if (!graph.layout) graph.layout = layoutGraph(graph);
  const edgeCount = graph.edges.filter(e => !e.cycle).length;
  const svg = graphSvg(graph);
  const census = rankCensus(graph);
  const row = n => nodeRow(n, census);

  const body = groups
    .map(g => {
      const heading = g.withheld
        ? `<h2>${esc(g.label)}</h2>`
        : `<h2>${esc(g.repo)} <span class="count">${g.count} open</span></h2>`;
      const mine = g.mine.map(row).join('');
      const referenced = g.referenced.length
        ? `<p class="readup">referenced only — drawn because something above needs ${
            g.referenced.length === 1 ? 'it' : 'them'
          }, not counted in the open set</p>
           <ul class="tree">${g.referenced.map(row).join('')}</ul>`
        : '';
      return `<section class="repo">
      ${heading}
      <p class="readup">every PR once, with every edge it is on — a prerequisite merges before the PR that needs it</p>
      <p class="readup notorder">listed by number, not in merge order — the rank badge on each PR is where the order is</p>
      ${mine ? `<ul class="tree root">${mine}</ul>` : ''}
      ${referenced}
    </section>`;
    })
    .join('');

  // The list is the page without the SVG, and it inherits the drawing's old
  // problem: read top to bottom it looks like a running order, when in fact the
  // sort key is a repo name and a PR number. Said once here, in full, and again
  // as a rank badge on every single row.
  const notRunningOrder = `<p class="notice norder"><strong>The list below is not a running order.</strong>
  PRs are listed by number, under the repo they live in — that sort says nothing about when anything
  merges. The order lives in the <strong>rank</strong> badge on each PR:
  <span class="badge step"><span class="g">∥</span>rank 1 of ${census.maxRank + 1}</span> and
  <span class="badge step"><span class="g">∥</span>rank 2 of ${census.maxRank + 1}</span> are
  ordered against each other, but everything sharing one rank is independent of everything else in
  that rank — any order between them, or all at the same time. Each badge says how many PRs share
  its rank.</p>`;

  // The notice counts only PRs this page would otherwise have drawn, so it
  // measures what privacy is hiding and nothing else. It also says whether any
  // of them blocks something visible, because a withheld PR that blocks nothing
  // costs the graph a node with no edges, not a broken chain.
  const n = withheld.count;
  const many = n > 1;
  const withheldNote = n
    ? `<p class="withheld"><strong>${n} PR${many ? 's' : ''} withheld.</strong>
       ${many ? `They are ${esc(author)}'s own and live in private repos` : `It is ${esc(author)}'s own and lives in a private repo`},
       and this page is served publicly, so ${many ? 'they are' : 'it is'} not drawn here.
       ${
         withheld.blocking
           ? `<strong>${withheld.blocking}</strong> of ${many ? 'them' : 'it'} block${withheld.blocking > 1 ? '' : 's'}
              a PR on this page — that edge <em>is</em> drawn, and so is its target, but the target keeps
              only its number: no title, no author, not even the repo name.`
           : `${n === 2 ? 'Neither' : many ? 'None of them' : 'It'} blocks anything on this page, so no edge is
              missing from the graph: withholding ${many ? 'them' : 'it'} costs the page
              ${n} node${many ? 's' : ''} that would have had no edges anyway, not a broken chain.`
       }
       Set <code>INCLUDE_PRIVATE=true</code> on a private build to see ${many ? 'them' : 'it'}.
       This page does not pretend the work does not exist.</p>`
    : '';

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>PR dependency graph — merge from the bottom up — ${esc(author)} @ ${esc(org)}</title>
<style>
:root{
  --surface:#fcfcfb; --raised:#ffffff; --band:#f1f0ea;
  --ink:#0b0b0b; --ink2:#52514e; --muted:#898781;
  --rule:#e1e0d9; --ring:rgba(11,11,11,.10);
  --good:#0ca30c; --warning:#fab219; --serious:#ec835a; --critical:#d03b3b;
  --good-ink:#006300; --warning-ink:#7a5200; --serious-ink:#8c3d1a; --critical-ink:#a52020;
}
@media (prefers-color-scheme:dark){
  :root{
    --surface:#1a1a19; --raised:#222221; --band:#131312;
    --ink:#ffffff; --ink2:#c3c2b7; --muted:#898781;
    --rule:#2c2c2a; --ring:rgba(255,255,255,.10);
    --good-ink:#4cc44c; --warning-ink:#fab219; --serious-ink:#ec835a; --critical-ink:#e46a6a;
  }
}
*{box-sizing:border-box}
body{margin:0;padding:32px 20px 64px;background:var(--surface);color:var(--ink);
  font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:940px;margin:0 auto}
h1{font-size:20px;margin:0 0 4px}
.sub{color:var(--ink2);font-size:13px;margin:0 0 16px}
a{color:inherit}
h2{font-size:14px;font-weight:600;margin:28px 0 4px;padding-bottom:6px;
  border-bottom:1px solid var(--rule);font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.count{color:var(--muted);font-weight:400}
.readup{font-size:11px;color:var(--muted);margin:0 0 8px;letter-spacing:.03em;text-transform:uppercase}

/* The direction banner. A dependency graph is ambiguous without a label, so the
   direction is stated once, loudly, at the top -- and again in the figure
   caption, and again on every single edge in the list below it. */
.direction{border:1px solid var(--ring);border-left:3px solid var(--good);border-radius:6px;
  padding:12px 14px;background:var(--raised);margin:0 0 20px;font-size:13px;color:var(--ink2)}
.direction strong{color:var(--ink)}
.direction>strong{font-size:14px}
.direction ul{margin:8px 0 0;padding-left:18px}
.direction li{margin:4px 0}
${graphCss(graph.layout.width)}
ul.tree{list-style:none;margin:0;padding:0}
ul.tree>li{position:relative;margin:6px 0}
.pr{background:var(--raised);border:1px solid var(--ring);border-radius:6px;padding:8px 10px}
.pr.dep{background:transparent;border-style:dashed}
.line1{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}
.num{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-weight:600;text-decoration:none}
.num:hover{text-decoration:underline}
.title{color:var(--ink2)}
.line2{margin-top:5px;font-size:12px;display:flex;gap:6px;align-items:center;flex-wrap:wrap}
/* the edge list: every arrow the SVG draws, written out on both of its ends */
ul.edges{list-style:none;margin:6px 0 0;padding:6px 0 0;border-top:1px dashed var(--rule);
  font-size:12px}
ul.edges li{margin:3px 0;display:flex;gap:6px;align-items:baseline;flex-wrap:wrap}
ul.edges li.out{color:var(--muted)}
ul.edges .dir{font-size:11px;letter-spacing:.03em;text-transform:uppercase;color:var(--muted)}
ul.edges .why{flex-basis:100%}
.badge{display:inline-flex;align-items:center;gap:4px;padding:1px 7px;border-radius:999px;
  border:1px solid currentColor;font-size:11px;font-weight:600;white-space:nowrap}
.badge .g{font-family:ui-monospace,monospace}
.badge.good{color:var(--good-ink)} .badge.warning{color:var(--warning-ink)}
.badge.serious{color:var(--serious-ink)} .badge.critical{color:var(--critical-ink)}
.badge.muted{color:var(--muted)}
.badge.foreign{color:var(--ink2);border-style:dashed;background:var(--surface)}
/* Not a status: a grouping. Dotted, and tinted like the band it names, so a
   glance ties the row back to the band it sits in on the diagram. */
.badge.step{color:var(--ink2);border-style:dotted;background:var(--band)}
.dim{color:var(--muted);font-size:12px;font-weight:400}
.status{color:var(--ink2);font-size:11px;border:1px solid var(--ring);border-radius:4px;padding:0 5px}
.gate{font-size:10px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--serious-ink)}
.why{margin-top:5px;font-size:12px;color:var(--muted)}
.withheld{border:1px solid var(--ring);border-left:3px solid var(--warning);border-radius:6px;
  padding:10px 12px;font-size:13px;color:var(--ink2);background:var(--raised);margin:0 0 20px}
/* The list's own version of the band border: the vertical run of PRs below is
   not a sequence, and this says so before the first repo heading. */
.norder{border:1px solid var(--ring);border-left:3px solid var(--ink2);border-radius:6px;
  padding:10px 12px;font-size:13px;color:var(--ink2);background:var(--raised);margin:26px 0 0}
.norder strong{color:var(--ink)}
.readup.notorder{color:var(--ink2);margin:0 0 8px}
details.syntax{border:1px solid var(--ring);border-radius:6px;padding:10px 12px;background:var(--raised);margin-bottom:8px}
details.syntax summary{cursor:pointer;font-weight:600;font-size:13px}
details.syntax pre{background:var(--surface);border:1px solid var(--rule);border-radius:4px;
  padding:10px;overflow-x:auto;font-size:12px;margin:10px 0}
details.syntax p,details.syntax li{font-size:13px;color:var(--ink2)}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;
  background:var(--surface);border:1px solid var(--rule);border-radius:3px;padding:0 4px}
footer{margin-top:40px;padding-top:12px;border-top:1px solid var(--rule);font-size:12px;color:var(--muted)}
</style>
</head><body><main>

<h1>Open PRs — merge from the bottom up</h1>
<p class="sub">${esc(author)} · ${esc(org)} · ${total} open PR${total === 1 ? '' : 's'} ·
  built ${esc(generatedAt.replace('T', ' ').slice(0, 16))} UTC</p>

<div class="direction">
<strong>Read the graph bottom-up. A PR sits above the things it needs.</strong>
<ul>
<li>Every arrow runs <strong>from a prerequisite to the PR that waits on it</strong>, so the bottom
    rank merges <strong>first</strong> and the top rank merges <strong>last</strong>.</li>
<li>A PR with no arrow arriving at it has nothing left to wait for.</li>
<li><strong>A rank has no order inside it.</strong> Each rank is drawn as one bordered band, and
    everything inside a band is <strong>independent of everything else in that band</strong> — any
    order between them, or all at the same time. A band wide enough to wrap onto several rows is
    still <em>one</em> rank, not several: the border is around all of its rows. Order exists only
    <strong>between</strong> bands, which is where the arrows and the <em>then</em> markers are.</li>
<li><strong>Every PR is drawn exactly once.</strong> A PR that two others need is one box with two
    arrows leaving it, not two boxes. Nothing on this page is a copy of anything else on it.</li>
<li>Every PR listed under a repo heading is by <strong>${esc(author)}</strong>. Somebody else's PR is
    here only as the target of one of ${esc(author)}'s dependencies, badged
    <span class="badge foreign"><span class="g">◇</span>not yours</span> — an unbadged node is
    ${esc(author)}'s own.</li>
</ul>
</div>

<figure class="graph">
<figcaption><strong>One box per PR; an arrow runs from a prerequisite up to the PR that waits on
it.</strong> ${graph.nodes.length} PR${graph.nodes.length === 1 ? '' : 's'},
${edgeCount} dependency edge${edgeCount === 1 ? '' : 's'},
${graph.layout.maxRank + 1} rank${graph.layout.maxRank === 0 ? '' : 's'} — laid out by dependency
depth. <strong>One bordered band per rank, and nothing inside a band waits on anything else in
it</strong> — a band that wraps onto several rows is still one rank, so those rows are not steps.
The same relationships are written out under the repo headings below, so nothing here depends
on the drawing rendering.</figcaption>
<div class="gwrap">
${svg}
</div>
<p class="legend">
<span><span class="band">band</span> one rank — any order inside it, no order to keep</span>
<span><span class="k">between bands</span> the only place an order exists</span>
<span><span class="k">arrow</span> merge the tail before the head</span>
<span><span class="k">solid line</span> same repo</span>
<span><span class="k">dashed line</span> crosses repos</span>
<span><span class="k">dashed box</span> not ${esc(author)}'s PR</span>
<span><span class="k">left edge</span> which rank merges when</span>
</p>
</figure>

${withheldNote}

<details class="syntax">
<summary>Why this is a graph and not a tree</summary>
<p>Dependencies between PRs are not tree-shaped in either direction, and this page used to be a
nested list, which forced the issue. A PR can have several <em>independent</em> prerequisites:
<code>stamp#491</code> needs <code>stamp#504</code> merged <strong>and</strong>
<code>snapshot.js#1225</code> released, and neither of those depends on the other. A PR can equally
<em>be</em> the prerequisite of several others.</p>
<p>A nested list gives every node exactly one place, so one of those two shapes always has to be
faked. The previous drawing nested prerequisites as children, which handled #491's two
prerequisites — but then <code>snapshot.js#1225</code>, which is both one of
${esc(author)}'s own PRs and a prerequisite of <code>stamp#491</code>, had to be
<strong>drawn twice</strong>, once in each place, with a footnote on each copy pointing at the
other.</p>
<p><strong>A graph has no such problem: one node, as many edges as the data has.</strong>
<code>snapshot.js#1225</code> is now a single box with one arrow leaving it, into
<code>stamp#491</code>. There is no second copy and no footnote, because the duplication was a
workaround for the shape of a nested list and never a fact about the PRs.</p>
<p>The drawing is <strong>one page-wide graph</strong> rather than one per repo, because the edge
that forced this rework crosses repos: an arrow between two separate diagrams needs either
client-side code or two hand-tuned coordinate systems, and on one canvas it is just an arrow. Repo
grouping survives in the list underneath, where every PR still appears under its own repo — once.</p>
<p>The diagram is generated <strong>at build time</strong> as inline SVG and the page loads nothing:
no Mermaid, no graph library, no CDN, not one <code>&lt;script&gt;</code> tag. That is also why the
full relationship list is kept below it rather than replaced by it — an SVG that fails to render
must not take the dependency information with it.</p>
</details>

<details class="syntax">
<summary>Declaring a prerequisite (the syntax this page reads)</summary>
<p>Explicit stacks — a PR whose base branch is another open PR's head — are computed from the
GitHub API and are always correct, so they need no declaration. The other two kinds GitHub
cannot see, so you write them in the <strong>PR body</strong> of the PR that is blocked, and they
become an arrow <em>into</em> it here:</p>
<pre>Depends on #504
Depends on snapshot-labs/snapshot.js#1225
Depends on release of snapshot-labs/snapshot.js#1225
Depends on #504 — reason shown on this page</pre>
<ul>
<li><code>Depends on #504</code> — same repo. Satisfied once #504 is merged.</li>
<li><code>Depends on owner/repo#123</code> — cross-repo. Satisfied once it is merged.</li>
<li><code>Depends on release of owner/repo#123</code> — cross-repo and <em>release-gated</em>.
    Merging is <strong>not</strong> enough: satisfied only once a non-draft release of that repo
    is published <em>after</em> the PR merged.</li>
<li>A trailing <code>—</code>, <code>-</code> or <code>:</code> adds a reason, rendered on the edge.</li>
</ul>
<p><strong>Whose PRs appear here.</strong> Every PR listed under a repo heading is by
<code>${esc(author)}</code>. Somebody else's PR is drawn only when one of these depends on it, as the
<em>target of that edge</em>, marked
<span class="badge foreign"><span class="g">◇</span>not yours · @handle</span> and listed apart
from ${esc(author)}'s own. Dropping it instead would hide why the PR pointing at it cannot merge. A PR
by another author that nothing here depends on is not drawn at all.</p>
<p>A prerequisite in <em>another</em> repo is the <em>same node</em> as that PR's own entry when it is
one of ${esc(author)}'s: one box, drawn once, with an arrow that crosses the repo boundary. That is
what changed — it used to be a leaf copy plus a footnote.</p>
<p>Parsing rules, so prose never becomes an edge: the line must <strong>start</strong> with
<code>Depends on</code> (a leading <code>-</code> bullet is fine); lines inside fenced code blocks are
ignored; and <strong>blockquoted lines are ignored</strong>, so quoting another PR body — or a
GitHub <code>[!IMPORTANT]</code> callout — never declares anything. Nothing on this page is inferred
heuristically: an edge exists because somebody wrote it.</p>
</details>

<details class="syntax">
<summary>How the CI column decides "its own fault" vs "the base is red"</summary>
<p>For each failing check on the PR head, the same-named check is looked up on the tip of the
PR's base branch. Failing on both sides is reported as
<span class="badge warning"><span class="g">~</span>red, but base is red too</span>; failing only on the PR is
<span class="badge critical"><span class="g">✗</span>red on its own</span>; a mix is
<span class="badge serious"><span class="g">!</span>red: partly its own</span>.</p>
<p>This is attribution by check name against the base branch's current tip. It is evidence that
the base carries the same red, <strong>not</strong> proof that the PR is otherwise clean — which is
why the badge says "base is red too" rather than "this PR is fine".</p>
</details>

${notRunningOrder}

${body}

<footer>Merge order runs from the bottom of the graph up: an arrow's tail merges before its head.
Prerequisites GitHub cannot compute come from PR bodies — if an edge is missing here, declare it
there. Rebuilt on a schedule by a GitHub Action.</footer>
</main></body></html>`;
}
