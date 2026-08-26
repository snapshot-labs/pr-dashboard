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
//
// WHAT IS VISIBLE, and what is folded. The drawing was still losing the page to
// the writing around it, so everything that is not the drawing -- or not the
// minimum needed to READ the drawing -- now sits behind a <summary>.
//
// Visible: the heading, the figure caption, the drawing, the legend. The caption
// is where the direction lives now, in one sentence, because a dependency graph
// with no direction label is ambiguous and that is the complaint this page has
// had more than once; it is not something a reader should have to open a block
// to find. The legend stays whole rather than trimmed to look tidy: every entry
// in it decodes a mark that is actually on the canvas, and a key you have to
// unfold is not a key.
//
// Folded: how to read it at length, the withheld notice, any edge that could not
// be drawn, the declaration syntax, and how the page is built. Folded and NOT
// deleted -- the words are all still in the file. A later agent reading this page
// needs the explanation; a person looking at it wants the picture.
//
// The two folds that report something MISSING put their count in the summary
// rather than inside the block, because a closed <details> still paints its
// summary. The page goes on admitting what it is not showing without being
// opened first.
//
// <details> is native HTML. None of this cost the page a script tag, a library or
// any runtime, and nothing is hidden with display:none -- so stripping the
// stylesheet does not spill the prose back over the drawing, and the drawing
// precedes every folded block in source order either way.

import { esc, graphCss, graphSvg, layoutGraph, nodeState } from './graph.mjs';
import { STATE_GLYPH, STATE_WORD } from './state.mjs';

// The card-fill key.
//
// open, draft and merged are always listed, because they are what the fill means
// and a reader needs to know what a colour they have not seen yet would have
// meant. closed and unknown are listed only when one is actually on the page: a
// key to a colour nothing uses is noise.
const FILL_NOTE = {
  merged: ' — a prerequisite that has already landed',
  closed: ' — closed without merging',
  unknown: ' — could not be read'
};
export function fillKey(statesPresent) {
  return ['open', 'draft', 'merged']
    .concat(['closed', 'unknown'].filter(s => statesPresent.has(s)))
    .map(
      s =>
        `<span><span class="sw st-${s}">${STATE_GLYPH[s]}</span>${esc(STATE_WORD[s])}` +
        `${esc(FILL_NOTE[s] || '')}</span>`
    )
    .join('\n');
}

// `bots` are the tracked bot logins and `botTotal` how many of their open PRs the
// page drew. Both default to empty, so a build with no tracked bot renders the
// page it always did -- no extra legend entry, no extra count, no wording about a
// distinction that is not on the canvas.
export function render({
  graph,
  author,
  org,
  generatedAt,
  withheld,
  total,
  bots = [],
  botTotal = 0
}) {
  const botList = bots.map(b => `@${b}`).join(', ');
  const botHandles = bots.length ? esc(botList) : '';
  if (!graph.layout) graph.layout = layoutGraph(graph);
  const drawn = graph.edges.filter(e => !e.cycle);
  const cut = graph.edges.filter(e => e.cycle);
  const svg = graphSvg(graph);
  const fillLegend = fillKey(new Set(graph.nodes.map(n => nodeState(n).state)));

  // A declared dependency that closes a cycle cannot be drawn as an arrow. It is
  // still said out loud, here and in the SVG's <desc>: dropping it silently would
  // be the page lying about what somebody wrote in a PR body.
  //
  // Folded, but the COUNT is in the summary. What this block reports is an edge
  // the picture above cannot show, so it has to survive being shut -- a reader
  // who never opens it must still learn that the drawing is short of an edge.
  const cutNote = cut.length
    ? `<details class="fold crit">
<summary>${cut.length} declared dependenc${
        cut.length === 1 ? 'y is' : 'ies are'
      } not drawn as ${cut.length === 1 ? 'an arrow' : 'arrows'}</summary>
<p><strong>${cut.length} declared dependenc${
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
        .join('; ')}. Nothing declared is dropped.</p>
</details>`
    : '';

  // The notice counts only PRs this page would otherwise have drawn, so it
  // measures what privacy is hiding and nothing else. It also says whether any
  // of them blocks something visible, because a withheld PR that blocks nothing
  // costs the graph a card with no edges, not a broken chain.
  //
  // Folded like the rest of the prose, and like the cut-edge note the COUNT goes
  // in the summary rather than inside the block. This notice exists so the page
  // admits it is not showing everything; an admission that only appears once you
  // open something is not one, so the number stays legible while shut.
  // A declared prerequisite that was closed without merging. Folded like the
  // cut-edge note and, like it, with the COUNT in the summary: what this block
  // reports is work that cannot proceed, and a reader who never opens it must
  // still learn that the graph is short of an edge on purpose.
  const dead = graph.abandoned || [];
  const deadNote = dead.length
    ? `<details class="fold crit">
<summary>${dead.length} declared prerequisite${
        dead.length === 1 ? ' was' : 's were'
      } closed without merging</summary>
<p><strong>${dead.length} pull request${dead.length === 1 ? '' : 's'} here declare${
        dead.length === 1 ? 's' : ''
      } a prerequisite that was closed without being merged.</strong>
      Those prerequisites are <em>not</em> drawn. A merged prerequisite is kept because it records a
      wait that is <em>over</em>; a closed one records a wait that will never end, and drawing it to
      the left of its dependent would assert a merge order that cannot happen. The dependent is
      marked <code>⊗ blocked</code> instead, because a card with no arrow arriving at it otherwise
      reads as ready:
      ${dead
        .map(
          a =>
            `<code>${esc(a.to.hidden ? `#${a.to.number}` : a.to.key)}</code> waits on
             <code>${esc(a.hidden ? `#${a.number}` : `${a.repo}#${a.number}`)}</code>`
        )
        .join('; ')}. Nothing declared is dropped in silence.</p>
</details>`
    : '';

  const n = withheld.count;
  const many = n > 1;
  const withheldNote = n
    ? `<details class="fold warn">
<summary>${n} PR${many ? 's' : ''} withheld from this page</summary>
<p><strong>${n} PR${many ? 's' : ''} withheld.</strong>
       ${
         bots.length
           ? many
             ? `They are ${esc(author)}'s own or a tracked bot's (${botHandles}) and live in private repos`
             : `It is ${esc(author)}'s own or a tracked bot's (${botHandles}) and lives in a private repo`
           : many
             ? `They are ${esc(author)}'s own and live in private repos`
             : `It is ${esc(author)}'s own and lives in a private repo`
       },
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
       This page does not pretend the work does not exist.</p>
</details>`
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
  /* CARD FILL = PR STATE. GitHub's own PR colours, so it is a mapping a reader
     already knows: green open, grey draft, purple merged, red closed. Kept as
     low-saturation washes because every card carries one and a PR title has to
     stay legible on top of it. The -line variable is the border and the glyph,
     the darker end of the same hue. The fills are near-isoluminant on purpose,
     so what survives greyscale is the glyph and the word, not the wash. */
  --state-open:#e8f5ec;   --state-open-line:#1a7f37;
  --state-draft:#e7e6df;  --state-draft-line:#56554e;
  --state-merged:#f1eafc; --state-merged-line:#6b3cc0;
  --state-closed:#fbeceb; --state-closed-line:#cf222e;
}
@media (prefers-color-scheme:dark){
  :root{
    --surface:#1a1a19; --raised:#222221;
    --ink:#ffffff; --ink2:#c3c2b7; --muted:#898781;
    --rule:#2c2c2a; --ring:rgba(255,255,255,.10);
    --good-ink:#4cc44c; --warning-ink:#fab219; --serious-ink:#ec835a; --critical-ink:#e46a6a;
    /* Dark mode is not the light wash dimmed: the fill goes DARKER than the card
       surface and the border and glyph go brighter, so the light-fill/dark-edge
       relationship is inverted rather than lost. */
    --state-open:#173322;   --state-open-line:#4cc44c;
    --state-draft:#37372f;  --state-draft-line:#b6b5aa;
    --state-merged:#282141; --state-merged-line:#a371f7;
    --state-closed:#3a2221; --state-closed-line:#e46a6a;
  }
}
*{box-sizing:border-box}
body{margin:0;padding:32px 20px 64px;background:var(--surface);color:var(--ink);
  font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:100%;margin:0 auto}
h1{font-size:20px;margin:0 0 4px}
.sub{color:var(--ink2);font-size:13px;margin:0 0 16px}
a{color:inherit}

${graphCss(graph.layout)}
/* Everything that is not the drawing lives in one of these.
   details/summary is native HTML: it collapses with no scripting, no library and
   no runtime of any kind, which is the only reason the page can afford to keep
   all of this prose at all. A closed block still renders its own summary, so the
   count of withheld PRs and the count of undrawable edges stay on the page even
   while their explanations are shut -- the page never stops admitting what it is
   not showing.
   With the stylesheet stripped these lose their frames and their summaries stop
   looking clickable, but the disclosure itself is the browser's, not this file's:
   a summary still opens its block, and nothing here is unreachable. */
details.fold{border:1px solid var(--ring);border-radius:6px;background:var(--raised);
  margin:0 0 8px}
details.fold>summary{cursor:pointer;padding:9px 12px;font-size:13px;font-weight:600;
  color:var(--ink)}
details.fold[open]>summary{border-bottom:1px solid var(--rule)}
details.fold>*:not(summary){margin:10px 12px}
details.fold p,details.fold li{font-size:13px;color:var(--ink2)}
details.fold strong{color:var(--ink)}
details.fold ul{padding-left:18px}
details.fold li{margin:4px 0}
details.fold pre{background:var(--surface);border:1px solid var(--rule);border-radius:4px;
  padding:10px;overflow-x:auto;font-size:12px}
/* The two folds that report something missing rather than explaining something:
   accented, so a shut block still reads as a caveat and not as more help. */
details.fold.warn{border-left:3px solid var(--warning)}
details.fold.crit{border-left:3px solid var(--critical)}
/* The graph is the centre piece. The folded stack sits under it, quiet, and is
   capped at reading width even though the canvas above it is not. */
.folds{margin-top:26px;max-width:940px}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;
  background:var(--surface);border:1px solid var(--rule);border-radius:3px;padding:0 4px}
</style>
</head><body><main>

<h1>Open PRs — merge left to right</h1>
<p class="sub">${esc(author)} · ${esc(org)} · ${total} open PR${total === 1 ? '' : 's'}${
    botTotal
      ? ` · ${botTotal} more by ${botHandles}`
      : ''
  } ·
  built ${esc(generatedAt.replace('T', ' ').slice(0, 16))} UTC</p>

<figure class="graph">
<figcaption><strong>Merge order reads left to right.</strong> A PR sits to the right of everything it
needs, so the leftmost column merges first. Two PRs in the same column have
no order between them. ${graph.nodes.length} PR${graph.nodes.length === 1 ? '' : 's'},
${drawn.length} dependency edge${drawn.length === 1 ? '' : 's'},
${graph.layout.maxRank + 1} rank${graph.layout.maxRank === 0 ? '' : 's'} —
<strong>one column per rank, earliest on the left</strong>.</figcaption>
<div class="gwrap">
${svg}
</div>
<p class="legend fills">
<span><span class="k">card fill</span> the state of the PR</span>
${fillLegend}
</p>
<p class="legend">
<span><span class="k">left to right</span> merge order</span>
<span><span class="k">arrow</span> merge the tail before the head</span>
<span><span class="k">same column</span> one rank — no order between them</span>
<span><span class="k">dashed line</span> crosses repos</span>
<span><span class="k">dashed card</span> not one of ${esc(author)}'s open PRs</span>${
    bots.length
      ? `\n<span><span class="k">dotted card</span> a tracked bot's open PR (${botHandles}) — scheduled here like ${esc(author)}'s own</span>`
      : ''
  }
<span><span class="k">◇ @handle</span> whose PR it is, when it is not ${esc(author)}'s to merge</span>
<span><span class="k appr">✓ approved @handle</span> a human other than ${esc(author)}: thicker border</span>
<span><span class="k crit">⊘</span> the PR's own title says do not merge</span>
<span><span class="k crit">⊗</span> waits on a PR that was closed without merging</span>
<span><span class="k gate">GATED</span> release-gated: a published release, not just a merge</span>
<span><span class="k met">✓ MET</span> that prerequisite has already landed</span>
</p>
</figure>

<div class="folds">

<details class="fold">
<summary>How to read this graph</summary>
<p><strong>Read the graph left to right. A PR sits to the right of the things it needs.</strong>
One card per PR; an arrow runs from a prerequisite rightward to the PR that waits on it. A deep
graph is a wide one: it scrolls sideways rather than shrinking. Hovering a card or an arrow gives
the full title and the edges it sits on.</p>
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
<li><strong>Whole chains are drawn, not just ${esc(author)}'s share of them.</strong> If one PR in a
    chain is ${esc(author)}'s${bots.length ? `, or one of ${botHandles}'s` : ''}, every PR joined to it — following the arrows in <em>either</em>
    direction — is drawn too, whoever wrote it. ${
      bots.length
        ? `A chain with none of theirs in it is`
        : `A chain with none of ${esc(author)}'s PRs in it is`
    }
    not drawn at all, and nothing arrives here except through a declared dependency.</li>
<li><strong>Every card that is not ${esc(author)}'s says so</strong>, wherever it sits: dashed, and
    marked <code>◇ @handle</code>, including one that starts a chain and has prerequisites of its
    own. An unmarked card is ${esc(author)}'s — that marker is the only thing that says whose a PR
    is, so read it.</li>${
      bots.length
        ? `
<li><strong>A tracked bot's PR is dotted, not dashed</strong> — ${botHandles} — and it is on this
    page for a different reason from every other card that is not ${esc(author)}'s. A dashed card is
    here because it stands <em>in the way</em> of ${esc(author)}'s work; a dotted one is here
    because it <em>is</em> work this page schedules, so it appears alone or mid-chain on its own
    account, takes arrows in and out, and is release-gated like any other. It still carries
    <code>◇ @handle</code>, and it is <em>not</em> counted in ${esc(author)}'s open-PR total at the
    top — it has its own count beside it.</li>`
        : ''
    }
<li><strong>The colour a card is filled with is the state of that PR</strong> —
    <span class="sw st-open">${STATE_GLYPH.open}</span>open,
    <span class="sw st-draft">${STATE_GLYPH.draft}</span>draft, or
    <span class="sw st-merged">${STATE_GLYPH.merged}</span>merged. It says nothing about whether a
    PR is <em>ready</em>; that is what the arrows say. Every card also prints its state as a glyph
    and a word beside its ref, so none of it rests on telling one colour from another. A
    <strong>merged</strong> card is only ever a prerequisite that has already landed — this page
    lists open PRs, and a merged one is drawn only when something here still depends on it.</li>
<li><strong>The whole trail is drawn, including the part already walked.</strong> A merged
    prerequisite stays, and so does whatever <em>it</em> declared, so the chain behind an open PR is
    shown end to end instead of starting halfway along. The arrow leaving a merged card is lighter
    and labelled <code>✓ MET</code>: it records a wait that is <em>over</em>, and the PR at its head
    is not held back by it. A column of nothing but merged cards is headed
    <code>ALREADY MERGED</code>. A merged PR that <em>nothing</em> here depends on is not drawn at
    all — this page is about what merges next.</li>
</ul>
</details>

${cutNote}
${deadNote}
${withheldNote}

<details class="fold">
<summary>Declaring a prerequisite (the syntax this page reads)</summary>
<p>Explicit stacks — a PR whose base branch is another open PR's head — are computed from the
GitHub API and are always correct <em>while the prerequisite is open</em>; declaring one anyway is
what keeps it drawn after that (see below). The other two kinds GitHub cannot see at all. Either way
you write it in the <strong>PR body</strong> of the PR that is blocked, and it becomes an arrow
<em>into</em> its card here:</p>
<pre>Depends on #504
Depends on snapshot-labs/snapshot.js#1225
Depends on release of snapshot-labs/snapshot.js#1225
Depends on #504 — reason, shown when you hover the arrow

Stacked on #2219
Stacked on top of #2188 (feat/safesnap-execution)
On top of #2188</pre>
<ul>
<li><code>Depends on #504</code> — same repo. Satisfied once #504 is merged.</li>
<li><code>Depends on owner/repo#123</code> — cross-repo. Satisfied once it is merged.</li>
<li><code>Depends on release of owner/repo#123</code> — cross-repo and <em>release-gated</em>.
    Merging is <strong>not</strong> enough: satisfied only once a non-draft release of that repo
    is published <em>after</em> the PR merged. That edge is marked <code>GATED</code>.</li>
<li><code>Stacked on</code>, <code>Stacked on top of</code> and <code>On top of</code> declare the
    same thing as <code>Depends on</code>, in the words people actually write on a stacked PR. Each
    takes the same three forms above.</li>
<li>A trailing <code>—</code>, <code>-</code> or <code>:</code> adds a reason to a
    <code>Depends on</code> line. On the three stack spellings that tail is <em>not</em> read as a
    reason — what follows one is, in practice, an instruction to the reader
    (<em>retarget to master after it merges</em>) rather than a description of the dependency, and it
    is stale by the time the arrow is drawn. Those arrows are labelled with the branch name instead,
    when you put one in parentheses after the number.</li>
</ul>
<p><strong>Declare the stack even though this page can compute one.</strong> An explicit stack is
computed by matching a PR's base branch against the head branches of the repo's <em>open</em> PRs, so
it exists only while the prerequisite is open: GitHub retargets the child onto the default branch
seconds after the parent merges, and that signal is then gone for good. A merged prerequisite is kept
on this page when something <em>declares</em> it, so the line in the body is what carries a stack
across the moment it lands — without it the top of the chain disappears exactly when it merges.</p>
<p><strong>Whose PRs appear here.</strong> Take the dependency graph and split it into
<em>connected chains</em> — everything joined by dependency edges, following them in either
direction. A chain is drawn <strong>in full</strong> if <strong>at least one</strong> PR in it is
<code>${esc(author)}</code>'s${
    bots.length ? ` or ${botHandles}'s` : ''
  }; a chain with none of ${bots.length ? 'theirs' : `${esc(author)}'s`} in it is not drawn at all. So
somebody else's PR is a full card here, with its own prerequisites, and can be the leftmost thing in
the picture — what it never is, is unmarked: every card that is not <code>${esc(author)}</code>'s is
dashed and carries <code>◇ @handle</code>, and it is not counted in the open-PR total at the top.</p>${
    bots.length
      ? `
<p><strong>Tracked bots.</strong> ${botHandles} ${
          bots.length === 1 ? 'is' : 'are'
        } tracked here, which means ${
          bots.length === 1 ? 'its' : 'their'
        } open PRs <em>seed</em> this page the way
<code>${esc(author)}</code>'s do: each one anchors its own chain, so it is drawn whether or not
anything of <code>${esc(author)}</code>'s is joined to it, and it sits wherever its dependencies put
it — first column, last, or in the middle, exactly like any other card. There is no rule on this page
about <em>where</em> a card may sit; rank comes from edges and nothing else. What tracking does
<strong>not</strong> do is make the work <code>${esc(author)}</code>'s: a bot's card is dotted rather
than dashed, still carries <code>◇ @handle</code>, and is counted separately from the open-PR total
at the top. A bot's PR in a private repo is withheld and counted in the notice above, on the same
terms as <code>${esc(author)}</code>'s own.</p>`
      : ''
  }
<p>This replaced a narrower rule — <em>somebody else's PR is drawn only as the target of one of
${esc(author)}'s edges, never a card of its own</em> — which cut a chain off at the first PR that was
not ${esc(author)}'s and so hid what the rest of it was waiting for. The bound did not change:
nothing is on this page that a declared dependency does not join, transitively, to a PR of
${esc(author)}'s. Being recent, or in the same repo, or interesting, brings a PR no closer to being
drawn.</p>
<p><strong>Merged PRs, and the whole trail.</strong> One rule decides them:
<em>a merged PR is drawn if and only if something on this graph depends on it.</em> A prerequisite
that has landed is <strong>kept</strong> — because the question this page answers, why is that PR
still open, is answered by the shape of the whole chain, and a chain that erases itself as it lands
answers nothing. It is <strong>transitive</strong>: if a merged PR drawn here declared a prerequisite
of its own, that one is on the same trail and is drawn too, so a merge partway along does not
truncate the picture. The other half of the rule keeps the page usable — every PR this build fetches
is open, so a merged PR that <em>nothing</em> here depends on is never picked up, and the org's whole
merge history does not bury the twenty open PRs this page exists to order.</p>
<p>The trail is merged at both ends of every link. A merged PR's declaration is followed only to a
target that <em>also</em> merged: a declaration in a PR that has since merged is a claim about the
past, and if its target is still open then the claim was never honoured — the PR merged anyway, so
that gate was not real. Drawing the link would put an open card to the <em>left</em> of a merged one
and assert it has to merge first, which is not just untrue but unsatisfiable. Those stale links are
dropped, and the build log names each one rather than hiding it.</p>
<p>A merged card sits under the chain rule like any other: it is drawn as part of the component that
needs it, and dropped with that component if none of <code>${esc(author)}</code>'s PRs is anywhere in
it. It is never counted in the open-PR total at the top, because it is not open — and if it is
somebody else's it keeps its dashed outline and its <code>◇ @handle</code> marker on top of the
merged fill, because <em>whose</em> and <em>what state</em> are two separate channels and neither is
allowed to cancel the other.</p>
<p>A merged prerequisite is resolved <em>by number</em>, not out of the open-PR listing that explicit
stacks and the candidate sweep are computed from — that listing cannot see a merged PR at all — so it
keeps its real title, author and state instead of degrading to a bare number.</p>
<p>Parsing rules, so prose never becomes an edge: the line must <strong>start</strong> with one of the
four keywords (a leading <code>-</code> bullet is fine) and must be nothing but the declaration, so
<em>Together with #2219, this will…</em> declares nothing; lines inside fenced code blocks are
ignored; and <strong>blockquoted lines are ignored</strong>, so quoting another PR body — or a
GitHub <code>[!IMPORTANT]</code> callout — never declares anything. Nothing on this page is inferred
heuristically: an edge exists because somebody wrote it, and which spelling they wrote is the only
thing that decides how the line is read.</p>
</details>

<details class="fold">
<summary>How this page is built</summary>
<p>Merge order runs left to right: an arrow's tail merges before its head, and PRs sharing a
column have no order between them at all. Prerequisites GitHub cannot compute come from PR bodies —
if an edge is missing here, declare it there. Rebuilt by hand when somebody publishes it, not on a
schedule.</p>
<p>The diagram is generated <strong>at build time</strong> as inline SVG and written into this file
as markup. The page loads <strong>nothing</strong>: no Mermaid, no graph library, no CDN, no font, not
one <code>&lt;script&gt;</code> tag. The blocks on this page are native
<code>&lt;details&gt;</code> elements, so collapsing the prose off the page cost it no runtime
either — the browser opens and shuts them on its own.</p>
<p>The card geometry, the base ink and the arrowheads are presentation attributes on the SVG rather
than CSS rules, so the drawing still reads with the stylesheet stripped. What the stylesheet adds is
the theming: dark mode, the state fills, and the dash patterns.</p>
</details>

</div>
</main></body></html>`;
}
