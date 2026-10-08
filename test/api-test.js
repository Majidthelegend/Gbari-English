'use strict';
// End-to-end API test. Runs the real server against a throw-away data folder.
const fs = require('fs'), os = require('os'), path = require('path'), { execFileSync } = require('child_process');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gv-test-'));
process.env.ADMIN_EMAILS = 'admin@example.com';
const CFG = require('../config');
CFG.REVIEWER_MIN_APPROVED = 2;          // keep the test short
CFG.MAX_APPROVED_PER_PROMPT = 2;        // exercise the "phrase is full" rule
const server = require('../server');
let base, pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  FAIL:', m); } };

class Client {
  constructor() { this.cookie = ''; }
  async call(method, url, { json, raw, type } = {}) {
    const headers = { 'X-Requested-With': 'gv' };
    if (this.cookie) headers.Cookie = this.cookie;
    let body;
    if (json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
    if (raw) { headers['Content-Type'] = type; body = raw; }
    const r = await fetch(base + url, { method, headers, body });
    const sc = r.headers.get('set-cookie'); if (sc) this.cookie = sc.split(';')[0];
    const buf = Buffer.from(await r.arrayBuffer());
    let data = null; try { data = JSON.parse(buf.toString()); } catch { /* binary */ }
    return { status: r.status, data, buf, headers: r.headers };
  }
}
async function signup(name, email, native = true) {
  const c = new Client();
  const r = await c.call('POST', '/api/signup', { json: { display_name: name, email, password: 'password123', native_speaker: native } });
  if (r.status !== 200) throw new Error('signup failed ' + JSON.stringify(r.data));
  const k = await c.call('POST', '/api/consent', { json: { agree: true } });
  ok(k.data.consent_ok, 'consent saved');
  return c;
}
const tmp = path.join(process.env.DATA_DIR, 'clip.webm');
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:a', 'libopus', tmp]);
const clip = fs.readFileSync(tmp);

(async () => {
  await new Promise((r) => server.listen(0, r));
  base = 'http://127.0.0.1:' + server.address().port;

  // --- auth & consent gate
  const anon = new Client();
  ok((await anon.call('GET', '/api/prompts')).status === 401, 'anonymous blocked');
  const a = new Client();
  ok((await a.call('POST', '/api/signup', { json: { display_name: 'Ada', email: 'ada@example.com', password: 'password123', native_speaker: true } })).status === 200, 'signup');
  ok((await a.call('GET', '/api/prompts')).data.code === 'consent', 'consent required before contributing');
  ok((await a.call('POST', '/api/consent', { json: { agree: false } })).status === 400, 'must agree');
  await a.call('POST', '/api/consent', { json: { agree: true } });
  ok((await a.call('POST', '/api/signup', { json: { display_name: 'ada', email: 'x@example.com', password: 'password123' } })).status === 409, 'display names are unique (case-insensitive)');
  ok((await new Client().call('POST', '/api/login', { json: { email: 'ada@example.com', password: 'wrongpass' } })).status === 401, 'bad login');
  ok((await new Client().call('POST', '/api/entries', { json: {} })).status === 401, 'unauthenticated write blocked');
  const noHdr = await fetch(base + '/api/logout', { method: 'POST' });
  ok(noHdr.status === 403, 'CSRF header required');

  // --- prompts + search
  const list = await a.call('GET', '/api/prompts?q=mother');
  ok(list.data.length >= 1 && list.data[0].english.toLowerCase().includes('mother'), 'prompt search');
  ok((await a.call('GET', '/api/categories')).data.length >= 8, 'categories');
  const p1 = list.data[0];
  ok(p1.approved === 0 && !p1.full, 'new prompt has 0 approved');

  // --- contribute: text + audio
  const e1 = await a.call('POST', '/api/entries', { json: { prompt_id: p1.id, gbari: 'Ɛ̀nɔ̀ ná', gloss: 'mother my', dialect: CFG.DIALECTS[0], village: 'Paiko' } });
  ok(e1.status === 201, 'create entry ' + JSON.stringify(e1.data));
  ok((await a.call('POST', '/api/entries', { json: { prompt_id: p1.id, gbari: 'x', gloss: 'y', dialect: CFG.DIALECTS[0] } })).data.code === 'mine', 'one translation per phrase per person');
  ok((await a.call('POST', '/api/entries', { json: { prompt_id: 999999, gbari: 'x', gloss: 'y', dialect: 'Not sure' } })).status === 404, 'unknown prompt');
  ok((await a.call('POST', '/api/entries', { json: { prompt_id: p1.id + 1, gbari: 'x', gloss: '', dialect: 'Not sure' } })).status === 400, 'gloss required');
  const bad = await a.call('PUT', `/api/entries/${e1.data.id}/audio`, { raw: Buffer.from('this is not audio at all, just text'), type: 'audio/webm' });
  ok(bad.status === 400, 'fake audio rejected: ' + bad.status);
  const png = await a.call('PUT', `/api/entries/${e1.data.id}/audio`, { raw: Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), type: 'image/png' });
  ok(png.status === 400, 'non-audio content-type rejected');
  const up = await a.call('PUT', `/api/entries/${e1.data.id}/audio`, { raw: clip, type: 'audio/webm;codecs=opus' });
  ok(up.status === 200 && up.data.ms > 1500, 'audio stored, ms=' + (up.data && up.data.ms));
  const files = fs.readdirSync(path.join(process.env.DATA_DIR, 'audio'));
  ok(files.some((f) => f.startsWith('greetings_') || f.startsWith('family_')) && files.every((f) => /^[a-z-]+_\d+_\d+\.webm$/.test(f)), 'audio file naming category_promptID_contributorID: ' + files.join(','));
  const au = await a.call('GET', `/api/audio/${e1.data.id}`);
  ok(au.status === 200 && au.buf.length > 500, 'owner can fetch audio');
  const rng = await fetch(`${base}/api/audio/${e1.data.id}`, { headers: { Cookie: a.cookie, Range: 'bytes=0-99' } });
  ok(rng.status === 206 && (await rng.arrayBuffer()).byteLength === 100, 'range requests work');

  // --- review rules
  const rev0 = await a.call('GET', '/api/review/next');
  ok(rev0.status === 403 && rev0.data.code === 'not_eligible', 'new contributor cannot review');
  const admin = await signup('Chief', 'admin@example.com', false);
  ok((await admin.call('GET', '/api/me')).data.role === 'admin', 'admin by ADMIN_EMAILS');
  ok((await a.call('GET', '/api/admin/stats')).status === 403, 'non-admin blocked from admin');
  ok((await a.call('POST', '/api/review', { json: { entry_id: e1.data.id, verdict: 'correct' } })).status === 403, 'cannot review (not eligible)');
  const q = await admin.call('GET', '/api/review/next');
  ok(q.data.entry && q.data.entry.id === e1.data.id && q.data.remaining === 1, 'reviewer sees entry');
  ok((await admin.call('GET', `/api/audio/${e1.data.id}`)).status === 200, 'reviewer can hear pending audio');
  const stranger = await signup('Bola', 'bola@example.com');
  ok((await stranger.call('GET', `/api/audio/${e1.data.id}`)).status === 403, 'strangers cannot hear pending audio');
  const fixr = await admin.call('POST', '/api/review', { json: { entry_id: e1.data.id, verdict: 'needs_fix' } });
  ok(fixr.status === 400, 'needs_fix requires a note');
  const nf = await admin.call('POST', '/api/review', { json: { entry_id: e1.data.id, verdict: 'needs_fix', fix_text: 'Ɛ̀nɔ̀ ná!', note: 'missing mark' } });
  ok(nf.data.status === 'needs_fix', 'needs fix');
  const mine = await a.call('GET', '/api/my/entries');
  ok(mine.data[0].status === 'needs_fix' && mine.data[0].review.fix_text === 'Ɛ̀nɔ̀ ná!', 'contributor sees reviewer suggestion');
  ok((await a.call('PATCH', `/api/entries/${e1.data.id}`, { json: { gbari: 'Ɛ̀nɔ̀ ná!', gloss: 'mother my', dialect: CFG.DIALECTS[0] } })).status === 200, 'resubmit');
  ok((await admin.call('POST', '/api/review', { json: { entry_id: e1.data.id, verdict: 'correct' } })).data.status === 'validated', 'validated by someone else');
  ok((await admin.call('POST', '/api/review', { json: { entry_id: e1.data.id, verdict: 'correct' } })).status === 409, 'cannot re-review closed entry');

  // --- phrase counter + cap (cap=2 in this test)
  const pr = (await a.call('GET', `/api/prompts/${p1.id}`)).data;
  ok(pr.approved === 1 && !pr.full, 'approved counter = 1');
  const b = stranger;
  const eb = await b.call('POST', '/api/entries', { json: { prompt_id: p1.id, gbari: 'Ɛ̀nɔ̀', gloss: 'mother', dialect: 'Not sure' } });
  await admin.call('POST', '/api/review', { json: { entry_id: eb.data.id, verdict: 'correct' } });
  const pr2 = (await a.call('GET', `/api/prompts/${p1.id}`)).data;
  ok(pr2.approved === 2 && pr2.full, 'phrase now full');
  const c3 = await signup('Chidi', 'chidi@example.com');
  const full = await c3.call('POST', '/api/entries', { json: { prompt_id: p1.id, gbari: 'z', gloss: 'z', dialect: 'Not sure' } });
  ok(full.status === 409 && full.data.code === 'full', 'full phrase refuses new entries');
  const nxt = await c3.call('GET', `/api/prompts/next?category=${encodeURIComponent(p1.category)}`);
  ok(nxt.data && nxt.data.id !== p1.id, 'skip gives another phrase');
  const listFull = (await c3.call('GET', '/api/prompts?q=' + encodeURIComponent(p1.english))).data;
  ok(listFull.find((x) => x.id === p1.id).full, 'dropdown flags full phrases');

  // --- reviewer promotion by criteria (min approved = 2, native)
  const ar = (await a.call('GET', '/api/me')).data.reviewer;
  ok(ar.approved === 1 && !ar.eligible, 'Ada not yet eligible');
  const ebb = await a.call('POST', '/api/entries', { json: { prompt_id: p1.id + 1, gbari: 'n', gloss: 'n', dialect: 'Not sure' } });
  await admin.call('POST', '/api/review', { json: { entry_id: ebb.data.id, verdict: 'correct' } });
  ok((await a.call('GET', '/api/me')).data.reviewer.eligible, 'Ada becomes reviewer after 2 approved + native speaker');
  ok((await b.call('GET', '/api/me')).data.reviewer.approved === 1, 'Bola has 1 approved');
  // self-review prevented
  const ec = await c3.call('POST', '/api/entries', { json: { prompt_id: p1.id + 2, gbari: 'q', gloss: 'q', dialect: 'Not sure' } });
  ok((await c3.call('POST', '/api/review', { json: { entry_id: ec.data.id, verdict: 'correct' } })).status === 403, 'not eligible');
  await a.call('PATCH', '/api/me', { json: { native_speaker: true } });
  const ownRev = await a.call('POST', '/api/review', { json: { entry_id: ebb.data.id, verdict: 'correct' } });
  ok(ownRev.status === 403 || ownRev.status === 409, 'cannot review own entry');
  const rj = await a.call('POST', '/api/review', { json: { entry_id: ec.data.id, verdict: 'reject' } });
  ok(rj.status === 400, 'reject needs a reason');
  ok((await a.call('POST', '/api/review', { json: { entry_id: ec.data.id, verdict: 'reject', note: 'Not Gbari' } })).data.status === 'rejected', 'eligible reviewer rejects');

  // --- read-aloud mode
  const rd = await c3.call('GET', '/api/read/next');
  ok(rd.data && rd.data.gbari, 'read-aloud offers validated text');
  const rec = await c3.call('POST', '/api/entries/read', { json: { source_entry_id: rd.data.id, dialect: 'Not sure' } });
  ok(rec.status === 201, 'create recording entry');
  ok((await c3.call('PUT', `/api/entries/${rec.data.id}/audio`, { raw: clip, type: 'audio/webm' })).status === 200, 'upload recording');
  ok((await admin.call('GET', '/api/review/next')).data.entry.kind === 'recording', 'recordings appear in review queue');
  const rv = await admin.call('POST', '/api/review', { json: { entry_id: rec.data.id, verdict: 'correct' } });
  ok(rv.data.status === 'validated', 'recording validated');

  // --- browse (tone-insensitive)
  const br = await a.call('GET', '/api/browse?q=eno&dir=gb2en');
  ok(br.data.items.length >= 1 && br.data.items.some((i) => i.audio_id), 'browse Gbari→English ignoring tone marks');
  const br2 = await a.call('GET', '/api/browse?q=mother&dir=en2gb');
  ok(br2.data.items.length >= 1, 'browse English→Gbari');
  ok(!JSON.stringify(br.data).includes('@'), 'no emails in browse');

  // --- profile, leaderboard
  const pf = (await a.call('GET', '/api/profile')).data;
  ok(pf.validated === 2 && pf.streak >= 1 && pf.badges.find((x) => x.id === 'first').got, 'profile stats and badges');
  const lb = (await a.call('GET', '/api/leaderboard')).data;
  ok(lb.length >= 1 && !JSON.stringify(lb).includes('@') && lb.some((x) => x.me), 'leaderboard shows display names only');

  // --- admin
  const st = (await admin.call('GET', '/api/admin/stats')).data;
  ok(st.totals.validated >= 4 && st.by_category.length >= 1 && st.by_dialect.length >= 1, 'admin stats');
  const csvUp = 'english,category,gbari\nBread,food,\nWelcome home,greetings,Ɛ̀ nɔ̀ ná\nBread,food,\n"Hello, friend",greetings,\n';
  const imp = await admin.call('POST', '/api/admin/prompts/csv', { raw: Buffer.from(csvUp), type: 'text/csv' });
  ok(imp.data.added === 3 && imp.data.duplicates === 1 && imp.data.seeds === 1, 'CSV import ' + JSON.stringify(imp.data));
  ok((await a.call('POST', '/api/admin/prompts/csv', { raw: Buffer.from(csvUp), type: 'text/csv' })).status === 403, 'CSV import is admin-only');
  const users = (await admin.call('GET', '/api/admin/users')).data;
  ok(users.length >= 4 && users.every((u) => u.email), 'admin sees user list');
  const ada = users.find((u) => u.display_name === 'Ada');
  ok((await admin.call('PATCH', `/api/admin/users/${ada.id}`, { json: { review_blocked: true } })).status === 200, 'admin blocks reviewing');
  ok((await a.call('GET', '/api/review/next')).status === 403, 'blocked reviewer cannot review');
  const tp = await admin.call('POST', `/api/admin/users/${ada.id}/temp-password`);
  ok(tp.data.password && (await new Client().call('POST', '/api/login', { json: { email: 'ada@example.com', password: tp.data.password } })).status === 200, 'temp password works');

  // --- export
  const csvx = await admin.call('GET', '/api/admin/export.csv');
  const txt = csvx.buf.toString('utf8');
  ok(txt.startsWith('\uFEFFid,kind,english,gbari,gloss,dialect,village,category,prompt_id,source_entry_id,contributor_id,status,audio_file') && txt.includes('Ɛ̀nɔ̀ ná!'), 'CSV export has metadata + tone marks');
  ok(!txt.includes('@'), 'export contains no emails');
  const z = await admin.call('GET', '/api/admin/export.zip');
  const zf = path.join(process.env.DATA_DIR, 'out.zip'); fs.writeFileSync(zf, z.buf);
  const listing = execFileSync('unzip', ['-l', zf]).toString();
  ok(listing.includes('metadata.csv') && /audio\/[a-z-]+_\d+_\d+\.webm/.test(listing), 'zip contains metadata + audio');
  execFileSync('unzip', ['-tq', zf]);

  // --- deleting own data
  const beforeFiles = fs.readdirSync(path.join(process.env.DATA_DIR, 'audio')).length;
  const del = await c3.call('DELETE', '/api/me', { json: { confirm: 'nope' } });
  ok(del.status === 400, 'delete needs confirmation');
  ok((await c3.call('DELETE', '/api/me', { json: { confirm: 'DELETE' } })).status === 200, 'account deleted');
  ok((await c3.call('GET', '/api/me')).status === 401, 'session gone after deletion');
  ok(fs.readdirSync(path.join(process.env.DATA_DIR, 'audio')).length < beforeFiles, 'audio files removed');
  ok(!(await admin.call('GET', '/api/admin/export.csv')).buf.toString().includes('Chidi'), 'deleted data not exported');

  // --- static
  const idx = await fetch(base + '/', { headers: { 'Accept-Encoding': 'gzip' } });
  ok(idx.status === 200 || idx.status === 404, 'static route responds');

  console.log(`\n${pass} passed, ${fail} failed`);
  server.close(); fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
