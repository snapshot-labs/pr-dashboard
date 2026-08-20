# pr-dashboard

Open PRs across `snapshot-labs`, with a review handoff board and a dependency graph containing one
node per PR, however many edges that PR is on. Static HTML, no server, no database, and nothing
loaded at runtime: `./publish.sh` runs `node build.mjs` and publishes `dist/index.html`. On the
operating server it is called manually and by the five-minute PR poller when tracked graph or review
state changes.

## Which way the graph points

**The graph reads left to right. A PR sits to the right of the things it needs. Every arrow runs
from a prerequisite rightward to the PR that waits on it, so the leftmost column merges first and
the rightmost column merges last.** A PR merges after everything to its left that it is joined to.

**And the direction that does not exist: one rank is one column, and the PRs stacked inside a column
have no edge and no order between them.** Vertical position is packing. A reader tells order from
no-order by the axis: different column means one merges before the other, same column means any
order, or all at once.

That is also why a tall rank is never folded into a second column — two columns read as two ranks,
which would invent an order that is not there. A rank of twenty is one tall column; a long
dependency chain is a wide graph that scrolls sideways rather than being scaled down to fit.

## Why it is a graph and not a tree

Dependencies between PRs are not tree-shaped in either direction. A PR can have several
*independent* prerequisites — `stamp#491` needs `stamp#504` merged **and** `snapshot.js#1225`
released, and neither of those depends on the other — and a PR can equally *be* the prerequisite of
several others.

A nested list gives every node exactly one place, so one of those two shapes always has to be faked.
This page used to nest prerequisites as children, which handled `#491`'s two prerequisites. But
`snapshot.js#1225` is both one of your own PRs *and* a prerequisite of `stamp#491`, so it had to be
**drawn twice**, once in each place, with a footnote on each copy pointing at the other.

**A graph has no such problem: one node, as many edges as the data has.** `snapshot.js#1225` is now
a single box with one arrow leaving it, into `stamp#491`. There is no second copy and no footnote,
because the duplication was a workaround for the shape of a nested list and never a fact about the
PRs. `duplicateNodes()` asserts the invariant and the build **fails** rather than shipping a page
that draws one PR twice — that is what replaced `markRepeats()`.

It is **one page-wide graph**, not one per repo. The edge that forced the rework crosses repos, and
an arrow between two separate `<svg>` elements needs either client-side code or two hand-tuned
coordinate systems; on one canvas it is just an arrow. Repo grouping survives only as accounting, in
the build log and in `groupNodes()`; the page itself is the drawing.

A dependency graph is ambiguous without a label, so the direction is stated in the page title, in
the `<h1>`, in the figure caption, on the column headers along the top of the diagram
(`MERGES FIRST` at the left end, `MERGES LAST` at the right end), in the legend, in the SVG's
`<desc>`, and on every individual edge as that edge's own `<title>`
(`stamp#504 → stamp#491 — merge stamp#504 before stamp#491 — …`).

The *absence* of order is labelled just as hard, because it is the half a reader invents when nobody
says otherwise: each column header carries `N PRs · any order`, and the caption, the legend and the
`<desc>` all say that a column has no order inside it. `rank n` is the nth column from the left.

## The graph is the page

Everything that is not the drawing, or the minimum needed to read the drawing, is behind a
`<summary>`. Visible without clicking anything: the heading, the figure caption — which is where the
direction now lives, in one sentence — the drawing, and the legend that keys every mark on it. That
is roughly 180 words; it used to be around 1750, and the prose was winning.

Collapsed, in `<details>` blocks under the graph: how to read it at length, the withheld-PRs notice,
any edge that could not be drawn, the declaration syntax, and how the page is built. **Folded, never
deleted** — the text is all still in the file, which is the point: a later agent reading this page
needs the explanation, a person looking at it wants the picture.

Two of those blocks report something *missing* rather than explaining something, so their **count
goes in the summary**: `2 PRs withheld from this page`, `1 declared dependency is not drawn as an
arrow`. A closed block still paints its summary, so the page keeps admitting what it is not showing
even when nobody opens anything. An admission you have to click for is not an admission.

`<details>` is native HTML. Collapsing the prose cost the page no `<script>`, no library and no
runtime of any kind — the browser opens and shuts these itself, which is the only reason the page
can afford to keep all of this text at all. Nothing is hidden with `display:none`, so stripping the
stylesheet does not spill the prose back over the drawing; and the graph precedes every collapsed
block in source order, so even a renderer that showed every block open would show the picture first.

## Review handoff

Two workflow lanes sit above the dependency graph. They are status indexes, not graph ranks or a
second merge order. Each compact reference jumps to the PR's canonical graph card, where the review
handoff status is printed alongside the PR's existing dependency position. Titles and dependency
cards are not duplicated in the lanes.

**Waiting for Wan** contains Tony-authored open PRs for which `wa0x6e` is requested, or Wan's latest
approval targets an earlier head commit. An approval on the current head clears the lane even if the
aggregate decision is `REVIEW_REQUIRED` because another required reviewer is missing. Tony must have
no uncleared feedback on that PR. Aggregate `REVIEW_REQUIRED` alone does not assign a PR to Wan when
there is no Wan request or prior Wan review. A resolved changes-requested review does not leave the PR
in Tony's lane once every review thread is resolved and Wan has been requested again. It moves to
Waiting for Wan instead, even while GitHub's aggregate `reviewDecision` remains stale.

**Tony to address** contains Tony-authored open PRs with an unresolved external review thread, a
substantive top-level `COMMENTED` review that has not been followed by a re-review request or later
deciding review, or a reviewer's latest deciding review is `CHANGES_REQUESTED` and that reviewer has
not been requested again. A thread containing only Tony's own notes is not external feedback. This
lane takes precedence, so a PR cannot appear in both workflow lanes.

The build reads review requests, review bodies, the append-only review log and thread-resolution
state from one GraphQL inventory. Each reviewer's latest deciding state wins; an empty `COMMENTED`
review does not erase an earlier approval or changes request. A dismissal keeps the dismissed review's
prior state: dismissing an approval can require reapproval, while dismissing a changes request clears
that feedback without inventing a Wan handoff. The workflow lanes are built only from
the same Tony-authored PR records that survived the graph's privacy filter. Tony's private inventory
records have already been reduced to neutral fields. Other private records never reach the renderer.

## What a card shows

**The repo and number, then the PR title.** The title is the change; a bare `stamp#504` is not
something anyone recognises, and the point of the picture is to see what merges before what without
opening twenty tabs. The title wraps over up to three lines and is cut with an `…` past that, and the
card is as tall as its own title. The ref stays, because it is how people refer to these.

**The card is filled by the PR's state** — open, draft or merged. See
[What a card's colour means](#what-a-cards-colour-means).

**The card is a link to the PR, and it opens in a new tab.** It is an SVG 2 `<a>`, so a plain
`href` with `target="_blank"` and `rel="noopener"` — the same attributes an HTML anchor takes, no
`xlink`. New tab because the graph is a thing you come back to and reading it costs a scroll;
`noopener` because this page is public, and a tab we opened should not get a window handle back to
it. A neutral Tony-private card keeps one canonical GitHub link, with its repository and number only
inside that `href`. Anonymous private dependency cards are not links.

Everything else that was a status label is **off the card**: CI wording, the rank badge, the
`no prerequisites` / `blocked ×N` pair. None of them is a dependency or a merge order, and together
they were most of the card. `draft` was one of them and came back as a fill, which costs no line.
Three markers survive, each with a legend entry under the drawing, because each one changes
*whether or when* something can merge:

| Marker | Where | Means |
|---|---|---|
| `✓ merged` | on a card | already landed; this link of the trail is done, see below |
| `~ merged, awaiting release` | on a card | it landed and it is *still* in the way |
| `◇ @handle` | on a card | not `PR_AUTHOR`'s PR, so not theirs to merge |
| dashed outline | on a card | not one of `PR_AUTHOR`'s open PRs: somebody else's, or a prerequisite of theirs that has already merged |
| dotted outline | on a card | a **tracked bot**'s open PR (`PR_BOT_AUTHORS`): scheduled here like `PR_AUTHOR`'s own, still marked `◇ @handle`, still outside the open-PR count |
| `⊘ …` | on a card | the PR's **own title** says do not merge |
| `GATED` | on an **edge** | release-gated: a published release clears it, a merge does not |

`✓ merged` is the one marker that displaces another: a merged card never lifts a stale `⊘` out of
its title, because a do-not-merge warning on finished work reads as a live one. It does *not*
displace `◇ @handle` — merged and not-yours are independent, and a colleague's merged PR says both.

`⊘` is lifted *out* of the title (`splitHold()`), so a long title can never truncate a
`[DO NOT MERGE until migration is run]` away and leave the PR reading as ready. The bracket is still
whole in the card's hover title.

Text is fitted to the card without a browser, so the widths in `textWidth()` are **measured**: every
printable character was rendered headless in the page's own font stack, its advance divided out, and
each bucket rounded up by five to eight per cent. The measuring face is DejaVu Sans, one of the
widest common UI sans faces, so a narrower one elsewhere only leaves spare padding.

The `any order` claim is checked rather than assumed. Two PRs at one rank cannot have a drawn edge
between them, because a drawn edge always pushes its head into a later rank — but the edge that gets
*cut* to break a cycle contributes no depth and can leave both ends at one rank. `rankCensus()`
looks for exactly that and downgrades the affected column to `a cycle is cut here`.

## How the diagram is drawn

Inline SVG, **generated at build time** by `src/graph.mjs` and written into the page as markup.
No Mermaid, no graph library, no CDN, not one `<script>` tag — the page is a single static file on
GitHub Pages and stays that way.

The layout is layered by dependency depth, Sugiyama-style: rank 0 is every PR with no prerequisites,
and a PR's rank is one past its *deepest* prerequisite (longest path, so a PR is never drawn level
with something it waits on). Rank *r* is drawn as the column at *x = r*, so the horizontal axis is
merge order. Within a column, nodes are ordered by the barycentre of the prerequisites already
placed in the columns to their left, and each one slides down only as far as it must to stop two
boxes overlapping — so a column is as tall as it needs to be and is never split. Two arrows arriving
at the same box are fanned apart across its left edge, because two arrowheads on one pixel read as
one arrow — and "two edges into one node" is the fact this page exists to show.

Neither axis is capped. The canvas is one 270px column per rank with a 96px arrow gap between
columns, and as tall as its biggest rank needs — where a rank's height is now the sum of its cards'
*own* heights, because a card is as tall as its title. `.gwrap` scrolls it sideways; the SVG carries
an explicit pixel width and `max-width:none`, so it is never scaled to fit a narrow screen.
Shrinking 11px titles to fit a phone would cost the page the thing it is for.

## Within a rank there is no order; between ranks there is

The two facts are drawn on **two different axes**, because for a while they were drawn as the same
shape. When ranks were stacked vertically, a rank wider than five wrapped onto extra rows — and a
wrapped row is the same shape as a rank: five boxes with a gap above and below. Twenty independent
PRs at rank 0 came out as four such rows, so the picture said "these five, then these five, then
these five, then these five" about PRs that have no dependency on one another at all. The only thing
distinguishing "next row" from "next rank" was 12 pixels of whitespace against 54 — a difference a
reader has to *measure*.

Rotating the drawing is what removes the ambiguity rather than annotating it. Order is now the
horizontal axis and nothing else, a rank is one **column**, and a rank is never folded, so "same
rank" and "next rank" are not the same shape at any width: same rank is the same x, next rank is a
different x. There is nothing left to measure. Each column header still says it in words as well
(`20 PRs · any order`), because the drawing should not have to be inferred from its own geometry.

The claim is checked rather than assumed. Two nodes at one rank *cannot* depend on each other — a
drawn edge forces its head at least one rank later than its tail — with one exception: an edge cut
to break a cycle contributes no depth and can leave both ends on one rank. `rankCensus()` looks for
exactly that, and a column carrying one says `a cycle is cut here` instead of claiming an
independence it does not have.

That is three passes and no more. There are three edges on this page today; a crossing minimiser for
three edges would be a liability, not an asset.

`A needs B needs A` is broken by marking the edge that closes the cycle: it contributes no depth and
is not drawn. It is still **named** — in a notice under the drawing and in the SVG's `<desc>` — so a
declaration somebody wrote in a PR body is never silently swallowed just because it cannot be drawn.

## What a card's colour means

A card's fill is the **state of the pull request**, and it is the only thing on the page that colour
is spent on.

| fill | glyph | state |
|---|---|---|
| green | `○` | open |
| grey | `◌` | draft |
| purple | `●` | merged |
| red | `✕` | closed without merging |

Every card also prints the glyph **and the word** on its ref line, opposite the ref, so none of this
rests on telling one colour from another. The glyphs are a progression — hollow, dotted, solid — that
survives greyscale and a monochrome printer; the fills are deliberately near-isoluminant washes,
because a PR title has to stay legible on top of one. Light and dark theme the four fills separately
rather than dimming one set, and no two states share a fill or a border in either scheme. The tests
check that.

**GitHub has no draft state**, so the mapping cannot be read off one field. A pull request carries
three independent ones: `state`, which is only ever `open` or `closed`; `draft` (`isDraft` in
GraphQL), a *flag*; and `merged_at`, null until it merges. A draft is therefore an **open** PR with a
flag set, not a third value of `state`, and a merged PR is a **closed** one with a timestamp, which
is the only thing separating it from a PR that was closed and thrown away. `src/state.mjs` reads
`merged_at` first, then `state`, and checks the flag only inside the open branch — so a PR closed
while still a draft reads *closed*, not *draft*. It never reads `merged`, because the pulls *list*
endpoint does not return that field.

**Which merged PRs are drawn.** This is an open-PR page: the query is `is:pr is:open`, so nothing
merged is ever picked up as a card. A merged PR appears in exactly one situation — an open PR here
declares it as a prerequisite — and then it is worth drawing, because it is a blocker that has
already gone away, which is merge-order information. It is always the *target* of an arrow, never a
card of its own, and `mergedNonPrerequisites()` fails the build rather than ship a page where one got
in some other way. Sweeping in every merged PR in the org would bury the open ones under hundreds of
finished ones. The arrow leaving one is toned down and labelled `✓ MET`, because a merged card with
an ordinary arrow on it reads as a live blocker. It is not only the *direct* prerequisite either:
whatever a drawn merged PR declared for itself is on the same trail and is drawn too — see
*Merged PRs, and the whole trail* below.

**Merged is not the same as satisfied.** A release-gated prerequisite can be merged and still be
blocking: the card is filled merged because that is what the PR *is*, while the edge keeps its
`GATED` label and its hover text still reads `merged, awaiting release`. The fill is a property of a
PR; whether a dependency is cleared is a property of an *edge*.

Today's build: **19 open, 3 draft, 0 merged.**

## Accessibility, and what removing the list cost

The page used to carry a second, complete copy of the graph underneath: a per-repo list where every
PR appeared once with each of its edges named on it in both directions. That list is **gone**, at
Wan's direction — the page is for dependencies and merge order, and the list was neither.

It was also the page's text fallback, so this is a real loss and worth stating exactly.

**What survives.** The `<svg>` carries `role="img"` with `aria-labelledby`, a `<title>`, and a
`<desc>` that is no longer a summary of the picture but the picture *in words*: every column, which
PRs stand in it, that they are in any order among themselves, and every edge written prerequisite
first (`stamp#504 before stamp#491`), including release gates and including edges cut to break a
cycle. Every node and every edge additionally carries a `<title>` of its own — the node's one gives
the full untruncated PR title, its CI verdict, and the edges it sits on in both directions. Nothing
is encoded by colour or line style alone: each marker ships a glyph plus words, the dashed outline on
somebody else's card always arrives with the `◇ @handle` that explains it, and the card fill is
printed on the card as a glyph and a word as well as named in the `<desc>` and in the card's hover
title. The `<desc>` marks any card that is not open, and leaves open unmarked as the usual case.

**What is genuinely lost.** With `role="img"` a screen reader treats the SVG as one atomic image and
announces the `<title>` and `<desc>` only — the per-node and per-edge `<title>`s are *not* exposed as
a tree, so they are hover text and view-source, not an assistive-technology structure. The `<desc>`
is therefore one long paragraph where there used to be headings, list semantics and per-PR
navigation. And the links are gone from the fallback: with the SVG unrendered there is no longer a
clickable list of PRs, only the `<a>` elements inside the drawing. The dependency *information* is
still complete and still reachable without seeing the picture; its *navigability* is worse.

## Where it is deployed

**Live: <https://snapshot-labs.github.io/pr-dashboard/>**

The intended host is Netlify, and the deploy step is written and ready in `.github/build.yml` —
it is skipped until `NETLIFY_AUTH_TOKEN` and `NETLIFY_SITE_ID` exist as repo secrets, because no
Netlify credential was available to the account that built this. GitHub Pages is serving in the
meantime so the page is actually usable; once that workflow is installed, adding the two secrets
switches Netlify on with no code change, and Pages can then be turned off or left as a mirror.

## Whose PRs are on it

**Whole connected components, drawn when at least one PR in them is *tracked*.**

Tracked means `PR_AUTHOR` or one of `PR_BOT_AUTHORS` (`chai3-bot` today). Both seed the search and
both anchor a component; only `PR_AUTHOR` is "yours".

Split the dependency graph into connected components, treating every edge as **undirected** — a
component is everything transitively joined by dependency edges, followed in either direction. A
component is drawn **in full**, every card in it and whoever wrote them, if **at least one** PR in it
is tracked. A component with nothing tracked in it is not drawn at all.

So somebody else's PR is a full card: it can be a root, it can have prerequisites of its own drawn
behind it, and it is not confined to being the target of one of your arrows. What it can never be is
unmarked — every card that is not `PR_AUTHOR`'s is dashed, carries `◇ @handle`, and is left out of
the open-PR count. That marker carries more weight than it used to: the page no longer implies whose
a card is by the mere fact of having drawn it.

This **reverses** the earlier rule, which was *"every card is a PR of yours; somebody else's is drawn
only as the target of one of your edges, never a card of its own and never a root"*. It kept
`sx-monorepo#2219` (wa0x6e's, the branch `#2222` of yours sits on) as a bare leaf and stopped there,
so if `#2219` had prerequisites of its own the page hid what `#2222` was really waiting for.

**It stays bounded.** Only PRs joined to one of yours by a *declared* dependency edge are drawn.
Nobody's PR arrives here for being recent, interesting, or in the same repo. Concretely:

- `buildGraph()` builds a node for every PR handed to it, whoever wrote it, and marks it `kind:
  'own'` (yours, carrying CI), `kind: 'bot'` (a tracked bot's open PR — dotted, marked `◇`, carrying
  CI, counted separately) or `kind: 'dep'` (anybody else's, dashed and marked `◇`).
- `pruneComponents()` then drops every component holding no *tracked* PR, in one piece, and reports
  each dropped PR on `graph.pruned` — so what the page leaves out is stated, not quietly filtered.
  `componentsOf()` is the undirected walk it uses. This is the **only** clause that decides whether a
  card is on the page: there is no rule anywhere about *where* a card may sit, and rank is computed
  from edges alone, so a tracked bot's PR — like anybody else's — appears as a root, a leaf or a
  middle node according to its edges and nothing else.
- The build sweeps the open PRs of the repos it already has a reason to open — the repos your open
  PRs live in, plus any repo a drawn dependency points into — and treats what it finds as
  *candidates*. A candidate on no dependency edge at all is not even offered to `buildGraph()`, so
  `graph.pruned` names chains that were declined, not every other open PR in the org.

Today the rule reaches exactly one PR the old one already drew — `sx-monorepo#2219` — and keeps two
all-`bonustrack` stacks out, because no PR of `PR_AUTHOR`'s is anywhere in them.

A prerequisite in **another repo** that is one of your own PRs is the *same node* as its own entry:
one box, drawn once, with an arrow that crosses the repo boundary. That is what changed — it used to
be a leaf copy plus a footnote.

## Merged PRs, and the whole trail

**A merged PR is drawn if and only if something on the graph depends on it.** One rule, two halves,
both load-bearing.

*It is kept.* The question this page answers is "why is that PR still open", and the answer is the
shape of the whole chain behind it, including the links already done. A trail that erases itself as
it lands leaves you looking at a stump.

*It is transitive.* If a merged PR drawn here declared a prerequisite of its own, that one is on the
same trail and is drawn too. `expandMergedTrail()` walks backwards through merged PRs until it runs
out, so a merge partway along a chain does not truncate the picture at the point it landed. Only a
**merged** node extends the trail: an open prerequisite heads no chain of its own here, because
following those would pull a stranger's whole backlog onto the page through one edge.

*Nothing else is kept.* A merged PR that nothing here depends on is not drawn. The seed set is your
**open** PRs, so a merged PR only ever arrives as the target of an edge; every PR you ever merged in
the org would bury the twenty open ones this page exists to order. `buildGraph()` spends a trail
record only on a PR that is *already* a node, so the transitive half cannot smuggle one in either.

**The trail is merged at both ends of every link.** A merged PR's declaration is followed only to a
target that also merged. A declaration in a PR that has since merged is a claim about the past, and
if its target is still open the claim was never honoured — the PR merged anyway, so that gate was
not real. Drawing the link would put an open card to the *left* of a merged one and assert it must
merge first, which is not just untrue but unsatisfiable. Stale links are dropped and each one is
named in the build log.

**It reads as done, never as work still to do.**

- The card is **filled as `merged`** by the state channel (see *What a card shows*), and prints
  `● merged` beside its ref, so none of it rests on telling one colour from another. A merged
  target reaches that channel with the right state because `declaredEdge()` carries `targetState`.
- The **arrow leaving it is lighter and labelled `✓ MET`** — and it gets the met **arrowhead** too.
  An SVG marker does not inherit the stroke of the path that references it, so a met edge with the
  default head came out as a light line ending in a full-weight point; hence two `<marker>` defs.
- A column of nothing but merged PRs is headed `ALREADY MERGED · this part is done` rather than
  `MERGES FIRST`, which would be a prediction about finished work.
- The hover text and the SVG `<desc>` say it in full words, which matters more than usual now that
  the per-PR list is gone and the drawing is the only surface. `<desc>` names the merged cards as a
  set before it lists the columns, and marks them individually in a column that is only part merged.
- Nothing downstream is described as held back by it.

`merged` and `satisfied` are separate facts and both are carried — the same split `state` and
`status` already make. A release-gated prerequisite that merged but has not shipped is filled as
**merged**, because that is what the PR is, **and** still holds its dependent: its edge keeps the
`GATED` label, is not lightened, and gets no `✓ MET`. A test pins `n.merged === (n.state ===
'merged')` so the two derivations cannot drift.

**Merged and *not yours* stay independent channels** — fill for state, dashes for authorship. A
colleague's merged PR is an ordinary satisfied prerequisite: it keeps the dashed outline and the
`◇ @handle` marker on top of the merged fill, and neither reading cancels the other.

**It sits under the component rule, not beside it.** The trail is expanded *before*
`pruneComponents()` runs, so a merged chain belongs to the component of the PR that needs it and is
kept or dropped with it in one piece — a merged chain hanging off a component with none of yours in
it is not drawn. And a merged card is never `kind: 'own'` even when it is yours: `own` means one of
your *open* PRs, the ones that carry CI and that the total at the top counts, and
`mergedNonPrerequisites()` fails the build if a merged PR ever gets in another way. Under the
component rule a merged card *can* be the leftmost thing in the picture, which is correct; what it
cannot be is counted as open work.

A merged prerequisite is resolved **by number** (`GET /repos/{repo}/pulls/{number}`), not out of the
open-PR listing that explicit stacks are computed from — that listing cannot see a merged PR at all.
So a merged target keeps its real title, author and merge state instead of degrading to a bare
number.

## Declaring a dependency

The syntax is documented **on the page itself** (top of the dashboard), which is the copy that
matters — it is where somebody looking at the graph will go. In short, three kinds of edge:

| Kind | Where it comes from |
|---|---|
| **Explicit stack** | Computed. A PR whose base branch is another open PR's head — but only while that PR is open, so declare it too. |
| **Implicit, same repo** | `Depends on #504` in the blocked PR's body. |
| **Cross-repo** | `Depends on owner/repo#123`, or `Depends on release of owner/repo#123`. |

`Depends on release of …` is satisfied only when the target PR is merged **and** a non-draft
release of that repo was published afterwards — merging alone does not clear it.

**Four keywords, one meaning.** `Depends on`, `Stacked on`, `Stacked on top of` and `On top of` are
read identically, and each takes all three forms above. `Depends on` was the only spelling the parser
understood for a while and nobody here writes it; what people write on a stacked PR is
`Stacked on #2219` or ``Stacked on top of #2188 (`feat/safesnap-execution`)``.

**Declare the stack even though it can be computed.** The computed stack edge matches a base branch
against the head branches of the repo's *open* PRs, so it survives exactly as long as the
prerequisite is open — GitHub retargets the child onto the default branch within seconds of the
parent merging, and the base-ref signal is then destroyed, not merely stale. The merged-trail rule
keeps a merged prerequisite only when something **declares** it, so the line in the body is the only
thing that carries a stack across the moment it lands. sx-monorepo#2219 dropped off the page when it
merged, taking the top of #2222's chain with it, while #2222's body had said `Stacked on #2219` the
whole time; teaching the parser that spelling is what put it back.

A trailing `—`, `-` or `:` adds a reason to a **`Depends on`** line, which appears in the hover title
of the edge it explains. On the three stack spellings the tail is dropped instead: what follows one
is, in practice, an instruction to the reader (*retarget to `master` after it merges*,
*review/merge that first*) rather than a description of the dependency, and it has expired by the
time the arrow is finally drawn. The rule is syntactic — decided by the keyword, never by sniffing
the prose — and the raw line is kept on the parsed declaration either way. Those arrows are labelled
`stacked on <branch>` when the author wrote a branch in parentheses after the number, which is the
same thing the computed edge's `branched from <branch>` says, so the label does not change under the
reader when the parent merges.

**Nothing is inferred.** An edge exists because somebody wrote it. To keep prose from becoming
an edge, a declaration must start its line (a leading `-` bullet is allowed) and be nothing but the
declaration — `Together with #2219, this will…` declares nothing — and lines inside
fenced code blocks or blockquotes are ignored, so quoting another PR body, or a GitHub
`[!IMPORTANT]` callout, never declares anything.

## CI

**CI is not drawn on a card.** It is not a dependency and not a merge order, and the wording was the
widest of the labels that had to go to make room for titles. It is still computed, and it reaches the
page as one phrase in the card's hover title — nowhere else.

It gave up the colour channel too. The fill means state now, so there is no CI colour anywhere on the
canvas; the distinction below is intact, but you get it by hovering.

The attribution is unchanged: for each failing check on the PR head, the same-named check is looked
up on the tip of the base branch. Failing on both sides reads *red, but base is red too*; failing
only on the PR reads *red on its own*; a mix reads *red: partly its own*. That is attribution by
check name, not proof the two failures are the same failure — which is why it says "base is red too"
and not "this PR is fine".

## Running it

```sh
GH_TOKEN=$(gh auth token) node build.mjs   # writes dist/index.html
GH_TOKEN=$(gh auth token) node test.mjs    # unit + live-API tests
python3 -m http.server -d dist             # look at it
```

| Env var | Default | Meaning |
|---|---|---|
| `GH_TOKEN` / `GITHUB_TOKEN` | — | required |
| `PR_AUTHOR` | `tony8713` | whose PRs, "yours", the open-PR count, the unmarked cards |
| `PR_REVIEWER` | `wa0x6e` | whose requested review and reapproval state fills the waiting column |
| `PR_REVIEW_EXPECTED_FINGERPRINT` | unset | poller guard; refuse if the build reads different Tony review state |
| `PR_GRAPH_EXPECTED_FINGERPRINT` | unset | poller guard; refuse if the build reads a different tracked open-PR graph snapshot |
| `PR_BOT_AUTHORS` | `chai3-bot` | comma-separated bots whose open PRs are *also* seeded and anchor components; marked, dotted, counted apart. Set to empty for a page with none |
| `PR_ORG` | `snapshot-labs` | which org |

### Private repos

The page is public. A private PR authored by `PR_AUTHOR` is reconstructed at ingestion as a minimal
public record rather than passed through from GitHub. Its card and review lane use the neutral label
`Private PR`, its open or draft state, and non-text review workflow state. The card keeps one canonical
GitHub link. The repository and PR number appear only inside that link. Titles, bodies, review and
comment text, branch names, SHAs, labels, avatars, dates, CI details and dependency declarations are
discarded before graph construction.

Private PRs by tracked bots or other authors remain withheld or anonymous under the existing
dependency rules. They are never promoted by this author-only policy. The withheld count excludes the
neutral private cards that are actually drawn and continues to count only work privacy prevented the
page from drawing.

Private repositories are never swept for dependency candidates. A neutral private card derives no
CI, avatar or dependencies. A public PR may still point to an anonymous private dependency under the
older hidden-node rule, which does not expose a repository name or link.

## Tokens

- **`PR_DASHBOARD_TOKEN`** (repo secret) — a **read-only** PAT used to read PRs, checks and
  releases across the org. Fine-grained: *Pull requests: read*, *Contents: read*,
  *Metadata: read* on the `snapshot-labs` repos. Classic equivalent: `repo` + `read:org`.
  Required, because the Action's built-in `GITHUB_TOKEN` is scoped to **this** repo and cannot
  search the org — with it the page silently under-reports.
- **`NETLIFY_AUTH_TOKEN`** + **`NETLIFY_SITE_ID`** (repo secrets) — deploy target. The deploy
  step is skipped when they are absent, so the workflow stays green until they are set.
- No token is committed anywhere in this repo.

## Installing the scheduled Action (one step, needs a token I do not have)

`.github/build.yml` is the finished workflow. It is parked one directory up because creating a
file under `.github/workflows/` requires a token carrying the **`workflow`** OAuth scope, and the
account that built this repo has only `gist, read:org, repo`. To activate it:

```sh
git mv .github/build.yml .github/workflows/build.yml
git commit -m "activate scheduled build" && git push
```

The GitHub Action remains inactive. The operating server's five-minute poller performs the scheduled
refresh instead. One GraphQL inventory is the authoritative source for the tracked open-PR graph and
Tony's review workflow. The build fetches card metadata by the inventory's exact keys, so a close or
reopen during later REST calls cannot add or omit a card. Separate graph and author-only review
fingerprints must match the poller's expected values before `gh-pages` may be pushed. A successful
push remains publication debt until a later poll verifies the same fingerprints and deployed commit;
a failed, racing or superseded publication retries on the next tick.
