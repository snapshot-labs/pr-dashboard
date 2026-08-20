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

const branchCache = new Map();
export async function getBranchHead(repo, branch) {
  const key = `${repo}:${branch}`;
  if (branchCache.has(key)) return branchCache.get(key);
  const d = await api(`/repos/${repo}/commits/${encodeURIComponent(branch)}`, { allow404: true });
  const sha = d ? d.sha : null;
  branchCache.set(key, sha);
  return sha;
}

// --- author avatars, fetched at BUILD time and inlined --------------------
//
// WHY THIS IS NOT api(). An avatar lives on a CDN, not on the API. It needs no
// token and must not be sent one, it answers with bytes rather than JSON, and a
// failure here is not a failure of the build. So it is a separate function with
// no auth header rather than a flag on api().
//
// WHY INLINE AT ALL. The page's defining property is that it loads NOTHING at
// view time: no CDN, no font, no script. Hotlinking an avatar would make a
// publicly served page fetch a third-party image for every visitor, which hands
// GitHub the IP and referrer of everyone who opens it and breaks the page
// offline. Inlining costs bytes ONCE PER AUTHOR -- the page has twenty cards and
// three authors -- and the result stays one self-contained file.
//
// TWO GUARDS, both deliberate:
//
//   the content-type allowlist is RASTER ONLY. An SVG avatar inlined into this
//   SVG would be markup inside markup, and image/svg+xml is the one image type
//   that can carry script. Browsers do load referenced images in a mode that
//   blocks it; that is a second line of defence, not this one.
//
//   MAX_AVATAR_BYTES stops one pathological avatar from doubling a 45 KB page.
//
// Anything unexpected returns null and the card simply has no avatar. An avatar
// is decoration on a page about merge order; it is never worth a failed build.
const MAX_AVATAR_BYTES = 24 * 1024;
const AVATAR_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const avatarCache = new Map();

export async function getAvatar(url, size = 48) {
  if (!url) return null;
  const key = `${url}|${size}`;
  if (avatarCache.has(key)) return avatarCache.get(key);

  let out = null;
  try {
    const u = new URL(url);
    // Ask GitHub for the size actually drawn rather than shrinking a 460px
    // original into 14 CSS pixels of page weight.
    u.searchParams.set('s', String(size));
    const res = await fetch(u, {
      headers: { accept: 'image/*', 'user-agent': 'snapshot-labs-pr-dashboard' }
    });
    calls++;
    if (res.ok) {
      const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (AVATAR_TYPES.has(type)) {
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length && buf.length <= MAX_AVATAR_BYTES) {
          out = `data:${type};base64,${buf.toString('base64')}`;
        }
      }
    }
  } catch {
    out = null;
  }
  avatarCache.set(key, out);
  return out;
}

export async function getReviewInventory(author, org) {
  const authors = (Array.isArray(author) ? author : [author]).filter(Boolean);
  const query = `
    query($query: String!) {
      search(query: $query, type: ISSUE, first: 100) {
        issueCount
        nodes {
          ... on PullRequest {
            number
            author { login }
            body
            baseRefName
            headRefName
            headRefOid
            headRepository { nameWithOwner }
            isDraft
            reviewDecision
            repository { nameWithOwner isPrivate defaultBranchRef { name } }
            reviewRequests(first: 100) {
              totalCount
              nodes {
                requestedReviewer {
                  __typename
                  ... on User { login }
                  ... on Team { slug }
                }
              }
            }
            reviews(first: 100) {
              totalCount
              nodes {
                id
                author { login }
                state
                commit { oid }
                submittedAt
                body
              }
            }
            timelineItems(first: 100, itemTypes: [REVIEW_DISMISSED_EVENT]) {
              nodes {
                ... on ReviewDismissedEvent {
                  review { id }
                  previousReviewState
                }
              }
              pageInfo { hasNextPage }
            }
            reviewThreads(first: 100) {
              totalCount
              nodes {
                isResolved
                comments(first: 20) {
                  totalCount
                  nodes { author { login } }
                }
              }
            }
          }
        }
      }
    }
  `;
  const res = await fetch(`${API}/graphql`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'snapshot-labs-pr-dashboard',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      query,
      variables: {
        query: `is:pr is:open ${authors.map(login => `author:${login}`).join(' ')} org:${org}`
      }
    })
  });
  calls++;
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} on ${API}/graphql for reviews`);
  const body = await res.json();
  if (body.errors?.length)
    throw new Error(`graphql refused reviews: ${body.errors.map(error => error.message).join('; ')}`);

  const search = body.data?.search;
  const nodes = (search?.nodes || []).filter(node => node?.repository?.nameWithOwner);
  if ((search?.issueCount || 0) > nodes.length)
    throw new Error(`review inventory was truncated at ${nodes.length} of ${search.issueCount} PRs`);

  const complete = (connection, label) => {
    const nodes = connection?.nodes || [];
    if ((connection?.totalCount || 0) > nodes.length)
      throw new Error(`${label} was truncated at ${nodes.length} of ${connection.totalCount}`);
    return nodes;
  };

  return nodes.map(node => {
    const key = `${node.repository.nameWithOwner}#${node.number}`;
    if (!node.author?.login)
      throw new Error(`authoritative review inventory returned an authorless PR: ${key}`);
    const isPrivate = Boolean(node.repository.isPrivate);
    const requests = complete(node.reviewRequests, `${key} review requests`);
    const reviews = complete(node.reviews, `${key} reviews`);
    if (node.timelineItems?.pageInfo?.hasNextPage)
      throw new Error(`${key} review dismissals were truncated at 100`);
    const dismissals = new Map(
      (node.timelineItems?.nodes || [])
        .filter(event => event?.review?.id)
        .map(event => [event.review.id, event.previousReviewState || null])
    );
    const threads = complete(node.reviewThreads, `${key} review threads`);
    return {
      key,
      author: node.author?.login || null,
      body: isPrivate ? null : node.body || '',
      baseRefName: isPrivate ? null : node.baseRefName || null,
      defaultBranch: isPrivate ? null : node.repository.defaultBranchRef?.name || null,
      headRefName: isPrivate ? null : node.headRefName || null,
      headRefOid: node.headRefOid,
      headRepo: isPrivate ? null : node.headRepository?.nameWithOwner || null,
      isDraft: Boolean(node.isDraft),
      isPrivate,
      reviewDecision: node.reviewDecision,
      reviewRequests: requests
        .map(request => request.requestedReviewer)
        .filter(Boolean)
        .map(request => ({
          kind: request.__typename,
          login: request.login || null,
          slug: request.slug || null
        })),
      reviews: reviews.map(review => ({
        author: review.author?.login || null,
        state: review.state,
        commitOid: review.commit?.oid || null,
        dismissedState: dismissals.get(review.id) || null,
        submittedAt: review.submittedAt,
        hasBody: Boolean(review.body?.trim())
      })),
      threads: threads.map((thread, index) => ({
        isResolved: thread.isResolved,
        comments: complete(thread.comments, `${key} thread ${index + 1} comments`).map(comment => ({
          author: comment.author?.login || null
        }))
      }))
    };
  });
}

async function releasesViaGraphql(repo) {
  const [owner, name] = repo.split('/');
  const query =
    'query($owner:String!,$name:String!){repository(owner:$owner,name:$name)' +
    '{releases(first:100,orderBy:{field:CREATED_AT,direction:DESC})' +
    '{nodes{tagName publishedAt isDraft isPrerelease url}}}}';
  const res = await fetch(`${API}/graphql`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'snapshot-labs-pr-dashboard',
      'content-type': 'application/json'
    },
    body: JSON.stringify({ query, variables: { owner, name } })
  });
  calls++;
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} on ${API}/graphql for ${repo}`);
  const body = await res.json();
  if (body.errors && body.errors.length)
    throw new Error(`graphql refused the releases of ${repo}: ${body.errors.map(e => e.message).join('; ')}`);
  const nodes = ((body.data || {}).repository || {}).releases;
  return ((nodes && nodes.nodes) || []).map(n => ({
    tag_name: n.tagName,
    published_at: n.publishedAt,
    html_url: n.url,
    draft: n.isDraft,
    prerelease: n.isPrerelease
  }));
}

const releaseCache = new Map();
export async function getReleases(repo) {
  if (releaseCache.has(repo)) return releaseCache.get(repo);
  let d = (await api(`/repos/${repo}/releases?per_page=30`, { allow404: true })) || [];
  if (!d.length) {
    const latest = await api(`/repos/${repo}/releases/latest`, { allow404: true });
    if (latest && latest.published_at) {
      d = await releasesViaGraphql(repo);
      if (!d.length)
        throw new Error(
          `${repo}: the releases list came back empty while ${latest.tag_name} ` +
            `(${latest.published_at}) is published. Refusing to call that "no releases".`
        );
    }
  }
  const rels = d
    .filter(r => !r.draft && !r.prerelease)
    .map(r => ({ tag: r.tag_name, publishedAt: r.published_at, url: r.html_url }))
    .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
  releaseCache.set(repo, rels);
  return rels;
}
