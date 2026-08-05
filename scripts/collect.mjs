#!/usr/bin/env node
/**
 * Snapshot the group roster and diff it against stored state.
 *
 * Every run produces:
 *   data/members.ndjson   canonical per-member state + rank history  (rewritten, sorted)
 *   data/events.ndjson    append-only log of joins/promotions/demotions/leaves/renames
 *   data/snapshots.ndjson one row per run: totals and per-role headcount
 *   data/roles.json       latest role definitions
 */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { RobloxClient, pool } from './lib/roblox.mjs';
import {
  readJSON, writeJSON, loadNDJSON, writeNDJSON, appendNDJSON, ensureDir, Logger,
} from './lib/store.mjs';
import { buildRoleIndex } from './lib/stats.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// RGS_DATA_DIR lets tests point the collector at a scratch directory.
const DATA = process.env.RGS_DATA_DIR || path.join(ROOT, 'data');
const F = {
  members: path.join(DATA, 'members.ndjson'),
  events: path.join(DATA, 'events.ndjson'),
  snapshots: path.join(DATA, 'snapshots.ndjson'),
  roles: path.join(DATA, 'roles.json'),
  group: path.join(DATA, 'group.json'),
  log: path.join(DATA, 'collect.log'),
};

const cfg = readJSON(path.join(ROOT, 'config.json'));
if (!cfg?.groupId) throw new Error('config.json is missing groupId');

const log = new Logger(F.log);
const now = Date.now();
const nowISO = new Date(now).toISOString();

async function main() {
  ensureDir(DATA);
  log.log(`Collecting group ${cfg.groupId}`);

  const client = new RobloxClient(cfg.collection);

  /* ---- 1. group + roles ------------------------------------------------ */

  const group = await client.getGroup(cfg.groupId);
  if (!group) throw new Error(`Group ${cfg.groupId} not found (404)`);

  const roles = await client.getRoles(cfg.groupId);
  if (!roles.length) throw new Error('Group returned no roles');

  log.log(`"${group.name}" — ${group.memberCount.toLocaleString()} members across ${roles.length} roles`);

  /* ---- 2. full roster --------------------------------------------------- */

  const minRank = cfg.tracking?.minTrackedRank ?? 0;
  const watchlist = new Set((cfg.tracking?.watchlist || []).map((s) => String(s).toLowerCase()));
  const roleIdx = buildRoleIndex(roles);

  // Rank 0 is Roblox's Guest pseudo-role. It never contains members.
  let targetRoles = roles.filter((r) => r.rank > 0);
  if (!cfg.tracking?.trackAllMembers) targetRoles = targetRoles.filter((r) => r.rank >= minRank);

  // The auto-generated base role ("Member", isBase) does NOT hold only unassigned
  // members — it enumerates the ENTIRE membership, group owner included. Fetched
  // alongside the real roles it would overwrite everyone's true rank with "Member".
  // So base roles are fetched first, alone, and every specific role fetched
  // afterwards overwrites them. Whoever remains genuinely holds no other role.
  const baseRoles = targetRoles.filter((r) => r.isBase);
  const specificRoles = targetRoles.filter((r) => !r.isBase);

  const current = new Map(); // userId -> { u, d, rank, roleId }
  const failures = [];
  let fetched = 0;

  const fetchRole = async (role) => {
    try {
      const { pages, total } = await client.eachRoleMember(
        cfg.groupId,
        role.id,
        async (users) => {
          for (const entry of users) {
            current.set(entry.userId, {
              u: entry.username,
              d: entry.displayName || entry.username,
              rank: role.rank,
              roleId: role.id,
            });
          }
          fetched += users.length;
        },
        { pageSize: cfg.collection?.pageSize ?? 100 }
      );
      log.log(`  ${role.name} (rank ${role.rank}): ${total} members over ${pages} pages`);
    } catch (err) {
      failures.push({ role: role.name, roleId: role.id, error: String(err.message) });
      log.log(`  !! ${role.name} failed: ${err.message}`);
    }
  };

  if (baseRoles.length) {
    log.log('  base-role pass (superseded by specific roles):');
    for (const role of baseRoles) await fetchRole(role);
  }

  // Specific roles in parallel; pages within a role stay sequential because the
  // cursor is inherently serial.
  await pool(specificRoles, cfg.collection?.roleConcurrency ?? 4, fetchRole);

  // A partial roster must never be read as "everyone left". This is the single
  // most destructive failure mode for a diff-based tracker.
  const rosterComplete = failures.length === 0;
  if (!rosterComplete) {
    log.log(`WARNING: ${failures.length} role(s) failed - departure detection disabled this run.`);
  }

  const leftoverBase = [...current.values()].filter((v) => roleIdx.resolve(v.roleId)?.base).length;
  log.log(`Roster: ${current.size.toLocaleString()} unique members (${fetched.toLocaleString()} rows fetched)`);
  if (leftoverBase) log.log(`  ${leftoverBase} member(s) hold no specific role.`);

  if (current.size === 0) throw new Error('Fetched an empty roster; refusing to overwrite state.');

  /* ---- 3. load prior state --------------------------------------------- */

  const prior = await loadNDJSON(F.members);
  const state = new Map(prior.map((m) => [m.id, m]));
  const isBootstrap = state.size === 0;

  if (isBootstrap) {
    log.log('First run — bootstrapping. Existing members get a "tracked since" date, not a join date.');
  }

  /* ---- 4. diff ---------------------------------------------------------- */

  const events = [];
  const newUserIds = [];
  const grace = cfg.tracking?.leaveGracePeriod ?? 2;

  for (const [id, live] of current) {
    const rec = state.get(id);

    if (!rec) {
      const fresh = {
        id,
        u: live.u,
        d: live.d,
        r: live.rank,
        ri: live.roleId,
        fs: nowISO,
        ls: nowISO,
        since: nowISO,
        boot: isBootstrap,
        // History stores roleId, not rank: rank is not unique across roles.
        h: [[nowISO, live.roleId]],
        miss: 0,
        left: null,
      };
      if (watchlist.has(String(live.u).toLowerCase())) fresh.watch = true;
      state.set(id, fresh);
      newUserIds.push(id);
      if (!isBootstrap) {
        events.push({ t: nowISO, type: 'join', id, u: live.u, to: live.rank, roleId: live.roleId, toName: roleIdx.nameOf(live.roleId) });
      }
      continue;
    }

    rec.ls = nowISO;
    rec.miss = 0;

    if (rec.left) {
      events.push({ t: nowISO, type: 'rejoin', id, u: live.u, to: live.rank, roleId: live.roleId, toName: roleIdx.nameOf(live.roleId) });
      rec.left = null;
      // Treat the return as a new spell so time-in-rank isn't measured across the gap.
      rec.since = nowISO;
      rec.h.push([nowISO, live.roleId]);
    }

    if (rec.u !== live.u) {
      (rec.names ||= []).push([nowISO, rec.u]);
      events.push({ t: nowISO, type: 'rename', id, u: live.u, from: rec.u });
      rec.u = live.u;
    }
    if (rec.d !== live.d) rec.d = live.d;

    // Compare roleId, not rank: "Member" and "Security Intern" are both rank 1,
    // so a move between them is invisible to a rank comparison.
    if (rec.ri !== live.roleId) {
      const type = live.rank > rec.r ? 'promote' : live.rank < rec.r ? 'demote' : 'lateral';
      events.push({
        t: nowISO, type, id, u: live.u,
        from: rec.r, to: live.rank,
        fromRoleId: rec.ri, roleId: live.roleId,
        fromName: roleIdx.nameOf(rec.ri), toName: roleIdx.nameOf(live.roleId),
        // Days served in the role they just left — the headline promotion-window datum.
        heldDays: +((now - Date.parse(rec.since || rec.fs)) / 86400000).toFixed(3),
      });
      rec.r = live.rank;
      rec.ri = live.roleId;
      rec.since = nowISO;
      rec.h.push([nowISO, live.roleId]);
    }
  }

  let departures = 0;
  if (rosterComplete) {
    for (const [id, rec] of state) {
      if (current.has(id) || rec.left) continue;
      rec.miss = (rec.miss || 0) + 1;
      // Paginating a live roster can transiently drop a member; require the miss
      // to repeat before recording a departure.
      if (rec.miss >= grace) {
        rec.left = nowISO;
        departures++;
        events.push({ t: nowISO, type: 'leave', id, u: rec.u, from: rec.r, fromRoleId: rec.ri, fromName: roleIdx.nameOf(rec.ri) });
      }
    }
  }

  /* ---- 5. account details for newcomers (cached forever) ---------------- */

  if (cfg.tracking?.fetchAccountDetails && newUserIds.length) {
    log.log(`Fetching account details for ${newUserIds.length.toLocaleString()} new member(s)...`);
    try {
      const details = await client.getUserDetails(newUserIds);
      for (const [id, u] of details) {
        const rec = state.get(id);
        if (rec && u.created) rec.created = u.created;
      }
    } catch (err) {
      // Nice-to-have data; never worth failing a run over.
      log.log(`  account detail fetch failed (non-fatal): ${err.message}`);
    }
  }

  /* ---- 6. persist -------------------------------------------------------- */

  const byRole = {};
  for (const role of roles) byRole[role.id] = 0;
  for (const v of current.values()) byRole[v.roleId] = (byRole[v.roleId] || 0) + 1;

  const snapshot = {
    t: nowISO,
    memberCount: group.memberCount,
    tracked: current.size,
    roster: [...state.values()].filter((m) => !m.left).length,
    byRole,
    complete: rosterComplete,
    events: events.length,
  };

  writeNDJSON(F.members, [...state.values()], { sortKey: 'id' });
  appendNDJSON(F.events, events);
  appendNDJSON(F.snapshots, [snapshot]);
  writeJSON(F.roles, roles, { pretty: true });
  writeJSON(F.group, {
    id: group.id,
    name: group.name,
    description: group.description,
    memberCount: group.memberCount,
    owner: group.owner || null,
    shout: group.shout || null,
    url: cfg.groupUrl || `https://www.roblox.com/groups/${group.id}`,
    capturedAt: nowISO,
  }, { pretty: true });

  const tally = events.reduce((acc, e) => ((acc[e.type] = (acc[e.type] || 0) + 1), acc), {});
  log.log(
    `Done. state=${state.size.toLocaleString()} events=${events.length} ` +
    `(${Object.entries(tally).map(([k, v]) => `${k}:${v}`).join(' ') || 'none'}) ` +
    `departures=${departures} requests=${client.stats.requests} ` +
    `retries=${client.stats.retries} rate-limited=${client.stats.rateLimited}`
  );
}

export async function run() {
  try {
    await main();
  } catch (err) {
    log.log(`FATAL: ${err.stack || err.message}`);
    process.exitCode = 1;
    throw err;
  } finally {
    log.flush();
  }
}

// Only self-execute when run directly, so tests can import and drive it.
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) run().catch(() => {});
