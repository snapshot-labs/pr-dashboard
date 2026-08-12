// The page around the drawing.
//
// The page IS the drawing now. It used to carry a second, complete copy of the
// graph underneath as a per-repo list of every PR with every edge written out on
// it; that list is gone at Wan's direction, because the point of the page is to
// show dependencies and merge order and the list was neither.
//
// What that costs, stated plainly rather than glossed over: with the SVG
// unrendered there is no longer a visible, styled, linked fallback. What is left
// in its place is inside the <svg> itself -- role="img", a <title> and a <desc>
// that spells the whole structure out in words, and a <title> on every single
// node and edge -- so the structure is still reachable without seeing the
// picture. See src/graph.mjs graphDesc().

import { esc, graphCss, graphSvg, layoutGraph } from './graph.mjs';

export function render({ graph, author, org, generatedAt, withheld, total }) {
  if (!graph.layout) graph.layout = layoutGraph(graph);
  const drawn = graph.edges.filter(e => !e.cycle);
  const cut = graph.edges.filter(e => e.cycle);
  const svg = graphSvg(graph);

  // A declared dependency that closes a cycle cannot be drawn as an arrow. It is
  // still said out loud, here and in the SVG's <desc>: dropping it silently would
  // be the page lying about what somebody wrote in a PR body.
  const cutNote = cut.length
    ? `<p class="notice cut"><strong>${cut.length} declared dependenc${
        cut.length === 1 ? 'y closes' : 'ies close'
      } a cycle</strong> and cannot be drawn as ${
        cut.length === 1 ? 'an arrow' : 'arrows'
      }, so ${cut.length === 1 ? 'it is' : 'they are'} named here instead:
      ${cut
        .map(
          e =>
            `<code>${esc(e.from.hidden ? `#${e.from.number}` : e.from.key)}</code> before
             <code>${esc(e.to.hidden ? `#${e.to.number}` : e.to.key)}</code>`
        )
        .join('; ')}. Nothing declared is dropped.</p>`
    : '';

  // The notice counts only PRs this page would otherwise have drawn, so it
  // measures what privacy is hiding and nothing else. It also says whether any
  // of them blocks something visible, because a withheld PR that blocks nothing
  // costs the graph a card with no edges, not a broken chain.
  const n = withheld.count;
  const many = n > 1;
  const withheldNote = n
    ? `<p class="notice withheld"><strong>${n} PR${many ? 's' : ''} withheld.</strong>
       ${many ? `They are ${esc(author)}'s own and live in private repos` : `It is ${esc(author)}'s own and lives in a private repo`},
       and this page is served publicly, so ${many ? 'they are' : 'it is'} not drawn here.
       ${
         withheld.blocking
           ? `<strong>${withheld.blocking}</strong> of ${many ? 'them' : 'it'} block${withheld.blocking > 1 ? '' : 's'}
              a PR on this page — that edge <em>is</em> drawn, and so is its target, but the target keeps
              only its number: no title, no author, not even the repo name.`
           : `${n === 2 ? 'Neither' : many ? 'None of them' : 'It'} blocks anything on this page, so no edge is
              missing from the graph: withholding ${many ? 'them' : 'it'} costs the page
              ${n} card${many ? 's' : ''} that would have had no edges anyway, not a broken chain.`
       }
       Set <code>INCLUDE_PRIVATE=true</code> on a private build to see ${many ? 'them' : 'it'}.
       This page does not pretend the work does not exist.</p>`
    : '';

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>PR dependency graph — merge left to right — ${esc(author)} @ ${esc(org)}</title>
<style>
:root{
  --surface:#fcfcfb; --raised:#ffffff;
  --ink:#0b0b0b; --ink2:#52514e; --muted:#898781;
  --rule:#e1e0d9; --ring:rgba(11,11,11,.10);
  --good:#0ca30c; --warning:#fab219; --serious:#ec835a; --critical:#d03b3b;
  --good-ink:#006300; --warning-ink:#7a5200; --serious-ink:#8c3d1a; --critical-ink:#a52020;
}
@media (prefers-color-scheme:dark){
  :root{
    --surface:#1a1a19; --raised:#222221;
    --ink:#ffffff; --ink2:#c3c2b7; --muted:#898781;
    --rule:#2c2c2a; --ring:rgba(255,255,255,.10);
    --good-ink:#4cc44c; --warning-ink:#fab219; --serious-ink:#ec835a; --critical-ink:#e46a6a;
  }
}
*{box-sizing:border-box}
body{margin:0;padding:32px 20px 64px;background:var(--surface);color:var(--ink);
  font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:100%;margin:0 auto}
h1{font-size:20px;margin:0 0 4px}
.sub{color:var(--ink2);font-size:13px;margin:0 0 16px}
a{color:inherit}

/* The direction banner. A dependency graph is ambiguous without a label, so the
   direction -- left to right -- is stated once, loudly, at the top, and again in
   the figure caption, again on the column headers of the drawing, and again in
   the legend. */
.direction{border:1px solid var(--ring);border-left:3px solid var(--good);border-radius:6px;
  padding:12px 14px;background:var(--raised);margin:0 0 20px;font-size:13px;color:var(--ink2)}
.direction strong{color:var(--ink)}
.direction>strong{font-size:14px}
.direction ul{margin:8px 0 0;padding-left:18px}
.direction li{margin:4px 0}
${graphCss(graph.layout)}
.notice{border:1px solid var(--ring);border-radius:6px;padding:10px 12px;font-size:13px;
  color:var(--ink2);background:var(--raised);margin:0 0 20px}
.notice strong{color:var(--ink)}
.notice.withheld{border-left:3px solid var(--warning)}
.notice.cut{border-left:3px solid var(--critical)}
details.syntax{border:1px solid var(--ring);border-radius:6px;padding:10px 12px;
  background:var(--raised);margin-bottom:8px}
details.syntax summary{cursor:pointer;font-weight:600;font-size:13px}
details.syntax pre{background:var(--surface);border:1px solid var(--rule);border-radius:4px;
  padding:10px;overflow-x:auto;font-size:12px;margin:10px 0}
details.syntax p,details.syntax li{font-size:13px;color:var(--ink2)}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;
  background:var(--surface);border:1px solid var(--rule);border-radius:3px;padding:0 4px}
footer{margin-top:40px;padding-top:12px;border-top:1px solid var(--rule);font-size:12px;
  color:var(--muted)}
</style>
</head><body><main>

<h1>Open PRs — merge left to right</h1>
<p class="sub">${esc(author)} · ${esc(org)} · ${total} open PR${total === 1 ? '' : 's'} ·
  built ${esc(generatedAt.replace('T', ' ').slice(0, 16))} UTC</p>

<div class="direction">
<strong>Read the graph left to right. A PR sits to the right of the things it needs.</strong>
<ul>
<li>Every arrow runs <strong>from a prerequisite rightward to the PR that waits on it</strong>, so
    the leftmost column merges <strong>first</strong> and the rightmost column merges
    <strong>last</strong>. A PR with no arrow arriving at it has nothing left to wait for.</li>
<li><strong>Order is the horizontal axis only.</strong> One column is one rank, and the PRs stacked
    inside a column are <strong>independent of one another</strong> — none of them waits on any
    other, so they can merge in any order or all at the same time. How high or low a card sits in
    its column means <em>nothing</em>; it is just packing. Each column header says how many PRs
    stand under it and repeats that there is no order between them.</li>
<li><strong>Every PR is drawn exactly once</strong>, as one card carrying its repo, its number and
    its title. A PR that two others need is one card with two arrows leaving it, not two cards.</li>
</ul>
</div>

<figure class="graph">
<figcaption><strong>One card per PR; an arrow runs from a prerequisite rightward to the PR that
waits on it.</strong> ${graph.nodes.length} PR${graph.nodes.length === 1 ? '' : 's'},
${drawn.length} dependency edge${drawn.length === 1 ? '' : 's'},
${graph.layout.maxRank + 1} rank${graph.layout.maxRank === 0 ? '' : 's'} — laid out by dependency
depth, <strong>one column per rank, earliest on the left</strong>. Two PRs in the same column have
no order between them. A deep graph is a wide one: it scrolls sideways rather than shrinking.
Hovering a card or an arrow gives the full title and the edges it sits on.</figcaption>
<div class="gwrap">
${svg}
</div>
<p class="legend">
<span><span class="k">left to right</span> merge order</span>
<span><span class="k">arrow</span> merge the tail before the head</span>
<span><span class="k">same column</span> one rank — no order between them</span>
<span><span class="k">dashed line</span> crosses repos</span>
<span><span class="k">dashed card</span> not ${esc(author)}'s PR</span>
<span><span class="k">◇ @handle</span> whose PR it is, when it is not ${esc(author)}'s to merge</span>
<span><span class="k crit">⊘</span> the PR's own title says do not merge</span>
<span><span class="k gate">GATED</span> release-gated: a published release, not just a merge</span>
</p>
</figure>

${cutNote}
${withheldNote}

<details class="syntax">
<summary>Declaring a prerequisite (the syntax this page reads)</summary>
<p>Explicit stacks — a PR whose base branch is another open PR's head — are computed from the
GitHub API and are always correct, so they need no declaration. The other two kinds GitHub
cannot see, so you write them in the <strong>PR body</strong> of the PR that is blocked, and they
become an arrow <em>into</em> its card here:</p>
<pre>Depends on #504
Depends on snapshot-labs/snapshot.js#1225
Depends on release of snapshot-labs/snapshot.js#1225
Depends on #504 — reason, shown when you hover the arrow</pre>
<ul>
<li><code>Depends on #504</code> — same repo. Satisfied once #504 is merged.</li>
<li><code>Depends on owner/repo#123</code> — cross-repo. Satisfied once it is merged.</li>
<li><code>Depends on release of owner/repo#123</code> — cross-repo and <em>release-gated</em>.
    Merging is <strong>not</strong> enough: satisfied only once a non-draft release of that repo
    is published <em>after</em> the PR merged. That edge is marked <code>GATED</code>.</li>
<li>A trailing <code>—</code>, <code>-</code> or <code>:</code> adds a reason.</li>
</ul>
<p><strong>Whose PRs appear here.</strong> Every card without a <code>◇</code> marker is a PR by
<code>${esc(author)}</code>. Somebody else's PR is drawn only when one of these depends on it, as the
<em>target of that edge</em>, on a dashed card marked <code>◇ @handle</code>. Dropping it instead
would hide why the PR pointing at it cannot merge. A PR by another author that nothing here depends
on is not drawn at all.</p>
<p>Parsing rules, so prose never becomes an edge: the line must <strong>start</strong> with
<code>Depends on</code> (a leading <code>-</code> bullet is fine); lines inside fenced code blocks are
ignored; and <strong>blockquoted lines are ignored</strong>, so quoting another PR body — or a
GitHub <code>[!IMPORTANT]</code> callout — never declares anything. Nothing on this page is inferred
heuristically: an edge exists because somebody wrote it.</p>
</details>

<footer>Merge order runs left to right: an arrow's tail merges before its head, and PRs sharing a
column have no order between them at all. Prerequisites GitHub cannot compute come from PR bodies —
if an edge is missing here, declare it there. Rebuilt on a schedule by a GitHub Action.</footer>
</main></body></html>`;
}
