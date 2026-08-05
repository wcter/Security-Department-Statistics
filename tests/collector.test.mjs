/**
 * End-to-end collector regression tests.
 *
 * Fixtures use the real shapes returned by groups.roblox.com for group 4606666,
 * including the two properties that broke earlier versions:
 *   - "Member" (isBase) enumerates the ENTIRE membership, owner included
 *   - "Member" and "Security Intern" both sit at rank 1
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

// fileURLToPath, not URL.pathname: on Windows the latter yields "/C:/..."
// and path.resolve turns that into "C:\\C:\\...".
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROLES = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'roles.json'), 'utf8'));

const R = Object.fromEntries(ROLES.map((r) => [r.name, r.id]));

const U = {
  admin:   { userId: 234810404,  username: 'Toximay',       displayName: 'Toximay' },
  chief:   { userId: 603965374,  username: 'TheBestM1211',  displayName: 'TheBestM1211' },
  lt:      { userId: 24091263,   username: 'Uncle_Ferry',   displayName: 'Ferry' },
  officer: { userId: 363174094,  username: 'TheSky5000',    displayName: 'Skies' },
  cadet:   { userId: 2677272277, username: 'Maelstrom_Z',   displayName: 'MaelstromZ' },
  intern:  { userId: 1773524960, username: 'ahmu2305',      displayName: '00ahmu2305' },
  agent:   { userId: 2242131897, username: 'Its_Glitch669', displayName: 'Glitch' },
};

/** roster: Map<roleId, user[]>. The base role always returns everyone. */
function installFetch(roster) {
  const everyone = [...new Set(Object.values(roster).flat())];

  globalThis.fetch = async (url) => {
    const u = String(url);
    const json = (body) => ({ ok: true, status: 200, headers: new Map(), json: async () => body });

    if (/\/groups\/4606666$/.test(u)) {
      return json({ id: 4606666, name: '[SCPF - Security Department]', memberCount: everyone.length, owner: U.admin, shout: null });
    }
    if (/\/groups\/4606666\/roles$/.test(u)) return json({ roles: ROLES });

    const m = u.match(/\/roles\/(\d+)\/users/);
    if (m) {
      const roleId = Number(m[1]);
      const isBase = ROLES.find((r) => r.id === roleId)?.isBase;
      const data = isBase ? everyone : (roster[roleId] || []);
      return json({ data, nextPageCursor: null, previousPageCursor: null });
    }
    if (/users\.roblox\.com\/v1\/users$/.test(u)) {
      return json({ data: everyone.map((x) => ({ id: x.userId, created: '2019-01-01T00:00:00Z' })) });
    }
    throw new Error('unexpected url ' + u);
  };
}

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rgs-test-'));
process.env.RGS_DATA_DIR = DIR;

const read = (f) => {
  const file = path.join(DIR, f);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
};
const members = () => new Map(read('members.ndjson').map((m) => [m.id, m]));
const events = () => read('events.ndjson');

const { run } = await import('../scripts/collect.mjs');

const results = [];
const check = (name, fn) => {
  try { fn(); results.push([true, name]); }
  catch (e) { results.push([false, `${name}\n      ${e.message.split('\n')[0]}`]); }
};

/* -------------------------------------------------- run 1: bootstrap ---- */

let roster = {
  [R['The Administrator']]: [U.admin],
  [R['Chief of Security']]: [U.chief],
  [R['Security Lieutenant']]: [U.lt],
  [R['Security Officer']]: [U.officer],
  [R['Security Cadet']]: [U.cadet],
  [R['Security Intern']]: [U.intern],
  [R['Security Agent']]: [U.agent],
};
installFetch(roster);
await run();

let M = members();

check('bootstrap indexes every member', () => assert.equal(M.size, 7));
check('base role does NOT clobber the owner\'s rank', () => {
  assert.equal(M.get(U.admin.userId).ri, R['The Administrator']);
  assert.notEqual(M.get(U.admin.userId).ri, R['Member']);
});
check('nobody is left holding the phantom base role', () => {
  assert.equal([...M.values()].filter((m) => m.ri === R['Member']).length, 0);
});
check('history stores roleId, not rank', () => {
  assert.equal(M.get(U.intern.userId).h[0][1], R['Security Intern']);
});
check('bootstrap members are flagged, not treated as joins', () => {
  assert.ok([...M.values()].every((m) => m.boot === true));
  assert.equal(events().length, 0);
});

/* ------------------------------- run 2: promote / demote / lateral ------ */

// Intern -> Member models a role change with NO rank change (both are rank 1).
// The user appears only in the base-role pass, which is exactly what Roblox
// returns for someone holding no specific role.
roster = {
  [R['The Administrator']]: [U.admin],
  [R['Chief of Security']]: [U.chief],
  [R['Security Officer']]: [U.lt],           // demoted: Lieutenant(170) -> Officer(150)
  [R['Security Corporal']]: [U.officer],     // demoted: Officer(150) -> Corporal(100)
  [R['Security Agent']]: [U.cadet, U.agent], // promoted: Cadet(20) -> Agent(30)
  [R['Member']]: [U.intern],                 // lateral:  Intern(1) -> Member(1)
};
installFetch(roster);
await run();

M = members();
let E = events();
const evOf = (id) => E.filter((e) => e.id === id);

check('promotion detected', () => {
  const e = evOf(U.cadet.userId).find((x) => x.type === 'promote');
  assert.ok(e, 'no promote event');
  assert.equal(e.toName, 'Security Agent');
  assert.ok(e.heldDays >= 0);
});
check('demotion detected', () => {
  assert.ok(evOf(U.lt.userId).some((x) => x.type === 'demote'));
  assert.ok(evOf(U.officer.userId).some((x) => x.type === 'demote'));
});
check('LATERAL move at equal rank is detected (Intern -> Member, both rank 1)', () => {
  const e = evOf(U.intern.userId).find((x) => x.type === 'lateral');
  assert.ok(e, 'rank-1 role change was invisible');
  assert.equal(e.from, e.to);
  assert.equal(e.fromName, 'Security Intern');
  assert.equal(e.toName, 'Member');
});
check('lateral move is not counted as a promotion', () => {
  assert.equal(evOf(U.intern.userId).filter((x) => x.type === 'promote').length, 0);
});
check('unchanged members emit no events', () => assert.equal(evOf(U.admin.userId).length, 0));
check('nobody has left yet', () => assert.equal(E.filter((e) => e.type === 'leave').length, 0));

/* --------------------------- run 3: first miss (grace period holds) ----- */

roster[R['Security Agent']] = [U.cadet]; // agent disappears
installFetch(roster);
await run();

check('grace period: a single miss does NOT record a departure', () => {
  assert.equal(events().filter((e) => e.type === 'leave').length, 0);
  assert.equal(members().get(U.agent.userId).miss, 1);
  assert.equal(members().get(U.agent.userId).left, null);
});

/* --------------------------- run 4: second miss -> departure ----------- */

installFetch(roster);
await run();

E = events();
check('departure recorded after two consecutive misses', () => {
  const e = E.find((x) => x.type === 'leave' && x.id === U.agent.userId);
  assert.ok(e, 'no leave event after two consecutive misses');
  assert.equal(e.fromName, 'Security Agent');
});
check('departed member retained with a left timestamp', () => {
  assert.ok(members().get(U.agent.userId).left);
});
check('departure does not remove them from the index', () => {
  assert.equal(members().size, 7);
});

/* ------------------------------------------------- run 5: safety rails -- */

const before = fs.readFileSync(path.join(DIR, 'members.ndjson'), 'utf8');
globalThis.fetch = async (url) => {
  const u = String(url);
  const json = (b) => ({ ok: true, status: 200, headers: new Map(), json: async () => b });
  if (/\/groups\/4606666$/.test(u)) return json({ id: 4606666, name: 'x', memberCount: 0, owner: null });
  if (/\/groups\/4606666\/roles$/.test(u)) return json({ roles: ROLES });
  return json({ data: [], nextPageCursor: null });
};
await run().catch(() => {});
check('empty roster never overwrites saved state', () => {
  assert.equal(fs.readFileSync(path.join(DIR, 'members.ndjson'), 'utf8'), before);
});

/* ----------------------------------------------------------- report ---- */

let pass = 0;
for (const [ok, name] of results) {
  console.log(`${ok ? ' PASS' : ' FAIL'}  ${name}`);
  if (ok) pass++;
}
console.log(`\n${pass}/${results.length} collector checks passed`);
fs.rmSync(DIR, { recursive: true, force: true });
if (pass !== results.length) process.exitCode = 1;
