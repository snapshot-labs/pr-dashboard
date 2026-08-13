// Thin GitHub REST layer. No dependencies.

const API = 'https://api.github.com';

const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
if (!token) {
  console.error('No GH_TOKEN / GITHUB_TOKEN in the environment.');
  process.exit(1);
}

let calls = 0;

export async function api(path, { allow404 = false } = {}) {
  const url = path.startsWith('http') ? path : API + path;
  const res = await fetch(url, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'snapshot-labs-pr-dashboard',
      'x-github-api-version': '2022-11-28'
    }
  });
  calls++;

  if (res.status === 404 && allow404) return null;
  if (res.status === 403 || res.status === 401) {
    // Most likely a private repo the token cannot see, or a spent rate limit.
    const remaining = res.headers.get('x-ratelimit-remaining');
    if (remaining === '0') throw new Error(`Rate limit exhausted on ${url}`);
    if (allow404) return null;
  }
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} on ${url}`);
  return res.json();
}

export const apiCallCount = () => calls;

// --- queries -----------------------------------------------------------

export async function searchOpenPrs(author, org) {
  const q = encodeURIComponent(`is:pr is:open author:${author} org:${org}`);
  const out = [];
  for (let page = 1; page <= 10; page++) {
    const d = await api(`/search/issues?q=${q}&per_page=100&page=${page}`);
    out.push(...d.items);
    if (d.items.length < 100) break;
  }
  return out;
}

// Every open PR in a repo, any author: an explicit stack can sit on
// somebody else's branch (sx-monorepo#2222 sits on wa0x6e's #2219).
const openPrCache = new Map();
export async function openPrsInRepo(repo) {
  if (openPrCache.has(repo)) return openPrCache.get(repo);
  const out = [];
  for (let page = 1; page <= 10; page++) {
    const d = await api(`/repos/${repo}/pulls?state=open&per_page=100&page=${page}`, { allow404: true });
    if (!d) break;
    out.push(...d);
    if (d.length < 100) break;
  }
  openPrCache.set(repo, out);
  return out;
}

const prCache = new Map();
export async function getPr(repo, number) {
  const key = `${repo}#${number}`;
  if (prCache.has(key)) return prCache.get(key);
  const d = await api(`/repos/${repo}/pulls/${number}`, { allow404: true });
  prCache.set(key, d);
  return d;
}

export async function getRepo(repo) {
  return api(`/repos/${repo}`, { allow404: true });
}

// Combined status + check-runs for a commit, flattened to {name, conclusion}.
const checksCache = new Map();
export async function getChecks(repo, sha) {
  const key = `${repo}@${sha}`;
  if (checksCache.has(key)) return checksCache.get(key);

  const out = [];
  const runs = await api(`/repos/${repo}/commits/${sha}/check-runs?per_page=100`, { allow404: true });
  if (runs) {
    for (const r of runs.check_runs) {
      out.push({ name: r.name, status: r.status, conclusion: r.conclusion, url: r.html_url });
    }
  }
  // Legacy commit statuses (Netlify previews and friends still post these).
  const st = await api(`/repos/${repo}/commits/${sha}/status`, { allow404: true });
  if (st) {
    for (const s of st.statuses) {
      if (out.some(c => c.name === s.context)) continue;
      out.push({
        name: s.context,
        status: s.state === 'pending' ? 'in_progress' : 'completed',
        conclusion: s.state === 'pending' ? null : s.state === 'success' ? 'success' : 'failure',
        url: s.target_url
      });
    }
  }
  checksCache.set(key, out);
  return out;
}

// Every review ever submitted on a PR, in submission order.
//
// This is a LOG, not a verdict: a reviewer who approved and later requested
// changes is in it twice, and the endpoint has no "current state per reviewer"
// form. So the whole list is fetched and src/reviews.mjs reduces it. Paged for
// the same reason -- a long-running PR here already carries 17 reviews, and the
// one that matters is usually the last.
const reviewCache = new Map();
export async function getReviews(repo, number) {
  const key = `${repo}#${number}`;
  if (reviewCache.has(key)) return reviewCache.get(key);
  const out = [];
  for (let page = 1; page <= 5; page++) {
    const d = await api(`/repos/${repo}/pulls/${number}/reviews?per_page=100&page=${page}`, {
      allow404: true
    });
    if (!d) break;
    out.push(...d);
    if (d.length < 100) break;
  }
  reviewCache.set(key, out);
  return out;
}

const branchCache = new Map();
export async function getBranchHead(repo, branch) {
  const key = `${repo}:${branch}`;
  if (branchCache.has(key)) return branchCache.get(key);
  const d = await api(`/repos/${repo}/commits/${encodeURIComponent(branch)}`, { allow404: true });
  const sha = d ? d.sha : null;
  branchCache.set(key, sha);
  return sha;
}

const releaseCache = new Map();
export async function getReleases(repo) {
  if (releaseCache.has(repo)) return releaseCache.get(repo);
  const d = (await api(`/repos/${repo}/releases?per_page=30`, { allow404: true })) || [];
  const rels = d
    .filter(r => !r.draft && !r.prerelease)
    .map(r => ({ tag: r.tag_name, publishedAt: r.published_at, url: r.html_url }))
    .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
  releaseCache.set(repo, rels);
  return rels;
}
