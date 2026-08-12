# pr-dashboard

Open PRs across `snapshot-labs`, drawn as a **dependency graph: one node per PR, however many edges
that PR is on**. Static HTML, no server, no database, and nothing loaded at runtime: a GitHub Action
runs `node build.mjs` on a schedule and publishes `dist/index.html`.

## Which way the graph points

**A PR sits above the things it needs. Every arrow runs from a prerequisite to the PR that waits on
it, so the bottom rank merges first and the top rank merges last. Read the graph bottom-up.**

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
the `<h1>`, in a banner at the top, in the figure caption, on the rank labels down the left edge of
the diagram (`MERGES FIRST` / `MERGES LAST`), under every repo heading, in the legend, in the
footer, and on every individual edge in the list (`needs first` one way, `needed by` the other).

## How the diagram is drawn

Inline SVG, **generated at build time** by `src/graph.mjs` and written into the page as markup.
No Mermaid, no graph library, no CDN, not one `<script>` tag — the page is a single static file on
GitHub Pages and stays that way.

The layout is layered by dependency depth, Sugiyama-style: rank 0 is every PR with no prerequisites,
and a PR's rank is one past its *deepest* prerequisite (longest path, so a PR is never drawn level
with something it waits on). Ranks are stacked bottom-up. Within a rank, nodes are ordered by the
barycentre of the prerequisites already placed below them; a rank wider than five nodes wraps into a
grid, with the nodes that have an arrow leaving them on the row nearest the rank above. Two arrows
arriving at the same box are fanned apart, because two arrowheads on one pixel read as one arrow —
and "two edges into one node" is the fact this page exists to show.

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
rendering at all, the dependency information is fully intact.

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
GH_TOKEN=$(gh auth token) node test.mjs    # 58 tests
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
