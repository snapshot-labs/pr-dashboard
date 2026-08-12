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

function depLine(d) {
  const role = d.satisfied ? 'good' : d.kind === 'cross-repo' ? 'serious' : 'warning';
  const glyph = d.satisfied ? '✓' : '⊘';
  const kindLabel =
    d.kind === 'stack' ? 'stacked on' : d.kind === 'cross-repo' ? 'cross-repo' : 'needs first';
  const ref = d.crossRepo ? `${d.repo}#${d.number}` : `#${d.number}`;
  const gate = d.needsRelease ? ' <span class="gate">release-gated</span>' : '';
  const reason = d.reason ? ` <span class="dim">— ${esc(d.reason)}</span>` : '';
  const title = d.title ? ` <span class="dim">${esc(d.title)}</span>` : '';
  const extra = d.latestRelease
    ? ` <span class="dim">(latest release ${esc(d.latestRelease.tag)} predates the merge)</span>`
    : '';
  // Somebody else's PR is on this page only because this one depends on it.
  // Say so on the line, so it is never read as part of the author's own stack.
  const whose = d.foreign
    ? ` <span class="badge foreign"><span class="g">◇</span>not yours · @${esc(d.author)}</span>`
    : '';
  const hidden = d.hidden ? ' <span class="dim">(private repo — details withheld)</span>' : '';
  return `<li class="dep">
      <span class="badge ${role}"><span class="g">${glyph}</span>${kindLabel}</span>
      <a href="${esc(d.url)}">${esc(ref)}</a>${gate}${whose}
      <span class="status">${esc(d.status)}</span>${title}${hidden}${reason}${extra}
    </li>`;
}

function node(pr, group, depth) {
  const blockers = pr.deps.filter(d => !d.satisfied);
  const ready = blockers.length === 0;

  const flags = [];
  if (pr.draft) flags.push('<span class="badge muted"><span class="g">·</span>draft</span>');
  flags.push(
    ready
      ? '<span class="badge good"><span class="g">✓</span>no blockers</span>'
      : `<span class="badge warning"><span class="g">⊘</span>blocked ×${blockers.length}</span>`
  );
  if (pr.cycle) flags.push('<span class="badge critical"><span class="g">!</span>cycle</span>');

  const kids = (group.nodes.get(pr.number)?.children || []).sort((a, b) => a - b);

  return `<li>
    <div class="pr">
      <div class="line1">
        <a class="num" href="${esc(pr.url)}">#${pr.number}</a>
        <span class="title">${esc(pr.title)}</span>
      </div>
      <div class="line2">${flags.join(' ')} ${ciBadge(pr.ci)}</div>
      ${pr.deps.length ? `<ul class="deps">${pr.deps.map(depLine).join('')}</ul>` : ''}
      ${
        pr.extraParents && pr.extraParents.length
          ? `<div class="note">also under #${pr.extraParents.join(', #')} above — shown once, edge not lost</div>`
          : ''
      }
    </div>
    ${kids.length ? `<ul class="tree">${kids.map(n => node(group.nodes.get(n), group, depth + 1)).join('')}</ul>` : ''}
  </li>`;
}

export function render({ groups, author, org, generatedAt, withheld, total }) {
  const body = groups
    .map(
      g => `<section class="repo">
      <h2>${esc(g.repo)} <span class="count">${g.count}</span></h2>
      <ul class="tree root">${g.roots.map(n => node(g.nodes.get(n), g, 0)).join('')}</ul>
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
<title>PR merge order — ${esc(author)} @ ${esc(org)}</title>
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
.sub{color:var(--ink2);font-size:13px;margin:0 0 24px}
a{color:inherit}
h2{font-size:14px;font-weight:600;margin:28px 0 8px;padding-bottom:6px;
  border-bottom:1px solid var(--rule);font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.count{color:var(--muted);font-weight:400}
ul.tree{list-style:none;margin:0;padding:0}
ul.tree ul.tree{margin-left:14px;padding-left:18px;border-left:1px solid var(--rule)}
ul.tree>li{position:relative;margin:6px 0}
ul.tree ul.tree>li::before{content:"";position:absolute;left:-18px;top:18px;
  width:14px;height:1px;background:var(--rule)}
.pr{background:var(--raised);border:1px solid var(--ring);border-radius:6px;padding:8px 10px}
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
ul.deps{list-style:none;margin:6px 0 0;padding:6px 0 0;border-top:1px dashed var(--rule);font-size:12px}
ul.deps li{margin:3px 0;display:flex;gap:6px;align-items:baseline;flex-wrap:wrap}
.status{color:var(--ink2);font-size:11px;border:1px solid var(--ring);border-radius:4px;padding:0 5px}
.gate{font-size:10px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--serious-ink)}
.note{margin-top:5px;font-size:11px;color:var(--muted)}
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

<h1>Open PRs by merge order</h1>
<p class="sub">${esc(author)} · ${esc(org)} · ${total} open PR${total === 1 ? '' : 's'} ·
  built ${esc(generatedAt.replace('T', ' ').slice(0, 16))} UTC</p>

<details class="syntax" open>
<summary>Declaring a dependency (the syntax this page reads)</summary>
<p>Explicit stacks — a PR whose base branch is another open PR's head — are computed from the
GitHub API and are always correct, so they need no declaration. The other two kinds GitHub
cannot see, so you write them in the <strong>PR body</strong> of the PR that is blocked:</p>
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
<li>A trailing <code>—</code>, <code>-</code> or <code>:</code> adds a reason, rendered next to the edge.</li>
</ul>
<p><strong>Whose PRs appear here.</strong> Every node of every tree is a PR by
<code>${esc(author)}</code>; a root is never anybody else's. Somebody else's PR is drawn only when one of
these depends on it, as a dependency on the blocked PR marked
<span class="badge foreign"><span class="g">◇</span>not yours · @handle</span> — never as a node, never as a
root. Dropping it instead would hide why the PR above it cannot merge. A PR by another author that
nothing here depends on is not drawn at all.</p>
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

<footer>Rebuilt on a schedule by a GitHub Action. Dependencies 2 and 3 come from PR bodies —
if an edge is missing here, declare it there.</footer>
</main></body></html>`;
}
