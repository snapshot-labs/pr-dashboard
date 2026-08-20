import { createHash } from 'node:crypto';

const DECIDING_STATES = new Set(['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED']);

function latestByReviewer(reviews, accepts) {
  const latest = new Map();
  reviews.forEach((review, index) => {
    const login = String(review.author || '').toLowerCase();
    const state = String(review.state || '').toUpperCase();
    if (!login || !accepts(review, state)) return;
    const submittedAt = Date.parse(review.submittedAt || '') || 0;
    const previous = latest.get(login);
    if (
      previous &&
      (previous.submittedAt > submittedAt ||
        (previous.submittedAt === submittedAt && previous.index > index))
    )
      return;
    latest.set(login, {
      login: review.author,
      state,
      commitOid: review.commitOid || null,
      submittedAt,
      index
    });
  });
  return latest;
}

export function latestDecisions(reviews = []) {
  return latestByReviewer(reviews, (_review, state) => DECIDING_STATES.has(state));
}

function hasReviewBody(review) {
  return review.hasBody ?? Boolean(review.body?.trim());
}

function latestSubstantiveReviews(reviews = []) {
  return latestByReviewer(
    reviews,
    (review, state) => DECIDING_STATES.has(state) || (state === 'COMMENTED' && hasReviewBody(review))
  );
}

export function requestedFrom(pr, reviewer) {
  const wanted = String(reviewer || '').toLowerCase();
  return (pr.reviewRequests || []).some(
    request => request.kind === 'User' && String(request.login || '').toLowerCase() === wanted
  );
}

export function unresolvedFeedback(pr, author) {
  const self = String(author || '').toLowerCase();
  return (pr.threads || []).filter(thread => {
    if (thread.isResolved) return false;
    const authors = (thread.comments || []).map(comment =>
      String(comment.author || '').toLowerCase()
    );
    return authors.length === 0 || authors.some(login => login !== self);
  });
}

export function classifyReviewState(pr, author = 'tony8713', reviewer = 'wa0x6e') {
  const latest = latestDecisions(pr.reviews);
  const substantive = latestSubstantiveReviews(pr.reviews);
  const authorKey = author.toLowerCase();
  const reviewerKey = reviewer.toLowerCase();
  const reviewerDecision = latest.get(reviewerKey);
  const reviewerState = reviewerDecision?.state;
  const reviewerRequested = requestedFrom(pr, reviewer);
  const approvalOnCurrentHead =
    reviewerState === 'APPROVED' &&
    Boolean(pr.headRefOid) &&
    reviewerDecision.commitOid === pr.headRefOid;
  const reapprovalNeeded =
    reviewerState === 'DISMISSED' || (reviewerState === 'APPROVED' && !approvalOnCurrentHead);
  const reviewerApproved = !reviewerRequested && approvalOnCurrentHead;
  const unresolved = unresolvedFeedback(pr, author);
  const unclearedChanges = [...latest.values()].filter(
    review =>
      review.state === 'CHANGES_REQUESTED' &&
      review.login.toLowerCase() !== authorKey &&
      !requestedFrom(pr, review.login)
  );
  const unclearedComments = [...substantive.values()].filter(
    review =>
      review.state === 'COMMENTED' &&
      review.login.toLowerCase() !== authorKey &&
      !requestedFrom(pr, review.login)
  );
  const needsAddressing =
    unresolved.length > 0 || unclearedChanges.length > 0 || unclearedComments.length > 0;
  const waitingForReview =
    !needsAddressing && !reviewerApproved && (reviewerRequested || reapprovalNeeded);

  let addressingReason = null;
  if (unresolved.length) {
    addressingReason = `${unresolved.length} unresolved review thread${
      unresolved.length === 1 ? '' : 's'
    }`;
  } else if (unclearedChanges.length) {
    addressingReason = `changes requested by ${unclearedChanges
      .map(review => `@${review.login}`)
      .join(', ')}`;
  } else if (unclearedComments.length) {
    addressingReason = `${unclearedComments.length} unresolved top-level review comment${
      unclearedComments.length === 1 ? '' : 's'
    }`;
  }

  let waitingReason = null;
  if (waitingForReview) {
    waitingReason =
      reviewerState === 'CHANGES_REQUESTED'
        ? 're-review requested'
        : reviewerRequested
          ? 'review requested'
          : 'reapproval needed';
  }

  return {
    needsAddressing,
    waitingForReview,
    addressingReason,
    waitingReason,
    unresolvedThreads: unresolved.length,
    unclearedChanges: unclearedChanges.map(review => review.login),
    unclearedComments: unclearedComments.map(review => review.login),
    reviewerApproved
  };
}

function reviewActivity(reviews = []) {
  const key = review =>
    [
      (review.reviewer || '').toLowerCase(),
      review.state || '',
      review.commit_oid || '',
      review.submitted_at || '',
      String(review.has_body)
    ].join('\0');
  return reviews
    .map(review => ({
      reviewer: review.author || null,
      state: review.state || null,
      commit_oid: review.commitOid || null,
      submitted_at: review.submittedAt || null,
      has_body: hasReviewBody(review)
    }))
    .sort((a, b) => key(a).localeCompare(key(b)));
}

export function reviewSnapshot(prs, author = 'tony8713', reviewer = 'wa0x6e') {
  return Object.fromEntries(
    [...(prs || [])]
      .sort((a, b) => a.key.localeCompare(b.key))
      .map(pr => {
        if (
          pr.isPrivate &&
          String(pr.author || '').toLowerCase() !== String(author || '').toLowerCase()
        )
          return [pr.key, { private: true, workflow: 'withheld' }];
        const classification = classifyReviewState(pr, author, reviewer);
        const latest = latestDecisions(pr.reviews);
        return [
          pr.key,
          {
            decision: pr.reviewDecision || null,
            draft: Boolean(pr.isDraft),
            head_oid: pr.headRefOid || null,
            private: Boolean(pr.isPrivate),
            latest_decisions: [...latest.values()]
              .map(review => ({
                reviewer: review.login,
                state: review.state,
                commit_oid: review.commitOid
              }))
              .sort((a, b) => a.reviewer.toLowerCase().localeCompare(b.reviewer.toLowerCase())),
            review_states: reviewActivity(pr.reviews),
            requests: (pr.reviewRequests || [])
              .map(
                request =>
                  `${request.kind || 'Unknown'}:${request.login || request.slug || ''}`
              )
              .sort(),
            uncleared_changes: [...classification.unclearedChanges].sort(),
            uncleared_comments: [...classification.unclearedComments].sort(),
            unresolved_threads: classification.unresolvedThreads,
            workflow: classification.needsAddressing
              ? 'needs_tony'
              : classification.waitingForReview
                ? 'waiting_wan'
                : null
          }
        ];
      })
  );
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}

export function reviewFingerprint(prs, author = 'tony8713', reviewer = 'wa0x6e') {
  const json = JSON.stringify(canonical(reviewSnapshot(prs, author, reviewer)));
  return createHash('sha256').update(json).digest('hex');
}

export function reviewQueues(nodes, inventory, author = 'tony8713', reviewer = 'wa0x6e') {
  const byKey = new Map((inventory || []).map(pr => [pr.key, pr]));
  const waitingForWan = [];
  const needsTony = [];

  for (const node of nodes || []) {
    const reviewState = byKey.get(node.key);
    if (!reviewState) throw new Error(`review inventory did not include ${node.key}`);
    const classification = classifyReviewState(reviewState, author, reviewer);
    const item = { ...node, ...classification };
    if (classification.needsAddressing) needsTony.push(item);
    else if (classification.waitingForReview) waitingForWan.push(item);
  }

  const order = (a, b) =>
    String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')) || a.key.localeCompare(b.key);
  waitingForWan.sort(order);
  needsTony.sort(order);
  return { waitingForWan, needsTony };
}
