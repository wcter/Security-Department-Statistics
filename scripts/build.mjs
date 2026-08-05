#!/usr/bin/env node
/**
 * Turn collected state into the static JSON the dashboard reads.
 *
 * The member index is columnar (arrays, not objects) and rounded, because a
 * 50k-member group in verbose JSON is ~6 MB. Columnar + rounded is ~1.6 MB,
 * and GitHub Pages gzips it to a few hundred KB.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJSON, writeJSON, loadNDJSON, ensureDir } from './lib/store.mjs';
import {
  DAY, toMs, buildRoleIndex, buildRankTiming, memberMetrics,
  bucketByDay, activityHeatmap, transitionMatrix, cohortRetention,
  histogram, percentile, mean, isDividerRole,
} from './lib/stats.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const OUT = path.join(ROOT, 'docs', 'data');

const cfg = readJSON(path.join(ROOT, 'config.json')) || {};
const site = cfg.site || {};
const now = Date.now();

const STATUSES = ['on-track', 'due', 'overdue', 'stalled', 'top-rank', 'insufficient-data'];
const r1 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10) / 10);
const r2 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);

async function main() {
  ensureDir(OUT);

  const group = readJSON(path.join(DATA, 'group.json'));
  const roles = readJSON(path.join(DATA, 'roles.json'), []);
  const members = await loadNDJSON(path.join(DATA, 'members.ndjson'));
  const events = await loadNDJSON(path.join(DATA, 'events.ndjson'));
  const snapshots = await loadNDJSON(path.join(DATA, 'snapshots.ndjson'));

  if (!roles.length) {
    console.log('No role data yet - writing an empty-state payload.');
    writeJSON(path.join(OUT, 'meta.json'), {
      ready: false,
      title: site.title || 'Roblox Group Stats',
      subtitle: site.subtitle || '',
      generatedAt: now,
      message: 'No data collected yet. Run the "Collect group snapshot" workflow.',
    }, { pretty: true });
    return;
  }

  // Roles alone are enough to render the real rank ladder. Individual tracking,
  // timing curves and predictions stay empty until the first roster snapshot.
  const awaitingRoster = members.length === 0;

  const roleIdx = buildRoleIndex(roles);
  const timing = buildRankTiming(members, roleIdx, now, {
    minSamples: cfg.stats?.minSamplesForPrediction ?? 5,
  });

  const active = members.filter((m) => !m.left);
  const metrics = members.map((m) => memberMetrics(m, roleIdx, timing, now, cfg.stats || {}));
  const activeMetrics = metrics.filter((m) => !m.departed);

  /* ---- meta -------------------------------------------------------------- */

  const trackingSince = Math.min(...snapshots.map((s) => toMs(s.t)), now);
  const trackedDays = (now - trackingSince) / DAY;

  writeJSON(path.join(OUT, 'meta.json'), {
    ready: true,
    awaitingRoster,
    title: site.title || group?.name || 'Roblox Group Stats',
    subtitle: site.subtitle || 'Group Intelligence Dashboard',
    group: group
      ? { id: group.id, name: group.name, memberCount: group.memberCount, owner: group.owner, shout: group.shout, url: group.url, description: group.description }
      : null,
    // Only ladder roles get a tier. Guest (rank 0) is excluded entirely; the
    // auto-generated base role is flagged so the UI can keep its phantom
    // whole-membership count out of the pyramid.
    roles: roleIdx.roles.map((r) => ({
      id: r.id,
      name: r.name,
      rank: r.rank,
      tier: r.index,
      base: !!r.base,
      divider: !!r.divider,
      apiCount: r.base ? null : r.memberCount,
    })),
    generatedAt: now,
    trackingSince,
    trackedDays: r1(trackedDays),
    snapshotCount: snapshots.length,
    eventCount: events.length,
    trackedMembers: members.length,
    activeMembers: active.length,
    departedMembers: members.length - active.length,
    bootstrapped: members.filter((m) => m.boot).length,
    shards: site.memberShards || 64,
  }, { pretty: true });

  /* ---- overview ---------------------------------------------------------- */

  const promos = events.filter((e) => e.type === 'promote');
  const demos = events.filter((e) => e.type === 'demote');
  const laterals = events.filter((e) => e.type === 'lateral');
  const joins = events.filter((e) => e.type === 'join');
  const leaves = events.filter((e) => e.type === 'leave');

  const since = (d) => now - d * DAY;
  const countSince = (list, d) => list.filter((e) => toMs(e.t) >= since(d)).length;

  const rankDistribution = roleIdx.roles.map((role, i) => {
    const at = activeMetrics.filter((m) => m.tier === i);
    const t = timing[i];
    return {
      tier: i,
      rank: role.rank,
      roleId: role.id,
      name: role.name,
      base: !!role.base,
      divider: !!role.divider,
      count: at.length,
      // The base role's API count is the whole membership, not its own holders.
      apiCount: role.base ? null : role.memberCount,
      medianDaysInRank: r1(percentile(at.map((m) => m.daysInRank).sort((a, b) => a - b), 50)),
      medianTimeToPromote: r1(t?.p50),
      p25TimeToPromote: r1(t?.p25),
      p50TimeToPromote: r1(t?.p50),
      p75TimeToPromote: r1(t?.p75),
      samples: t?.samples || 0,
      censoredFallback: !!t?.censoredFallback,
      throughput90d: promos.filter((e) => (e.fromRoleId ?? e.from) === role.id && toMs(e.t) >= since(90)).length,
      dueNow: at.filter((m) => ['due', 'overdue', 'stalled'].includes(m.prediction?.status)).length,
    };
  });

  const growth = snapshots.map((s) => ({
    t: toMs(s.t),
    total: s.memberCount,
    tracked: s.tracked,
    roster: s.roster ?? s.tracked,
  }));

  const velocities = activeMetrics.map((m) => m.velocity).filter((v) => v > 0).sort((a, b) => a - b);

  writeJSON(path.join(OUT, 'overview.json'), {
    kpis: {
      members: group?.memberCount ?? active.length,
      tracked: active.length,
      roles: roles.length,
      promotions7d: countSince(promos, 7),
      promotions30d: countSince(promos, 30),
      promotionsTotal: promos.length,
      demotions30d: countSince(demos, 30),
      laterals30d: countSince(laterals, 30),
      joins30d: countSince(joins, 30),
      leaves30d: countSince(leaves, 30),
      netGrowth30d: countSince(joins, 30) - countSince(leaves, 30),
      medianVelocity: r2(percentile(velocities, 50)),
      avgDaysPerPromotion: r1(mean(activeMetrics.map((m) => m.avgDaysPerPromotion).filter(Boolean))),
      dueForPromotion: activeMetrics.filter((m) => ['due', 'overdue'].includes(m.prediction?.status)).length,
      stalled: activeMetrics.filter((m) => m.prediction?.status === 'stalled').length,
      promotionRate30d: active.length
        ? r2((countSince(promos, 30) / active.length) * 100)
        : 0,
    },
    growth,
    rankDistribution,
    churn: {
      joins: bucketByDay(joins, (e) => toMs(e.t)),
      leaves: bucketByDay(leaves, (e) => toMs(e.t)),
      promotions: bucketByDay(promos, (e) => toMs(e.t)),
      demotions: bucketByDay(demos, (e) => toMs(e.t)),
    },
    heatmap: activityHeatmap(events),
    transitions: transitionMatrix(events, roleIdx),
    retention: cohortRetention(members, now),
    accountAge: histogram(
      activeMetrics.map((m) => m.accountAgeDays),
      [
        { label: '< 1y', max: 365 },
        { label: '1-2y', max: 730 },
        { label: '2-4y', max: 1460 },
        { label: '4-7y', max: 2555 },
        { label: '7y+', max: Infinity },
      ]
    ),
    timeInRankDist: histogram(
      activeMetrics.map((m) => m.daysInRank),
      [
        { label: '< 1w', max: 7 },
        { label: '1-4w', max: 30 },
        { label: '1-3m', max: 90 },
        { label: '3-6m', max: 180 },
        { label: '6m+', max: Infinity },
      ]
    ),
    predictionMix: STATUSES.map((s) => ({
      status: s,
      count: activeMetrics.filter((m) => m.prediction?.status === s).length,
    })),
  });

  /* ---- leaderboards ------------------------------------------------------ */

  const N = site.leaderboardSize || 25;
  const slim = (m) => ({
    id: m.id, u: m.username, d: m.displayName, tier: m.tier, role: m.roleName,
    v: r2(m.velocity), p: m.promotions, dir: r1(m.daysInRank),
    adp: r1(m.avgDaysPerPromotion), td: r1(m.trackedDays),
    st: m.prediction?.status || null, rd: r1(m.prediction?.readiness),
    ld: r1(m.prediction?.likelyDays),
  });

  const eligible = activeMetrics.filter((m) => m.trackedDays >= 7);

  writeJSON(path.join(OUT, 'leaderboards.json'), {
    fastestRisers: [...eligible].filter((m) => m.velocity > 0)
      .sort((a, b) => b.velocity - a.velocity).slice(0, N).map(slim),
    mostPromotions: [...activeMetrics].filter((m) => m.promotions > 0)
      .sort((a, b) => b.promotions - a.promotions || a.trackedDays - b.trackedDays).slice(0, N).map(slim),
    quickestSinglePromotion: [...activeMetrics].filter((m) => m.fastestPromotionDays != null)
      .sort((a, b) => a.fastestPromotionDays - b.fastestPromotionDays).slice(0, N)
      .map((m) => ({ ...slim(m), fast: r1(m.fastestPromotionDays) })),
    longestTenured: [...activeMetrics].sort((a, b) => a.trackedSince - b.trackedSince).slice(0, N).map(slim),
    mostStalled: [...activeMetrics].filter((m) => m.prediction?.status === 'stalled')
      .sort((a, b) => b.daysInRank - a.daysInRank).slice(0, N).map(slim),
    dueNext: [...activeMetrics].filter((m) => m.prediction?.likelyDays != null && m.prediction.status !== 'top-rank')
      .sort((a, b) => a.prediction.likelyDays - b.prediction.likelyDays).slice(0, N).map(slim),
    highestRanked: [...activeMetrics].sort((a, b) => b.tier - a.tier || a.trackedSince - b.trackedSince).slice(0, N).map(slim),
    oldestAccounts: [...activeMetrics].filter((m) => m.accountCreated)
      .sort((a, b) => a.accountCreated - b.accountCreated).slice(0, N)
      .map((m) => ({ ...slim(m), acct: m.accountCreated })),
  });

  /* ---- events feed ------------------------------------------------------- */

  const limit = site.recentEventsLimit || 3000;
  const recent = events.slice(-limit).reverse().map((e) => ({
    t: toMs(e.t), type: e.type, id: e.id, u: e.u,
    from: e.from ?? null, to: e.to ?? null,
    fromName: e.fromName ?? roleIdx.nameOf(e.fromRoleId ?? e.from) ?? null,
    toName: e.toName ?? roleIdx.nameOf(e.roleId ?? e.to) ?? null,
    held: r1(e.heldDays),
  }));
  writeJSON(path.join(OUT, 'events.json'), { events: recent, total: events.length });

  /* ---- member index (columnar) ------------------------------------------ */

  const cols = [
    'id', 'u', 'd', 'tier', 'trackedSince', 'inRankSince', 'daysInRank',
    'promotions', 'demotions', 'velocity', 'avgDaysPerPromotion',
    'readiness', 'status', 'accountCreated', 'departed', 'boot', 'likelyDays', 'tiersClimbed',
  ];

  const rows = metrics.map((m) => [
    m.id,
    m.username,
    m.displayName === m.username ? 0 : m.displayName,
    m.tier,
    m.trackedSince,
    m.inRankSince,
    r1(m.daysInRank),
    m.promotions,
    m.demotions,
    r2(m.velocity),
    r1(m.avgDaysPerPromotion),
    r1(m.prediction?.readiness),
    m.prediction ? STATUSES.indexOf(m.prediction.status) : -1,
    m.accountCreated,
    m.departed,
    m.bootstrapped ? 1 : 0,
    r1(m.prediction?.likelyDays),
    m.tiersClimbed,
  ]);

  writeJSON(path.join(OUT, 'members.json'), {
    cols,
    statuses: STATUSES,
    generatedAt: now,
    count: rows.length,
    rows,
  });

  /* ---- member detail shards --------------------------------------------- */

  const shardCount = site.memberShards || 64;
  const shardDir = path.join(OUT, 'members');
  ensureDir(shardDir);
  // Overwrite in place rather than wiping the directory: a build that dies
  // halfway should leave a stale-but-serving site, not a half-empty one.

  const shards = Array.from({ length: shardCount }, () => ({}));
  for (const m of metrics) {
    shards[m.id % shardCount][m.id] = {
      u: m.username, d: m.displayName, tier: m.tier, role: m.roleName,
      trackedSince: m.trackedSince, lastSeen: m.lastSeen, inRankSince: m.inRankSince,
      accountCreated: m.accountCreated, departed: m.departed, boot: m.bootstrapped,
      promotions: m.promotions, demotions: m.demotions, tiersClimbed: m.tiersClimbed,
      velocity: r2(m.velocity),
      daysInRank: r1(m.daysInRank), trackedDays: r1(m.trackedDays),
      avgDaysPerPromotion: r1(m.avgDaysPerPromotion),
      fastestPromotionDays: r1(m.fastestPromotionDays),
      longestStallDays: r1(m.longestStallDays),
      recentPromotions: m.recentPromotions,
      nameChanges: m.nameChanges,
      prediction: m.prediction && {
        status: m.prediction.status,
        label: m.prediction.label,
        readiness: r1(m.prediction.readiness),
        served: r1(m.prediction.served),
        samples: m.prediction.samples ?? 0,
        cohortMedian: r1(m.prediction.cohortMedian),
        usedPersonalCadence: !!m.prediction.usedPersonalCadence,
        earliestDays: r1(m.prediction.earliestDays),
        likelyDays: r1(m.prediction.likelyDays),
        latestDays: r1(m.prediction.latestDays),
        earliestAt: m.prediction.earliestAt ?? null,
        likelyAt: m.prediction.likelyAt ?? null,
        latestAt: m.prediction.latestAt ?? null,
      },
      history: m.history.map((h) => [h.tier, h.start, h.end, r1(h.days), h.censored ? 1 : 0]),
    };
  }
  shards.forEach((s, i) => writeJSON(path.join(shardDir, `${i}.json`), s));

  // Drop shard files left over from a previous, larger shard count.
  for (const f of fs.readdirSync(shardDir)) {
    const n = Number(f.replace('.json', ''));
    if (Number.isInteger(n) && n >= shardCount) {
      try { fs.unlinkSync(path.join(shardDir, f)); } catch { /* best effort */ }
    }
  }

  /* ---- rank timing reference -------------------------------------------- */

  writeJSON(path.join(OUT, 'timing.json'), {
    ranks: roleIdx.roles.map((r, i) => {
      const t = timing[i] || {};
      return {
        tier: i, rank: r.rank, roleId: r.id, name: r.name, divider: !!r.divider,
        samples: t.samples || 0, censoredFallback: !!t.censoredFallback,
        p10: r1(t.p10), p25: r1(t.p25), p50: r1(t.p50), p75: r1(t.p75), p90: r1(t.p90),
        mean: r1(t.mean),
      };
    }),
  });

  const kb = (f) => (fs.statSync(path.join(OUT, f)).size / 1024).toFixed(0);
  console.log(
    awaitingRoster
      ? `Built site payloads: ${roleIdx.roles.length} real roles, awaiting the first roster snapshot.`
      : `Built site payloads: ${rows.length.toLocaleString()} members, ${events.length.toLocaleString()} events, ` +
        `${snapshots.length} snapshots. members.json=${kb('members.json')}KB overview.json=${kb('overview.json')}KB`
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
