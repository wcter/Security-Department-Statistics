/**
 * Analytics engine.
 *
 * A note on honesty, because it shapes every number below: Roblox does not publish
 * group join dates or promotion history. Everything here is derived from diffing
 * roster snapshots. Two consequences are handled explicitly rather than papered over:
 *
 *  1. Members present in the very first snapshot are "bootstrapped" — we know they
 *     were already at some rank, not how long they'd been there. Their first spell
 *     is left-censored and is excluded from cohort timing statistics.
 *  2. Tenure for those members is a lower bound ("tracked since"), never a join date.
 */

export const DAY = 86400000;

export const toMs = (v) => (typeof v === 'number' ? v : Date.parse(v));
export const days = (ms) => ms / DAY;

export function median(sorted) {
  return percentile(sorted, 50);
}

/** Linear-interpolated percentile over an ascending-sorted numeric array. */
export function percentile(sorted, p) {
  if (!sorted.length) return null;
  if (sorted.length === 1) return sorted[0];
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/** Share of `sorted` at or below `value`, as 0-100. */
export function percentileRank(sorted, value) {
  if (!sorted.length) return null;
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] <= value) lo = mid + 1;
    else hi = mid;
  }
  return (lo / sorted.length) * 100;
}

export function mean(arr) {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
}

/* ------------------------------------------------------------------ */
/* Role helpers                                                        */
/* ------------------------------------------------------------------ */

/**
 * A "divider" is a cosmetic spacer role (e.g. "--------------------") that groups
 * use to visually separate tiers. It is a real role with a real rank, so it stays
 * in the ladder, but it is flagged so the UI can keep it out of the pyramid.
 */
export function isDividerRole(name) {
  const n = String(name || '').trim();
  return n.length > 0 && /^[\-_=~.*\u2022|\u00b7\u2014\u2013+#\s]+$/.test(n);
}

/**
 * Roles are identified by roleId, never by rank.
 *
 * Rank is not unique: this group has both "Member" (rank 1, the auto-generated
 * base role) and "Security Intern" (rank 1). Keying a Map by rank silently drops
 * one of them and makes a move between the two invisible.
 *
 * Rank 0 is Roblox's Guest pseudo-role and never contains members, so it is
 * excluded from the ladder entirely.
 */
export function buildRoleIndex(roles) {
  // Enrich first, then expose the enriched array — callers iterate roleIdx.roles
  // and rely on index/divider/base being present on every entry.
  const ladder = roles
    .filter((r) => r.rank > 0)
    .sort((a, b) => a.rank - b.rank || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((role, i) => ({
      ...role,
      index: i,
      divider: isDividerRole(role.name),
      base: !!role.isBase,
    }));

  const byId = new Map();
  const byRank = new Map();

  for (const entry of ladder) {
    byId.set(entry.id, entry);
    // First role at a given rank wins the alias; roleId lookups remain exact.
    if (!byRank.has(entry.rank)) byRank.set(entry.rank, entry);
  }

  // Anything excluded from the ladder still needs to resolve for display.
  for (const r of roles) {
    if (!byId.has(r.id)) {
      byId.set(r.id, { ...r, index: null, divider: isDividerRole(r.name), base: !!r.isBase });
    }
  }

  const resolve = (key) => byId.get(key) || byRank.get(key) || null;

  return {
    roles: ladder,
    all: roles,
    byId,
    byRank,
    resolve,
    /** Accepts a roleId (preferred) or, for legacy records, a rank. */
    tierOf: (key) => resolve(key)?.index ?? null,
    nameOf: (key) => resolve(key)?.name ?? null,
  };
}

/* ------------------------------------------------------------------ */
/* Per-member spell extraction                                         */
/* ------------------------------------------------------------------ */

/**
 * Turn a member's role history into spells: one entry per period spent in a role.
 * History entries are [timestamp, roleId]. `censored` marks a spell whose true
 * start we never observed (bootstrap members, and the still-running current spell).
 */
export function spellsOf(member, roleIdx, now) {
  const h = member.h || [];
  const out = [];

  for (let i = 0; i < h.length; i++) {
    const [tRaw, key] = h[i];
    const start = toMs(tRaw);
    const next = h[i + 1];
    const end = next ? toMs(next[0]) : now;
    const tier = roleIdx.tierOf(key);
    const nextTier = next ? roleIdx.tierOf(next[1]) : null;

    out.push({
      roleKey: key,
      tier,
      start,
      end,
      days: days(end - start),
      open: !next,
      leftCensored: i === 0 && !!member.boot,
      exitTier: nextTier,
      // Same tier, different role: a lateral move, not an ascension.
      promoted: next && tier != null && nextTier != null ? nextTier > tier : false,
      lateral: next && tier != null && nextTier != null ? nextTier === tier : false,
    });
  }
  return out;
}

/**
 * Cohort timing per tier: how long people actually sit in a role before moving up.
 * Only completed, uncensored, upward spells count — that is the question people
 * mean when they ask "how long does Security Cadet take?".
 *
 * Keyed by tier index rather than rank, because rank is not unique.
 */
export function buildRankTiming(members, roleIdx, now, { minSamples = 5 } = {}) {
  const clean = new Map();
  const loose = new Map();

  const push = (map, tier, value) => {
    if (tier == null) return;
    if (!map.has(tier)) map.set(tier, []);
    map.get(tier).push(value);
  };

  for (const m of members) {
    for (const s of spellsOf(m, roleIdx, now)) {
      if (s.open || !s.promoted) continue;
      push(loose, s.tier, s.days);
      if (!s.leftCensored) push(clean, s.tier, s.days);
    }
  }

  const timing = {};
  roleIdx.roles.forEach((role, tier) => {
    const c = (clean.get(tier) || []).sort((a, b) => a - b);
    const l = (loose.get(tier) || []).sort((a, b) => a - b);
    const use = c.length >= minSamples ? c : l;

    timing[tier] = {
      roleId: role.id,
      name: role.name,
      rank: role.rank,
      tier,
      samples: use.length,
      cleanSamples: c.length,
      censoredFallback: c.length < minSamples && l.length > 0,
      p10: percentile(use, 10),
      p25: percentile(use, 25),
      p50: percentile(use, 50),
      p75: percentile(use, 75),
      p90: percentile(use, 90),
      mean: mean(use),
      _sorted: use,
    };
  });
  return timing;
}

/* ------------------------------------------------------------------ */
/* Promotion window prediction                                         */
/* ------------------------------------------------------------------ */

/**
 * Predict when a member is next due to move up.
 *
 * Blends the cohort's observed time-in-role distribution for their current role
 * with the member's own promotion cadence, since people who move fast keep moving.
 */
export function predictPromotion(member, roleIdx, timing, now, cfg = {}) {
  const minSamples = cfg.minSamplesForPrediction ?? 5;
  const w = cfg.personalCadenceWeight ?? 0.4;
  const stallMult = cfg.stallMultiplier ?? 1.5;

  const tier = roleIdx.tierOf(member.ri ?? member.r);
  const served = days(now - toMs(member.since || member.fs));

  if (tier == null) {
    return { status: 'insufficient-data', label: 'Unranked', served, readiness: null, samples: 0 };
  }

  const isTop = tier === roleIdx.roles.length - 1;
  if (isTop) {
    return { status: 'top-rank', label: 'At highest rank', served, readiness: null };
  }

  const t = timing[tier];
  if (!t || t.samples < minSamples) {
    return {
      status: 'insufficient-data',
      label: 'Not enough history yet',
      served,
      readiness: null,
      samples: t?.samples ?? 0,
      needed: minSamples,
    };
  }

  const spells = spellsOf(member, roleIdx, now)
    .filter((s) => !s.open && s.promoted && !s.leftCensored);
  const personal = spells.length >= 2
    ? median(spells.map((s) => s.days).sort((a, b) => a - b))
    : null;

  const blend = (cohort) => (personal == null ? cohort : cohort * (1 - w) + personal * w);

  const p25 = blend(t.p25);
  const p50 = blend(t.p50);
  const p75 = blend(t.p75);
  const p90 = blend(t.p90 ?? t.p75 * stallMult);

  const readiness = percentileRank(t._sorted, served);

  // Thresholds come from the distribution itself rather than a fixed multiplier,
  // so a role with a naturally long tail doesn't flag half its holders as stalled.
  let status = 'on-track';
  if (served > p90) status = 'stalled';
  else if (served > p75) status = 'overdue';
  else if (served > p50) status = 'due';

  const remaining = (target) => Math.max(0, target - served);

  return {
    status,
    label: { 'on-track': 'On track', due: 'Due', overdue: 'Overdue', stalled: 'Stalled' }[status],
    served,
    readiness,
    samples: t.samples,
    usedPersonalCadence: personal != null,
    cohortMedian: t.p50,
    cohortP90: t.p90,
    earliestDays: remaining(p25),
    likelyDays: remaining(p50),
    latestDays: remaining(p75),
    earliestAt: now + remaining(p25) * DAY,
    likelyAt: now + remaining(p50) * DAY,
    latestAt: now + remaining(p75) * DAY,
  };
}

/* ------------------------------------------------------------------ */
/* Per-member metric bundle                                            */
/* ------------------------------------------------------------------ */

export function memberMetrics(member, roleIdx, timing, now, cfg = {}) {
  const spells = spellsOf(member, roleIdx, now);
  const closed = spells.filter((s) => !s.open);

  let promotions = 0;
  let demotions = 0;
  let laterals = 0;
  let tiersClimbed = 0;
  let tiersLost = 0;
  const gaps = [];

  for (const s of closed) {
    if (s.exitTier == null || s.tier == null) continue;
    const delta = s.exitTier - s.tier;
    if (delta > 0) {
      promotions++;
      tiersClimbed += delta;
      if (!s.leftCensored) gaps.push(s.days);
    } else if (delta < 0) {
      demotions++;
      tiersLost += -delta;
    } else {
      laterals++;
    }
  }

  const firstSeen = toMs(member.fs);
  const lastSeen = toMs(member.ls);
  const since = toMs(member.since || member.fs);
  const trackedDays = days(now - firstSeen);
  const daysInRank = days(now - since);
  const roleKey = member.ri ?? member.r;
  const tier = roleIdx.tierOf(roleKey);
  const role = roleIdx.resolve(roleKey);

  const recentPromotions = closed.filter(
    (s) => s.exitTier != null && s.tier != null && s.exitTier > s.tier && s.end > now - 90 * DAY
  ).length;

  const openSpell = spells[spells.length - 1];
  const longestStall = Math.max(
    ...(gaps.length ? gaps : [0]),
    openSpell && !openSpell.leftCensored ? openSpell.days : 0
  );

  return {
    id: member.id,
    username: member.u,
    displayName: member.d || member.u,
    rank: member.r,
    roleId: member.ri,
    tier,
    roleName: role?.name || 'Unknown',
    isDivider: !!role?.divider,
    trackedSince: firstSeen,
    lastSeen,
    inRankSince: since,
    daysInRank,
    trackedDays,
    bootstrapped: !!member.boot,
    departed: member.left ? toMs(member.left) : null,
    accountCreated: member.created ? toMs(member.created) : null,
    accountAgeDays: member.created ? days(now - toMs(member.created)) : null,
    promotions,
    demotions,
    laterals,
    tiersClimbed,
    tiersLost,
    recentPromotions,
    // Ranks per year. The headline "how fast do they ascend" number.
    velocity: trackedDays > 7 && tiersClimbed > 0 ? tiersClimbed / (trackedDays / 365) : 0,
    avgDaysPerPromotion: gaps.length ? mean(gaps) : null,
    fastestPromotionDays: gaps.length ? Math.min(...gaps) : null,
    longestStallDays: longestStall || null,
    nameChanges: (member.names || []).length,
    prediction: member.left ? null : predictPromotion(member, roleIdx, timing, now, cfg),
    history: spells.map((s) => ({
      tier: s.tier,
      name: roleIdx.nameOf(s.roleKey) || 'Unknown role',
      start: s.start,
      end: s.open ? null : s.end,
      days: s.days,
      censored: s.leftCensored,
    })),
  };
}

/* ------------------------------------------------------------------ */
/* Group-level aggregates                                              */
/* ------------------------------------------------------------------ */

export function bucketByDay(items, getTime) {
  const map = new Map();
  for (const it of items) {
    const d = new Date(getTime(it));
    const key = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    map.set(key, (map.get(key) || 0) + 1);
  }
  return [...map.entries()].sort((a, b) => a[0] - b[0]).map(([t, n]) => ({ t, n }));
}

/** Weekday x hour grid of promotion activity (UTC). */
export function activityHeatmap(events) {
  const grid = Array.from({ length: 7 }, () => new Array(24).fill(0));
  let max = 0;
  for (const e of events) {
    if (e.type !== 'promote') continue;
    const d = new Date(toMs(e.t));
    const cell = ++grid[d.getUTCDay()][d.getUTCHours()];
    if (cell > max) max = cell;
  }
  return { grid, max };
}

/** How many members move directly from one role to another. */
export function transitionMatrix(events, roleIdx) {
  const n = roleIdx.roles.length;
  const matrix = Array.from({ length: n }, () => new Array(n).fill(0));
  let max = 0;
  for (const e of events) {
    if (!['promote', 'demote', 'lateral'].includes(e.type)) continue;
    const from = roleIdx.tierOf(e.fromRoleId ?? e.from);
    const to = roleIdx.tierOf(e.roleId ?? e.to);
    if (from == null || to == null) continue;
    const v = ++matrix[from][to];
    if (v > max) max = v;
  }
  return { matrix, max };
}

/**
 * Cohort retention: of the members first observed in month M, what share are
 * still in the group now. Bootstrap members are excluded — their cohort is
 * "everyone who already existed", which tells you nothing.
 */
export function cohortRetention(members, now) {
  const cohorts = new Map();
  for (const m of members) {
    if (m.boot) continue;
    const d = new Date(toMs(m.fs));
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    if (!cohorts.has(key)) cohorts.set(key, { key, joined: 0, retained: 0, promoted: 0 });
    const c = cohorts.get(key);
    c.joined++;
    if (!m.left) c.retained++;
    if ((m.h || []).length > 1) c.promoted++;
  }
  return [...cohorts.values()]
    .sort((a, b) => (a.key < b.key ? -1 : 1))
    .map((c) => ({
      ...c,
      retentionPct: c.joined ? (c.retained / c.joined) * 100 : 0,
      promotedPct: c.joined ? (c.promoted / c.joined) * 100 : 0,
    }));
}

export function histogram(values, buckets) {
  const counts = new Array(buckets.length).fill(0);
  for (const v of values) {
    if (v == null) continue;
    let i = buckets.findIndex((b) => v < b.max);
    if (i === -1) i = buckets.length - 1;
    counts[i]++;
  }
  return buckets.map((b, i) => ({ label: b.label, count: counts[i] }));
}
