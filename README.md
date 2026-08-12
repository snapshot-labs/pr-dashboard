# pr-dashboard

Open PRs across `snapshot-labs`, drawn as a **dependency graph: one node per PR, however many edges
that PR is on**. Static HTML, no server, no database, and nothing loaded at runtime: a GitHub Action
runs `node build.mjs` on a schedule and publishes `dist/index.html`.

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
coordinate systems; on one canvas it is just an arrow. Repo grouping survives in the list
underneath, where every PR appears under its own repo — once.

A dependency graph is ambiguous without a label, so the direction is stated in the page title, in
the `<h1>`, in a banner at the top, in the figure caption, on the column headers along the top of
the diagram (`MERGES FIRST` at the left end, `MERGES LAST` at the right end), under every repo
heading, in the legend, in the footer, and on every individual edge in the list (`needs first` one
way, `needed by` the other).

The *absence* of order is labelled just as hard, because it is the half a reader invents when nobody
says otherwise: each column header carries `N PRs · any order`, the banner and the caption and the
legend all say that a column has no order inside it, and — since the text form is a vertical list
and a vertical list looks like a sequence — every row of it carries a `rank n of m · any order among
the k in it` badge, under a notice saying the list is sorted by repo and number and is not a running
order. `rank n` is the nth column from the left.

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

Neither axis is capped. The canvas is one 150px column per rank with a 96px arrow gap between
columns, and as tall as its biggest rank needs; 
`.gwrap` scrolls it sideways; the SVG carries an explicit pixel width and `max-width:none`, so it is
never scaled to fit a narrow screen. Shrinking 10.5px refs to fit a phone would cost the page the
thing it is for; the adjacency list below is the small-screen answer.

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

The list underneath has the same defect for the same reason, and no rotation can fix it: a plain
vertical run of PRs reads as a running order, and grouping by repo scatters the PRs that share a
rank. So it says outright that it is not a running order, repeats that under every repo heading, and
puts the rank on every single row (`∥ rank 1 of 2 · any order among the 20 in it`), so the fact
travels with each PR rather than living in a legend.

That is three passes and no more. There are three edges on this page today; a crossing minimiser for
three edges would be a liability, not an asset.

`A needs B needs A` is broken by marking the edge that closes the cycle: it contributes no depth and
is not drawn, the nodes are badged `in a dependency cycle`, and the edge is still **listed** as
`cycle — not drawn` so the declaration is not silently swallowed.

## Accessibility

An SVG cannot degrade the way a `<ul>` does, so the page does not rely on it. **Every relationship
in the diagram is also written out** under the repo headings as an adjacency list: each PR appears
once, and each of its edges is named on it in both directions (`needs first` in, `needed by` out),
with the status, the release gate and the reason. With the stylesheet off, or with the SVG not
rendering at all, the dependency information is fully intact — including the rank badge, which is
how the list carries the "no order inside a rank" fact that the columns carry in the drawing.

Inside the diagram the `<svg>` carries `role="img"` plus a `<title>` and `<desc>` naming the
direction and pointing at the list; each box carries a `<title>` with the PR's full title. Nothing
is encoded by colour or line style alone: every box states its status in words next to its glyph,
and the dashed outline on somebody else's PR always arrives with the `◇ @handle` that explains it.

## Where it is deployed

**Live: <https://snapshot-labs.github.io/pr-dashboard/>**

The intended host is Netlify, and the deploy step is written and ready in `.github/build.yml` —
it is skipped until `NETLIFY_AUTH_TOKEN` and `NETLIFY_SITE_ID` exist as repo secrets, because no
Netlify credential was available to the account that built this. GitHub Pages is serving in the
meantime so the page is actually usable; adding the two secrets switches Netlify on with no code
change, and Pages can then be turned off or left as a mirror.

## Whose PRs are on it

**Every PR listed under a repo heading is by `PR_AUTHOR`. Somebody else's PR is never one of them.**

Somebody else's PR earns a place in exactly one way: one of yours depends on it. Then it is drawn as
the **target of that edge**, labelled `◇ not yours · @handle`, listed apart from yours under
`referenced only`, and never counted in the repo's open count. A PR by another author that nothing
of yours points at is not drawn at all.

The reason it is not simply filtered out: `sx-monorepo#2222` is branched off `#2219`, which is
wa0x6e's. Dropping `#2219` would hide why `#2222` cannot merge, so it stays — one arrow into
`#2222`, marked.

`buildGraph()` builds nodes from your PRs only; anybody else's becomes a node solely as the target
of one of your edges (`kind: 'dep'`), and every non-`PR_AUTHOR` PR is dropped from the seed set
explicitly and reported on `graph.pruned`, so the rule does not rest on the search string alone.

A prerequisite in **another repo** that is one of your own PRs is the *same node* as its own entry:
one box, drawn once, with an arrow that crosses the repo boundary. That is what changed — it used to
be a leaf copy plus a footnote.

## Declaring a dependency

The syntax is documented **on the page itself** (top of the dashboard), which is the copy that
matters — it is where somebody looking at the graph will go. In short, three kinds of edge:

| Kind | Where it comes from |
|---|---|
| **Explicit stack** | Computed. A PR whose base branch is another open PR's head. Never declared. |
| **Implicit, same repo** | `Depends on #504` in the blocked PR's body. |
| **Cross-repo** | `Depends on owner/repo#123`, or `Depends on release of owner/repo#123`. |

`Depends on release of …` is satisfied only when the target PR is merged **and** a non-draft
release of that repo was published afterwards — merging alone does not clear it.

A trailing `—`, `-` or `:` adds a reason, which is rendered on the edge it explains.

**Nothing is inferred.** An edge exists because somebody wrote it. To keep prose from becoming
an edge, a declaration must start its line (a leading `-` bullet is allowed), and lines inside
fenced code blocks or blockquotes are ignored — so quoting another PR body, or a GitHub
`[!IMPORTANT]` callout, never declares anything.

## The CI column

For each failing check on the PR head, the same-named check is looked up on the tip of the base
branch. Failing on both sides reads *red, but base is red too*; failing only on the PR reads
*red on its own*; a mix reads *red: partly its own*.

That is attribution by check name, not proof the two failures are the same failure. The badge
deliberately says "base is red too" and not "this PR is fine".

## Running it

```sh
GH_TOKEN=$(gh auth token) node build.mjs   # writes dist/index.html
GH_TOKEN=$(gh auth token) node test.mjs    # 70 tests
python3 -m http.server -d dist             # look at it
```

| Env var | Default | Meaning |
|---|---|---|
| `GH_TOKEN` / `GITHUB_TOKEN` | — | required |
| `PR_AUTHOR` | `tony8713` | whose PRs |
| `PR_ORG` | `snapshot-labs` | which org |
| `INCLUDE_PRIVATE` | `false` | render PRs from private repos |

### Private repos

Two of the repos in scope (`laser`, `nickai-app-fork`) are private, and the built page is served
publicly. By default those PRs are **withheld**, and the page says so, with a count — it does not
quietly drop them. Set `INCLUDE_PRIVATE=true` only for a build that is not public.

The count measures what privacy is hiding and nothing else, so it counts only PRs the page **would
otherwise have drawn**: yours, plus anybody's that something visible depends on. A private PR that
the only-yours-are-yours rule would prune anyway is not counted as withheld — calling it withheld
would overstate the loss. The notice also says how many of them block a PR shown on the page,
because a withheld PR that blocks nothing costs the graph a node with no edges rather than a broken
chain. Today that is **2 withheld, 0 blocking**.

The page never names the private repos. The dependency renderer applies the same rule: a dependency
whose target lives in a private repo keeps its number and link but drops its title and author on a
public build, and — since the graph is page-wide and every other box is labelled `repo#number` — it
is drawn as a bare `#number` and grouped under `private repos — names withheld`, so the repo name
never reaches the page as a ref.

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

Until then nothing rebuilds on a schedule; `./publish.sh` refreshes the published page by hand.
