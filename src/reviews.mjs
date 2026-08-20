const DECIDING_STATES = new Set(['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED']);

export function latestDecisions(reviews = []) {
  const latest = new Map();
  reviews.forEach((review, index) => {
    const login = String(review.author || '').toLowerCase();
    const state = String(review.state || '').toUpperCase();
    if (!login || !DECIDING_STATES.has(state)) return;
    const submittedAt = Date.parse(review.submittedAt || '') || 0;
    const previous = latest.get(login);
    if (
      previous &&
      (previous.submittedAt > submittedAt ||
        (previous.submittedAt === submittedAt && previous.index > index))
    )
      return;
    latest.set(login, { login: review.author, state, submittedAt, index });
  });
  return latest;
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
  const reviewerKey = reviewer.toLowerCase();
  const reviewerDecision = latest.get(reviewerKey);
  const reviewerRequested = requestedFrom(pr, reviewer);
  const reviewerApproved = !reviewerRequested && reviewerDecision?.state === 'APPROVED';
  const unresolved = unresolvedFeedback(pr, author);
  const unclearedChanges = [...latest.values()].filter(
    review =>
      review.state === 'CHANGES_REQUESTED' &&
      review.login.toLowerCase() !== author.toLowerCase() &&
      !requestedFrom(pr, review.login)
  );
  const needsAddressing = unresolved.length > 0 || unclearedChanges.length > 0;
  const reapprovalNeeded =
    pr.reviewDecision === 'REVIEW_REQUIRED' && reviewerDecision?.state === 'DISMISSED';
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
  }

  let waitingReason = null;
  if (waitingForReview) {
    waitingReason =
      reviewerDecision?.state === 'CHANGES_REQUESTED'
        ? 're-review requested'
        : reapprovalNeeded
          ? 'reapproval needed'
          : 'review requested';
  }

  return {
    needsAddressing,
    waitingForReview,
    addressingReason,
    waitingReason,
    unresolvedThreads: unresolved.length,
    unclearedChanges: unclearedChanges.map(review => review.login),
    reviewerApproved
  };
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
