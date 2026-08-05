/**
 * Headless UI test: loads the real dashboard against the real generated payloads.
 * Guards specifically against invented rank names reappearing in the pyramid.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';

// fileURLToPath, not URL.pathname: on Windows the latter yields "/C:/..."
// and path.resolve turns that into "C:\\C:\\...".
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = path.join(ROOT, 'docs');
const errors = [];

const vc = new VirtualConsole();
vc.on('jsdomError', (e) => errors.push('jsdomError: ' + (e.detail?.stack || e.message)));
vc.on('error', (...a) => errors.push('console.error: ' + a.join(' ')));

const html = fs.readFileSync(path.join(DOCS, 'index.html'), 'utf8')
  .replace(/<script src="https:\/\/cdn[^"]*"><\/script>/, '');

const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc, url: 'http://localhost/' });
const { window } = dom;

const charts = [];
class FakeChart { constructor(_, cfg) { charts.push(cfg); } destroy() {} }
FakeChart.defaults = { color: '', font: {}, borderColor: '', animation: {}, plugins: { legend: {}, tooltip: {} } };
window.Chart = FakeChart;
window.HTMLCanvasElement.prototype.getContext = () => ({ createLinearGradient: () => ({ addColorStop() {} }) });
window.fetch = async (p) => {
  const file = path.join(DOCS, String(p).replace(/^\//, ''));
  if (!fs.existsSync(file)) return { ok: false, status: 404, json: async () => ({}) };
  return { ok: true, status: 200, json: async () => JSON.parse(fs.readFileSync(file, 'utf8')) };
};

for (const f of ['assets/js/charts.js', 'assets/js/app.js']) {
  try { window.eval(fs.readFileSync(path.join(DOCS, f), 'utf8')); }
  catch (e) { errors.push(`${f}: ${e.stack}`); }
}
await new Promise((r) => setTimeout(r, 800));

const d = window.document;
const q = (s) => d.querySelector(s);
const all = (s) => [...d.querySelectorAll(s)];
const text = (s) => all(s).map((n) => n.textContent.trim());

const REAL = [
  'Security Intern', 'Security Cadet', 'Security Agent', 'Security Guard',
  'Security Sentry', 'Security Specialist', 'Security Corporal', 'Security Officer',
  'Security Lieutenant', 'Chief of Security', '--------------------',
  'O5 Council', 'Overseer', 'Chairman of the Council', 'The Administrator',
];
const INVENTED = [
  'Senior Officer', 'Sergeant', 'Staff Sergeant', 'Captain', 'Major',
  'Colonel', 'Security Command', 'Deputy Director', 'Director of Security',
];

const pyramid = text('#pyramid .pyr-name');
const body = d.body.textContent;

const checks = [
  ['dashboard renders',              () => q('#main').hidden === false],
  ['awaiting-roster banner shown',   () => !q('#awaiting-banner').classList.contains('hidden')],
  ['no demo banner exists',          () => q('#demo-banner') === null],
  ['pyramid has all 15 real roles',  () => REAL.every((n) => pyramid.includes(n)) || `missing: ${REAL.filter(n => !pyramid.includes(n))}`],
  ['pyramid has exactly 15 rows',    () => pyramid.length === 15 || `got ${pyramid.length}: ${pyramid}`],
  ['pyramid is top-down',            () => pyramid[0] === 'The Administrator' && pyramid[14] === 'Security Intern'],
  ['phantom base role hidden',       () => !pyramid.includes('Member')],
  ['NO invented rank names anywhere',() => { const f = INVENTED.filter((n) => body.includes(n)); return f.length === 0 || `found: ${f}`; }],
  ['divider rendered as a rule',     () => all('.pyr-row.is-divider').length === 1],
  ['real member count in KPIs',      () => q('#kpis').textContent.includes('583')],
  ['rank filter lists real roles',   () => all('#filter-rank option').length === 16 || `got ${all('#filter-rank option').length}`],
  ['rank cards exclude divider',     () => all('.rank-card').length === 14],
  ['rank card names are real',       () => text('.rc-head h3').every((n) => REAL.includes(n))],
  ['roster shows empty state',       () => q('#roster-count').textContent.includes('0 of 0')],
  ['feed explains the empty state',  () => q('#recent-feed').textContent.includes('No membership changes')],
  ['group name in header',           () => q('#site-title').textContent.length > 3],
  ['charts still construct',         () => charts.length >= 2],
];

let pass = 0;
for (const [name, fn] of checks) {
  let r; try { r = fn(); } catch (e) { r = e.message; }
  const ok = r === true;
  if (ok) pass++;
  console.log(`${ok ? ' PASS' : ' FAIL'}  ${name}${ok ? '' : '  -> ' + r}`);
}
console.log(`\n${pass}/${checks.length} UI checks passed`);
console.log('\nPyramid as rendered:');
pyramid.forEach((n, i) => console.log(`  ${String(i + 1).padStart(2)}. ${n}`));
if (errors.length) { console.log('\nRUNTIME ERRORS:'); errors.forEach((e) => console.log('  ' + e)); }
if (pass !== checks.length || errors.length) process.exitCode = 1;
