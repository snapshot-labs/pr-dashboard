# pr-dashboard

Open PRs across `snapshot-labs`, grouped by repo and drawn as a **merge-order tree**, so a
stack is visible at a glance. Static HTML, no server, no database: a GitHub Action runs
`node build.mjs` on a schedule and publishes `dist/index.html`.

## Where it is deployed

**Live: <https://snapshot-labs.github.io/pr-dashboard/>**

The intended host is Netlify, and the deploy step is written and ready in `.github/build.yml` —
it is skipped until `NETLIFY_AUTH_TOKEN` and `NETLIFY_SITE_ID` exist as repo secrets, because no
Netlify credential was available to the account that built this. GitHub Pages is serving in the
meantime so the page is actually usable; adding the two secrets switches Netlify on with no code
change, and Pages can then be turned off or left as a mirror.

## Whose PRs are on it

**Every node of every tree is a PR by `PR_AUTHOR`. A root is never anybody else's.**

Somebody else's PR earns a place in exactly one way: one of yours depends on it. Then it is drawn
as a **dependency on your blocked PR**, labelled `◇ not yours · @handle`, and never as a node or a
root of its own. A PR by another author that nothing of yours points at is not drawn at all.

The reason it is not simply filtered out: `sx-monorepo#2222` is branched off `#2219`, which is
wa0x6e's. Dropping `#2219` would hide why `#2222` cannot merge, so it stays — as an edge, marked.

Merge order runs root-first, so a dependency is a *parent*. That is exactly why another author's
PR cannot be a tree node at all: as a dependency of yours it would sit above yours, which makes it
a root, which is the thing being ruled out. `buildGroups()` therefore drops every non-`PR_AUTHOR`
PR before laying out the forest, and reports what it dropped on `groups.pruned`.

## Declaring a dependency

The syntax is documented **on the page itself** (top of the dashboard), which is the copy that
matters — it is where somebody looking at the tree will go. In short, three kinds of edge:

| Kind | Where it comes from |
|---|---|
| **Explicit stack** | Computed. A PR whose base branch is another open PR's head. Never declared. |
| **Implicit, same repo** | `Depends on #504` in the blocked PR's body. |
| **Cross-repo** | `Depends on owner/repo#123`, or `Depends on release of owner/repo#123`. |

`Depends on release of …` is satisfied only when the target PR is merged **and** a non-draft
release of that repo was published afterwards — merging alone does not clear it.

A trailing `—`, `-` or `:` adds a reason, which is rendered beside the edge.

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
GH_TOKEN=$(gh auth token) node test.mjs    # 33 tests
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
the roots-are-mine rule would prune anyway is not counted as withheld — calling it withheld would
overstate the loss. The notice also says how many of them block a PR shown on the page, because a
withheld PR that blocks nothing costs the tree a separate root rather than a broken chain. Today
that is **2 withheld, 0 blocking**.

The page never names the private repos. The dependency renderer applies the same rule: a
dependency whose target lives in a private repo keeps its number and link but drops its title and
author on a public build.

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
