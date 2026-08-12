import { CI_LABEL } from './ci.mjs';

const esc = s =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

// Status roles are reserved and always ship glyph + text, never colour alone.
const CI_ROLE = {
  green: 'good',
  'base-red': 'warning',
  'own-red': 'critical',
  mixed: 'serious',
  pending: 'muted',
  none: 'muted'
};
const CI_GLYPH = {
  green: '✓',
  'base-red': '~',
  'own-red': '✗',
  mixed: '!',
  pending: '·',
  none: '·'
};

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

// The badge for the edge that put this node here. It is drawn on the CHILD,
// because in this tree the child IS the prerequisite.
function edgeBadge(e) {
  const role = e.satisfied ? 'good' : e.crossRepo ? 'serious' : 'warning';
  const glyph = e.satisfied ? '\u2713' : '\u2298';
  return `<span class="badge ${role}"><span class="g">${glyph}</span>${esc(EDGE_LABEL[e.kind] || 'needs first')}</span>`;
}

// Whose PR this is. Stated only when it is NOT the dashboard's author, or when
// we genuinely do not know: an unbadged node is the author's own work.
// Unknown authorship is never reported as somebody else's -- guessing reads as
// an accusation.
function ownerBadge(n) {
  if (n.kind === 'own') return '';
  const e = n.edge;
  if (e.hidden)
    return '<span class="badge foreign"><span class="g">\u25c7</span>private repo — details withheld</span>';
  if (e.unreadable || !n.author)
    return '<span class="badge foreign"><span class="g">?</span>author unknown</span>';
  if (n.foreign)
    return `<span class="badge foreign"><span class="g">\u25c7</span>not yours · @${esc(n.author)}</span>`;
  return '';
}

function node(n) {
  const e = n.edge;
  const ref = n.crossRepo ? `${n.repo}#${n.number}` : `#${n.number}`;

  const badges = [];
  if (e) {
    badges.push(edgeBadge(e));
    badges.push(`<span class="status">${esc(e.status)}</span>`);
    if (e.needsRelease) badges.push('<span class="gate">release-gated</span>');
  }
  const owner = ownerBadge(n);
  if (owner) badges.push(owner);

  if (n.kind === 'own') {
    const blockers = n.pr.deps.filter(d => !d.satisfied);
    if (n.pr.draft) badges.push('<span class="badge muted"><span class="g">·</span>draft</span>');
    // Deliberately structural, not an instruction: sx#2251 is titled
    // "[DO NOT MERGE until migration is run]" and has no prerequisites on this
    // page. It must not be told to merge now.
    badges.push(
      blockers.length === 0
        ? '<span class="badge good"><span class="g">\u2713</span>nothing beneath it</span>'
        : `<span class="badge warning"><span class="g">\u2298</span>blocked ×${blockers.length}</span>`
    );
    if (n.cycle)
      badges.push(
        '<span class="badge critical"><span class="g">!</span>cycle — already above this</span>'
      );
    badges.push(ciBadge(n.pr.ci));
  }

  const reason = e && e.reason ? `<div class="why">${esc(e.reason)}</div>` : '';
  const stale =
    e && e.latestRelease
      ? `<div class="why">latest release ${esc(e.latestRelease.tag)} predates the merge</div>`
      : '';
  // Inverting moved the duplication rather than removing it, so say where the
  // other copies are instead of letting one PR read as two.
  const repeat = n.repeat
    ? `<div class="note repeat">Also drawn ${esc(n.repeat.others.join(' and '))} — one PR drawn
       ${n.repeat.total} times on this page, not ${n.repeat.total} pieces of work.</div>`
    : '';

  const title = n.title
    ? `<span class="title">${esc(n.title)}</span>`
    : `<span class="title dim">${e && e.hidden ? 'title withheld (private repo)' : 'title unavailable'}</span>`;

  const kids = n.children;

  return `<li>
    <div class="${n.kind === 'own' ? 'pr' : 'pr dep'}">
      <div class="line1"><a class="num" href="${esc(n.url)}">${esc(ref)}</a> ${title}</div>
      <div class="line2">${badges.join(' ')}</div>
      ${reason}${stale}${repeat}
    </div>
    ${
      kids.length
        ? `<div class="downto"><span class="arrow">\u2193</span> merge ${kids.length === 1 ? 'this' : 'these ' + kids.length} first</div>
           <ul class="tree">${kids.map(node).join('')}</ul>`
        : ''
    }
  </li>`;
}

export function render({ groups, author, org, generatedAt, withheld, total }) {
  const body = groups
    .map(
      g => `<section class="repo">
      <h2>${esc(g.repo)} <span class="count">${g.count} open</span></h2>
      <p class="readup">${g.roots.length === 1 ? 'this merges last' : 'these merge last'} — read upward from the leaves</p>
      <ul class="tree root">${g.roots.map(node).join('')}</ul>
    </section>`
    )
    .join('');

  // The notice counts only PRs this page would otherwise have drawn, so it
  // measures what privacy is hiding and nothing else. It also says whether any
  // of them blocks something visible, because a withheld PR that blocks
  // nothing above costs the tree a separate root, not a broken chain.
  const n = withheld.count;
  const many = n > 1;
  const withheldNote = n
    ? `<p class="withheld"><strong>${n} PR${many ? 's' : ''} withheld.</strong>
       ${many ? `They are ${esc(author)}'s own and live in private repos` : `It is ${esc(author)}'s own and lives in a private repo`},
       and this page is served publicly, so ${many ? 'they are' : 'it is'} not rendered here.
       ${
         withheld.blocking
           ? `<strong>${withheld.blocking}</strong> of ${many ? 'them' : 'it'} block${withheld.blocking > 1 ? '' : 's'}
              a PR shown above — that edge is drawn on the blocked PR, but its target is not rendered.`
           : `${n === 2 ? 'Neither' : many ? 'None of them' : 'It'} blocks anything shown above, so no edge is
              missing from the tree: withholding ${many ? 'them' : 'it'} costs the page
              ${n} standalone root${many ? 's' : ''}, not a broken chain.`
       }
       Set <code>INCLUDE_PRIVATE=true</code> on a private build to see ${many ? 'them' : 'it'}.
       This page does not pretend the work does not exist.</p>`
    : '';

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Merge from the leaves up — ${esc(author)} @ ${esc(org)}</title>
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
main{max-width:940px;margin:0 auto}
h1{font-size:20px;margin:0 0 4px}
.sub{color:var(--ink2);font-size:13px;margin:0 0 16px}
a{color:inherit}
h2{font-size:14px;font-weight:600;margin:28px 0 4px;padding-bottom:6px;
  border-bottom:1px solid var(--rule);font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.count{color:var(--muted);font-weight:400}
.readup{font-size:11px;color:var(--muted);margin:0 0 8px;letter-spacing:.03em;text-transform:uppercase}

/* The direction banner. An inverted tree is ambiguous without a label, so the
   direction is stated once, loudly, at the top -- and again on every branch,
   right next to the nesting it describes. */
.direction{border:1px solid var(--ring);border-left:3px solid var(--good);border-radius:6px;
  padding:12px 14px;background:var(--raised);margin:0 0 20px;font-size:13px;color:var(--ink2)}
.direction strong{color:var(--ink)}
.direction>strong{font-size:14px}
.direction ul{margin:8px 0 0;padding-left:18px}
.direction li{margin:4px 0}
ul.tree{list-style:none;margin:0;padding:0}
ul.tree ul.tree{margin-left:14px;padding-left:18px;border-left:2px solid var(--rule)}
ul.tree>li{position:relative;margin:6px 0}
ul.tree ul.tree>li::before{content:"";position:absolute;left:-18px;top:18px;
  width:14px;height:1px;background:var(--rule)}
/* the "merge these first" rail label, sitting between a node and its
   prerequisites, so the direction is legible at every single nesting */
.downto{margin:5px 0 1px 14px;padding-left:6px;font-size:11px;font-weight:600;
  letter-spacing:.03em;text-transform:uppercase;color:var(--muted)}
.downto .arrow{font-family:ui-monospace,monospace;font-weight:700;color:var(--ink2)}
.pr{background:var(--raised);border:1px solid var(--ring);border-radius:6px;padding:8px 10px}
.pr.dep{background:transparent;border-style:dashed}
.line1{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}
.num{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-weight:600;text-decoration:none}
.num:hover{text-decoration:underline}
.title{color:var(--ink2)}
.line2{margin-top:5px;font-size:12px;display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.badge{display:inline-flex;align-items:center;gap:4px;padding:1px 7px;border-radius:999px;
  border:1px solid currentColor;font-size:11px;font-weight:600;white-space:nowrap}
.badge .g{font-family:ui-monospace,monospace}
.badge.good{color:var(--good-ink)} .badge.warning{color:var(--warning-ink)}
.badge.serious{color:var(--serious-ink)} .badge.critical{color:var(--critical-ink)}
.badge.muted{color:var(--muted)}
.badge.foreign{color:var(--ink2);border-style:dashed;background:var(--surface)}
.dim{color:var(--muted);font-size:12px;font-weight:400}
.status{color:var(--ink2);font-size:11px;border:1px solid var(--ring);border-radius:4px;padding:0 5px}
.gate{font-size:10px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--serious-ink)}
.why{margin-top:5px;font-size:12px;color:var(--muted)}
.note{margin-top:5px;font-size:11px;color:var(--muted)}
.note.repeat{color:var(--serious-ink);border-top:1px dashed var(--rule);padding-top:5px}
.withheld{border:1px solid var(--ring);border-left:3px solid var(--warning);border-radius:6px;
  padding:10px 12px;font-size:13px;color:var(--ink2);background:var(--raised)}
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

<h1>Open PRs — merge from the leaves up</h1>
<p class="sub">${esc(author)} · ${esc(org)} · ${total} open PR${total === 1 ? '' : 's'} ·
  built ${esc(generatedAt.replace('T', ' ').slice(0, 16))} UTC</p>

<div class="direction">
<strong>Read every list bottom-up. A PR is drawn above the things it needs.</strong>
<ul>
<li>A node's <strong>children are its prerequisites</strong>, so the deepest leaf merges
    <strong>first</strong> and the PR at the top of a list merges <strong>last</strong>.</li>
<li>A PR with nothing beneath it has nothing left to wait for.</li>
<li>Every root is a PR by <strong>${esc(author)}</strong>. Somebody else's PR appears only as a
    prerequisite underneath one of ${esc(author)}'s, badged
    <span class="badge foreign"><span class="g">\u25c7</span>not yours</span> — an unbadged node is
    ${esc(author)}'s own.</li>
<li>A PR needed by two others is drawn under both, and every copy says where the others are.
    Inverting the tree moves the duplication, it does not abolish it.</li>
</ul>
</div>

<details class="syntax">
<summary>Why the tree points this way (and what inverting costs)</summary>
<p>A PR can have several <em>independent</em> prerequisites. <code>stamp#491</code> needs
<code>stamp#504</code> merged <strong>and</strong> <code>snapshot.js#1225</code> released, and
neither of those two depends on the other.</p>
<p>Drawn the obvious way round — prerequisites as ancestors — <code>#491</code> would have two
parents. Two parents is a graph, and a graph does not fit in a nested list, so that drawing has to
pick one parent and demote the rest to a footnote. <strong>Inverted, <code>#491</code> has two
children</strong>, which is exactly a tree, no edge is dropped, and reading order becomes merge
order.</p>
<p>The cost, stated rather than hidden: inverting does not make the structure a tree in general,
it moves where the duplication lands. A PR that is a prerequisite of <em>two</em> of
${esc(author)}'s is now drawn twice, once under each. That is the rarer direction in practice, and
every repeated node carries a note naming where its other copies are.</p>
</details>

<details class="syntax">
<summary>Declaring a prerequisite (the syntax this page reads)</summary>
<p>Explicit stacks — a PR whose base branch is another open PR's head — are computed from the
GitHub API and are always correct, so they need no declaration. The other two kinds GitHub
cannot see, so you write them in the <strong>PR body</strong> of the PR that is blocked, and they
are drawn <em>beneath</em> it here:</p>
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
<li>A trailing <code>—</code>, <code>-</code> or <code>:</code> adds a reason, rendered under the node.</li>
</ul>
<p><strong>Whose PRs appear here.</strong> Every root of every list is a PR by
<code>${esc(author)}</code>; a root is never anybody else's. Somebody else's PR is drawn only when one
of these depends on it, as a <em>leaf beneath</em> the blocked PR, marked
<span class="badge foreign"><span class="g">\u25c7</span>not yours · @handle</span> — never as a root.
Dropping it instead would hide why the PR above it cannot merge. A PR by another author that
nothing here depends on is not drawn at all.</p>
<p>A prerequisite in <em>another</em> repo is drawn as a leaf and is not expanded, even when it is
one of ${esc(author)}'s own PRs with a stack of its own. That stack is drawn in full under its own
repo heading, and the leaf says so.</p>
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

${withheldNote}

${body}

<footer>Merge order runs from the leaves up. Rebuilt on a schedule by a GitHub Action.
Prerequisites GitHub cannot compute come from PR bodies — if an edge is missing here, declare it
there.</footer>
</main></body></html>`;
}
