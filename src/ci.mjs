// Is this PR red for its own reasons, or is it red because its base is red?
//
// Method: take the PR's failing checks, then look at the same-named check on
// the tip of the base branch. Same name failing on both sides means the base
// is carrying the failure. This is attribution by check name, not proof the
// two failures are the same failure -- the page says "also failing on base"
// rather than "this PR is fine", because that is all the evidence supports.

const FAILING = new Set(['failure', 'timed_out', 'action_required']);
const NEUTRAL = new Set(['success', 'neutral', 'skipped', 'cancelled']);

export function classify(prChecks, baseChecks) {
  const pending = prChecks.filter(c => c.status !== 'completed');
  const failed = prChecks.filter(c => c.conclusion && FAILING.has(c.conclusion));

  const baseByName = new Map(baseChecks.map(c => [c.name, c]));

  const ownFailures = [];
  const baseFailures = [];
  for (const c of failed) {
    const b = baseByName.get(c.name);
    if (b && b.conclusion && FAILING.has(b.conclusion)) baseFailures.push(c);
    else ownFailures.push(c);
  }

  let state;
  if (failed.length === 0 && pending.length > 0) state = 'pending';
  else if (failed.length === 0 && prChecks.length === 0) state = 'none';
  else if (failed.length === 0) state = 'green';
  else if (ownFailures.length === 0) state = 'base-red';
  else if (baseFailures.length === 0) state = 'own-red';
  else state = 'mixed';

  return {
    state,
    ownFailures: ownFailures.map(c => ({ name: c.name, url: c.url })),
    baseFailures: baseFailures.map(c => ({ name: c.name, url: c.url })),
    pending: pending.map(c => c.name),
    total: prChecks.length,
    passed: prChecks.filter(c => NEUTRAL.has(c.conclusion)).length
  };
}

export const CI_LABEL = {
  green: 'CI green',
  'base-red': 'red, but base is red too',
  'own-red': 'red on its own',
  mixed: 'red: partly its own',
  pending: 'CI running',
  none: 'no checks'
};

// The short forms the SVG boxes use, where there is room for about 25
// characters. Same wording, clipped -- never a different claim. "base red too"
// is still not "this PR is fine".
export const CI_SHORT = {
  green: 'CI green',
  'base-red': 'base is red too',
  'own-red': 'red on its own',
  mixed: 'red: partly its own',
  pending: 'CI running',
  none: 'no checks'
};

// Status roles are reserved, and every one of them ships a glyph and a word --
// never colour on its own, in the SVG or in the HTML.
export const CI_ROLE = {
  green: 'good',
  'base-red': 'warning',
  'own-red': 'critical',
  mixed: 'serious',
  pending: 'muted',
  none: 'muted'
};
export const CI_GLYPH = {
  green: '✓',
  'base-red': '~',
  'own-red': '✗',
  mixed: '!',
  pending: '·',
  none: '·'
};
