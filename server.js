'use strict';
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const CFG = require('./config');
const { get, all, run, tx, norm, DATA_DIR, AUDIO_DIR } = require('./lib/db');
const csv = require('./lib/csv');
const { streamZip } = require('./lib/zip');
const { storeAudio, removeFile, HAS_FFMPEG } = require('./lib/audio');

const PORT = Number(process.env.PORT || 3000);
const PROD = process.env.NODE_ENV === 'production';
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const SUPER_ADMIN_EMAILS = (process.env.SUPER_ADMIN_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const SUPER_LIST = SUPER_ADMIN_EMAILS.length ? SUPER_ADMIN_EMAILS : ADMIN_EMAILS;
const ALL_ADMIN_EMAILS = [...new Set([...ADMIN_EMAILS, ...SUPER_ADMIN_EMAILS])];
const PUBLIC_DIR = path.join(__dirname, 'public');
const CAP = CFG.MAX_APPROVED_PER_PROMPT;
const DIALECT_CHOICES = [...CFG.DIALECTS, 'Not sure'];

class HttpError extends Error { constructor(status, message, code) { super(message); this.status = status; this.code = code; } }
const bad = (m) => new HttpError(400, m);

// ---------------------------------------------------------------- helpers
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const int = (v) => { const n = Number.parseInt(v, 10); return Number.isFinite(n) ? n : null; };
const clean = (v, max) => String(v == null ? '' : v).normalize('NFC').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
const slug = (s) => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'general';
const like = (q) => '%' + q.replace(/[\\%_]/g, (m) => '\\' + m) + '%';
const validEmail = (e) => /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/.test(e) && e.length <= 254;

const scrypt = (pw, salt) => new Promise((ok, no) => crypto.scrypt(pw, salt, 64, (e, k) => (e ? no(e) : ok(k.toString('hex')))));

const hits = new Map();
function limit(ip, key, max, windowMs) {
  const k = key + ip, now = Date.now();
  const a = (hits.get(k) || []).filter((t) => now - t < windowMs);
  a.push(now); hits.set(k, a);
  if (a.length > max) throw new HttpError(429, 'Too many attempts. Please wait a few minutes and try again.');
}
setInterval(() => { const now = Date.now(); for (const [k, a] of hits) if (!a.some((t) => now - t < 900000)) hits.delete(k); }, 600000).unref();

function readBody(req, max) {
  return new Promise((ok, no) => {
    const chunks = []; let size = 0, over = false;
    req.on('data', (c) => { size += c.length; if (size > max) { over = true; return; } chunks.push(c); });
    req.on('end', () => (over ? no(new HttpError(413, 'That upload is too large.')) : ok(Buffer.concat(chunks))));
    req.on('error', no);
  });
}

// ---------------------------------------------------------------- users & sessions
function userByToken(token) {
  if (!token) return null;
  return get(`SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?`, sha(token), Date.now()) || null;
}
function makeSession(res, req, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const maxAge = CFG.SESSION_DAYS * 86400;
  run('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)', sha(token), userId, Date.now() + maxAge * 1000);
  const secure = PROD || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader('Set-Cookie', `gv=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`);
}
const parseCookies = (h) => Object.fromEntries((h || '').split(';').map((c) => c.trim().split('=')).filter((p) => p[0]).map((p) => [p[0], p.slice(1).join('=')]));

const approvedCount = (uid) => get(`SELECT COUNT(*) n FROM entries WHERE contributor_id=? AND status='validated'`, uid).n;

function reviewerInfo(u) {
  const approved = approvedCount(u.id);
  const needNative = CFG.REVIEWER_REQUIRES_NATIVE;
  const meets = approved >= CFG.REVIEWER_MIN_APPROVED && (!needNative || !!u.native_speaker);
  const privileged = u.role === 'admin' || u.role === 'reviewer';
  return {
    eligible: !u.review_blocked && (privileged || meets),
    blocked: !!u.review_blocked,
    approved, needed: CFG.REVIEWER_MIN_APPROVED, needsNative: needNative, isNative: !!u.native_speaker,
  };
}
const canReview = (u) => reviewerInfo(u).eligible;

function publicSelf(u) {
  return {
    id: u.id, email: u.email, display_name: u.display_name, role: u.role,
    native_speaker: !!u.native_speaker, home_dialect: u.home_dialect,
    consent_ok: u.consent_version === CFG.CONSENT_VERSION,
    reviewer: reviewerInfo(u), super: isSuper(u),
  };
}

function isAdminEmail(email) { return email && ALL_ADMIN_EMAILS.includes(email.toLowerCase()); }
function isSuper(u) { return !!(u && u.email && SUPER_LIST.includes(u.email.toLowerCase())); }
function guardTarget(c, target) {
  if (target.id === c.user.id) return;
  if (isSuper(target)) throw new HttpError(403, 'Super admin accounts can only be changed by their owner.');
  if (target.role === 'admin' && !isSuper(c.user)) throw new HttpError(403, 'Only a super admin can change another admin.');
}
function syncAdmins() {
  for (const e of ALL_ADMIN_EMAILS) run(`UPDATE users SET role='admin' WHERE email=? AND role!='admin'`, e);
}

function uniqueName(base) {
  base = clean(base, 24) || 'Contributor';
  let name = base;
  for (let i = 0; get('SELECT 1 x FROM users WHERE lower(display_name)=lower(?)', name); i++) name = base + (100 + Math.floor(Math.random() * 900));
  return name;
}
function validName(raw) {
  const n = clean(raw, 30);
  if (n.length < 2) throw bad('Display name must be at least 2 characters.');
  if (/[@<>]/.test(n)) throw bad('Display name cannot contain @, < or >. Do not use your email.');
  return n;
}

// ---------------------------------------------------------------- data helpers
function approvedForPrompt(pid) {
  return get(`SELECT COUNT(*) n FROM entries WHERE prompt_id=? AND kind='translation' AND status='validated'`, pid).n;
}
function audioBase(e) {
  return `${slug(e.category)}_${e.prompt_id}_${e.contributor_id}` + (e.kind === 'recording' ? `_read${e.source_entry_id}` : '');
}
function entryOut(e, extra = {}) {
  return {
    id: e.id, kind: e.kind, prompt_id: e.prompt_id, english: e.english, gbari: e.gbari, gloss: e.gloss,
    dialect: e.dialect, village: e.village, category: e.category, status: e.status,
    has_audio: !!e.audio_file, audio_ms: e.audio_ms, created_at: e.created_at, ...extra,
  };
}
function deleteEntryFiles(files) { for (const f of files) removeFile(f); }

function deleteEntries(whereSql, ...params) {
  // collect audio of the entries and of recordings that cascade from them
  const ids = all(`SELECT id FROM entries WHERE ${whereSql}`, ...params).map((r) => r.id);
  if (!ids.length) return 0;
  const ph = ids.map(() => '?').join(',');
  const files = all(`SELECT audio_file f FROM entries WHERE audio_file IS NOT NULL AND (id IN (${ph}) OR source_entry_id IN (${ph}))`, ...ids, ...ids).map((r) => r.f);
  tx(() => run(`DELETE FROM entries WHERE id IN (${ph})`, ...ids));
  deleteEntryFiles(files);
  return ids.length;
}

function deleteUser(uid) {
  const files = all(`SELECT audio_file f FROM entries WHERE audio_file IS NOT NULL AND (contributor_id=? OR source_entry_id IN (SELECT id FROM entries WHERE contributor_id=?))`, uid, uid).map((r) => r.f);
  tx(() => run('DELETE FROM users WHERE id=?', uid));
  deleteEntryFiles(files);
}

function streaks(uid) {
  const days = all(`SELECT DISTINCT date(created_at, ?) d FROM entries WHERE contributor_id=? AND kind!='seed' ORDER BY d`, `+${CFG.TZ_OFFSET_HOURS} hours`, uid).map((r) => r.d);
  const t = (d) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 86400000;
  let best = 0, run_ = 0;
  for (let i = 0; i < days.length; i++) { run_ = i && t(days[i]) - t(days[i - 1]) === 1 ? run_ + 1 : 1; best = Math.max(best, run_); }
  const today = get(`SELECT date('now', ?) d`, `+${CFG.TZ_OFFSET_HOURS} hours`).d;
  let current = 0;
  if (days.length) {
    const last = days[days.length - 1], gap = t(today) - t(last);
    if (gap <= 1) { current = 1; for (let i = days.length - 1; i > 0 && t(days[i]) - t(days[i - 1]) === 1; i--) current++; }
  }
  return { current, best };
}

function profileOf(u) {
  const c = get(`SELECT COUNT(*) submitted,
      SUM(status='validated') validated,
      SUM(status='pending') pending,
      SUM(status='needs_fix') needs_fix,
      SUM(kind='recording') recordings,
      SUM(audio_file IS NOT NULL) with_audio
    FROM entries WHERE contributor_id=?`, u.id);
  const reviews = get('SELECT COUNT(*) n FROM reviews WHERE reviewer_id=?', u.id).n;
  const st = streaks(u.id);
  const n = (v) => v || 0;
  const badges = [
    { id: 'first', name: 'First phrase', desc: 'Submit your first entry', got: n(c.submitted) >= 1 },
    { id: 'v10', name: 'Ten approved', desc: '10 approved entries', got: n(c.validated) >= 10 },
    { id: 'v50', name: 'Fifty approved', desc: '50 approved entries', got: n(c.validated) >= 50 },
    { id: 'v200', name: 'Word keeper', desc: '200 approved entries', got: n(c.validated) >= 200 },
    { id: 'voice', name: 'Clear voice', desc: '25 recordings submitted', got: n(c.with_audio) >= 25 },
    { id: 'streak3', name: '3-day streak', desc: 'Contribute 3 days in a row', got: st.best >= 3 },
    { id: 'streak7', name: '7-day streak', desc: 'Contribute 7 days in a row', got: st.best >= 7 },
    { id: 'rev25', name: 'Trusted reviewer', desc: 'Review 25 entries', got: reviews >= 25 },
  ];
  return {
    display_name: u.display_name,
    submitted: n(c.submitted), validated: n(c.validated), pending: n(c.pending), needs_fix: n(c.needs_fix),
    recordings: n(c.recordings), reviews, streak: st.current, best_streak: st.best, badges,
  };
}

// ---------------------------------------------------------------- routes
const routes = [];
const add = (method, pattern, opts, fn) => {
  routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), opts, fn });
};
// auth levels: null (public) | 'session' (logged in) | 'user' (logged in + consent) | 'reviewer' | 'admin'

const PUBLIC_CONFIG = {
  appName: CFG.APP_NAME, tagline: CFG.TAGLINE,
  whatsappIntl: CFG.WHATSAPP_INTL, whatsappDisplay: CFG.WHATSAPP_DISPLAY,
  dialects: DIALECT_CHOICES, keypadLetters: CFG.KEYPAD_LETTERS, keypadTones: CFG.KEYPAD_TONES,
  cap: CAP, maxSeconds: CFG.MAX_AUDIO_SECONDS, maxUploadBytes: CFG.MAX_AUDIO_UPLOAD_BYTES,
  requireAudio: CFG.REQUIRE_AUDIO, reviewerMin: CFG.REVIEWER_MIN_APPROVED, reviewerNative: CFG.REVIEWER_REQUIRES_NATIVE,
  consentPoints: CFG.CONSENT_POINTS, googleClientId: GOOGLE_CLIENT_ID,
};
add('GET', '/api/config', null, (c) => c.json(200, PUBLIC_CONFIG));

// ---- auth
add('POST', '/api/signup', null, async (c) => {
  limit(c.ip, 'auth', 20, 600000);
  const b = await c.body();
  const email = clean(b.email, 254).toLowerCase();
  if (!validEmail(email)) throw bad('Enter a valid email address.');
  const pw = String(b.password || '');
  if (pw.length < 8) throw bad('Password must be at least 8 characters.');
  if (pw.length > 200) throw bad('Password is too long.');
  const name = validName(b.display_name);
  if (get('SELECT 1 x FROM users WHERE email=?', email)) throw new HttpError(409, 'An account with this email already exists. Try logging in.');
  if (get('SELECT 1 x FROM users WHERE lower(display_name)=lower(?)', name)) throw new HttpError(409, 'That display name is taken. Please choose another.');
  const salt = crypto.randomBytes(16).toString('hex');
  const r = run('INSERT INTO users(email,pw_hash,pw_salt,display_name,native_speaker,role) VALUES(?,?,?,?,?,?)',
    email, await scrypt(pw, salt), salt, name, b.native_speaker ? 1 : 0, isAdminEmail(email) ? 'admin' : 'contributor');
  makeSession(c.res, c.req, r.lastInsertRowid);
  c.json(200, publicSelf(get('SELECT * FROM users WHERE id=?', r.lastInsertRowid)));
});

add('POST', '/api/login', null, async (c) => {
  limit(c.ip, 'auth', 20, 600000);
  const b = await c.body();
  const u = get('SELECT * FROM users WHERE email=?', clean(b.email, 254).toLowerCase());
  const ok = u && u.pw_hash && (await scrypt(String(b.password || ''), u.pw_salt)) === u.pw_hash;
  if (!ok) throw new HttpError(401, 'Wrong email or password.');
  makeSession(c.res, c.req, u.id);
  c.json(200, publicSelf(u));
});

function googleVerify(idToken) {
  return new Promise((ok, no) => {
    const r = https.get('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken), { timeout: 8000 }, (res) => {
      let s = ''; res.on('data', (d) => (s += d));
      res.on('end', () => {
        try {
          const j = JSON.parse(s);
          const verified = j.email_verified === true || j.email_verified === 'true';
          if (res.statusCode !== 200 || j.aud !== GOOGLE_CLIENT_ID || !verified || !/accounts\.google\.com$/.test(j.iss || '')) return no(new HttpError(401, 'Google sign-in failed.'));
          ok(j);
        } catch { no(new HttpError(401, 'Google sign-in failed.')); }
      });
    });
    r.on('timeout', () => { r.destroy(); no(new HttpError(502, 'Could not reach Google. Try again or use email.')); });
    r.on('error', () => no(new HttpError(502, 'Could not reach Google. Try again or use email.')));
  });
}
add('POST', '/api/google', null, async (c) => {
  if (!GOOGLE_CLIENT_ID) throw bad('Google sign-in is not set up on this site.');
  limit(c.ip, 'auth', 20, 600000);
  const g = await googleVerify(String((await c.body()).credential || ''));
  const email = String(g.email).toLowerCase();
  let u = get('SELECT * FROM users WHERE google_sub=?', g.sub) || get('SELECT * FROM users WHERE email=?', email);
  if (!u) {
    const r = run('INSERT INTO users(email,google_sub,display_name,role) VALUES(?,?,?,?)', email, g.sub, uniqueName(g.given_name || 'Contributor'), isAdminEmail(email) ? 'admin' : 'contributor');
    u = get('SELECT * FROM users WHERE id=?', r.lastInsertRowid);
  } else if (!u.google_sub) { run('UPDATE users SET google_sub=? WHERE id=?', g.sub, u.id); u = get('SELECT * FROM users WHERE id=?', u.id); }
  makeSession(c.res, c.req, u.id);
  c.json(200, publicSelf(u));
});

add('POST', '/api/logout', null, (c) => {
  const t = parseCookies(c.req.headers.cookie).gv;
  if (t) run('DELETE FROM sessions WHERE token_hash=?', sha(t));
  c.res.setHeader('Set-Cookie', 'gv=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
  c.json(200, { ok: true });
});

add('GET', '/api/me', 'session', (c) => c.json(200, publicSelf(c.user)));

add('POST', '/api/consent', 'session', async (c) => {
  const b = await c.body();
  if (b.agree !== true) throw bad('You need to agree to continue.');
  run(`UPDATE users SET consent_at=datetime('now'), consent_version=? WHERE id=?`, CFG.CONSENT_VERSION, c.user.id);
  c.json(200, publicSelf(get('SELECT * FROM users WHERE id=?', c.user.id)));
});

add('PATCH', '/api/me', 'session', async (c) => {
  const b = await c.body();
  const u = c.user;
  if (b.display_name !== undefined && b.display_name !== u.display_name) {
    const n = validName(b.display_name);
    const other = get('SELECT id FROM users WHERE lower(display_name)=lower(?)', n);
    if (other && other.id !== u.id) throw new HttpError(409, 'That display name is taken.');
    run('UPDATE users SET display_name=? WHERE id=?', n, u.id);
  }
  if (b.native_speaker !== undefined) run('UPDATE users SET native_speaker=? WHERE id=?', b.native_speaker ? 1 : 0, u.id);
  if (b.home_dialect !== undefined) run('UPDATE users SET home_dialect=? WHERE id=?', DIALECT_CHOICES.includes(b.home_dialect) ? b.home_dialect : null, u.id);
  c.json(200, publicSelf(get('SELECT * FROM users WHERE id=?', u.id)));
});

add('DELETE', '/api/me', 'session', async (c) => {
  const b = await c.body();
  if (b.confirm !== 'DELETE') throw bad('Type DELETE to confirm.');
  deleteUser(c.user.id);
  c.res.setHeader('Set-Cookie', 'gv=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
  c.json(200, { ok: true });
});

add('GET', '/api/me/data', 'session', (c) => {
  // lets people see exactly what we hold about them
  const u = c.user;
  c.res.setHeader('Content-Disposition', 'attachment; filename="my-gbari-voices-data.json"');
  c.json(200, {
    account: { email: u.email, display_name: u.display_name, native_speaker: !!u.native_speaker, home_dialect: u.home_dialect, joined: u.created_at, consent_at: u.consent_at },
    entries: all('SELECT id,kind,english,gbari,gloss,dialect,village,category,status,created_at FROM entries WHERE contributor_id=? ORDER BY id', u.id),
    reviews_given: get('SELECT COUNT(*) n FROM reviews WHERE reviewer_id=?', u.id).n,
  });
});

// ---- categories & prompts
add('GET', '/api/categories', 'user', (c) => {
  c.json(200, all(`SELECT category, COUNT(*) n FROM prompts WHERE active=1 AND reading_only=0 GROUP BY category ORDER BY category`));
});

const PROMPT_SELECT = `SELECT p.id, p.english, p.category,
    (SELECT COUNT(*) FROM entries e WHERE e.prompt_id=p.id AND e.kind='translation' AND e.status='validated') approved,
    EXISTS(SELECT 1 FROM entries e WHERE e.prompt_id=p.id AND e.kind='translation' AND e.contributor_id=?) mine
  FROM prompts p WHERE p.active=1 AND p.reading_only=0`;

add('GET', '/api/prompts', 'user', (c) => {
  const cat = clean(c.query.get('category'), 80).toLowerCase();
  const q = clean(c.query.get('q'), 100);
  const rows = all(`${PROMPT_SELECT} AND (?='' OR p.category=?) AND (?='' OR p.english LIKE ? ESCAPE '\\')
    ORDER BY (approved>=?), mine, p.id LIMIT 40`, c.user.id, cat, cat, q, like(q), CAP);
  c.json(200, rows.map((r) => ({ ...r, mine: !!r.mine, full: r.approved >= CAP })));
});

add('GET', '/api/prompts/next', 'user', (c) => {
  const cat = clean(c.query.get('category'), 80).toLowerCase();
  const ex = int(c.query.get('exclude')) || 0;
  const r = get(`SELECT * FROM (${PROMPT_SELECT} AND (?='' OR p.category=?) AND p.id!=?) WHERE approved<? AND mine=0 ORDER BY RANDOM() LIMIT 1`, c.user.id, cat, cat, ex, CAP);
  c.json(200, r ? { ...r, mine: false, full: false } : null);
});

add('GET', '/api/prompts/:id', 'user', (c) => {
  const r = get(`${PROMPT_SELECT} AND p.id=?`, c.user.id, int(c.params.id));
  if (!r) throw new HttpError(404, 'Phrase not found.');
  c.json(200, { ...r, mine: !!r.mine, full: r.approved >= CAP });
});

// ---- entries
function fields(b) {
  const gbari = clean(b.gbari, 500), gloss = clean(b.gloss, 500), village = clean(b.village, 80);
  const dialect = DIALECT_CHOICES.includes(b.dialect) ? b.dialect : null;
  if (!gbari) throw bad('Write the Gbari sentence.');
  if (!gloss) throw bad('Add the word-for-word English gloss.');
  if (!dialect) throw bad('Choose a dialect (or "Not sure").');
  return { gbari, gloss, dialect, village };
}

add('POST', '/api/entries', 'user', async (c) => {
  limit(c.ip, 'entry', 120, 600000);
  const b = await c.body();
  const p = get('SELECT * FROM prompts WHERE id=? AND active=1 AND reading_only=0', int(b.prompt_id));
  if (!p) throw new HttpError(404, 'Phrase not found. Choose another.');
  const f = fields(b);
  if (approvedForPrompt(p.id) >= CAP) throw new HttpError(409, `This phrase already has ${CAP} approved translations. Please choose another phrase.`, 'full');
  if (get(`SELECT 1 x FROM entries WHERE kind='translation' AND prompt_id=? AND contributor_id=?`, p.id, c.user.id)) throw new HttpError(409, 'You have already translated this phrase. Choose another.', 'mine');
  const r = run(`INSERT INTO entries(kind,prompt_id,english,gbari,gbari_norm,gloss,dialect,village,category,contributor_id)
    VALUES('translation',?,?,?,?,?,?,?,?,?)`, p.id, p.english, f.gbari, norm(f.gbari), f.gloss, f.dialect, f.village, p.category, c.user.id);
  c.json(201, { id: r.lastInsertRowid });
});

add('POST', '/api/entries/read', 'user', async (c) => {
  limit(c.ip, 'entry', 120, 600000);
  const b = await c.body();
  const s = get(`SELECT * FROM entries WHERE id=? AND kind IN ('translation','seed') AND status='validated'`, int(b.source_entry_id));
  if (!s) throw new HttpError(404, 'That text is not available any more. Try the next one.');
  if (s.contributor_id === c.user.id) throw bad('Please record a text written by someone else.');
  if (get(`SELECT 1 x FROM entries WHERE kind='recording' AND source_entry_id=? AND contributor_id=?`, s.id, c.user.id)) throw new HttpError(409, 'You have already recorded this text.');
  const dialect = DIALECT_CHOICES.includes(b.dialect) ? b.dialect : null;
  if (!dialect) throw bad('Choose your dialect (or "Not sure").');
  const r = run(`INSERT INTO entries(kind,prompt_id,source_entry_id,english,gbari,gbari_norm,gloss,dialect,village,category,contributor_id)
    VALUES('recording',?,?,?,?,?,?,?,?,?,?)`, s.prompt_id, s.id, s.english, s.gbari, s.gbari_norm, s.gloss, dialect, clean(b.village, 80), s.category, c.user.id);
  c.json(201, { id: r.lastInsertRowid });
});

add('GET', '/api/read/next', 'user', (c) => {
  const skip = (c.query.get('skip') || '').split(',').map(int).filter(Boolean).slice(0, 50);
  const ph = skip.length ? skip.map(() => '?').join(',') : '-1';
  const cat = clean(c.query.get('category'), 80).toLowerCase();
  const r = get(`SELECT s.*, (SELECT COUNT(*) FROM entries r WHERE r.source_entry_id=s.id AND r.kind='recording') recs
    FROM entries s
    WHERE s.kind IN ('translation','seed') AND s.status='validated' AND (s.contributor_id IS NULL OR s.contributor_id!=?)
      AND (?='' OR s.category=?)
      AND NOT EXISTS (SELECT 1 FROM entries r WHERE r.kind='recording' AND r.source_entry_id=s.id AND r.contributor_id=?)
      AND (SELECT COUNT(*) FROM entries r WHERE r.source_entry_id=s.id AND r.kind='recording') < ?
      AND s.id NOT IN (${ph})
    ORDER BY recs, RANDOM() LIMIT 1`, c.user.id, cat, cat, c.user.id, CFG.READ_MAX_RECORDINGS_PER_TEXT, ...skip);
  c.json(200, r ? { id: r.id, english: r.english, gbari: r.gbari, category: r.category, dialect: r.dialect } : null);
});

function ownEntry(c) {
  const e = get('SELECT * FROM entries WHERE id=? AND contributor_id=?', int(c.params.id), c.user.id);
  if (!e) throw new HttpError(404, 'Entry not found.');
  return e;
}

add('PUT', '/api/entries/:id/audio', 'user', async (c) => {
  limit(c.ip, 'audio', 120, 600000);
  const e = ownEntry(c);
  if (!['pending', 'needs_fix'].includes(e.status)) throw new HttpError(409, 'This entry is already approved or closed, so its recording cannot be changed.');
  if (e.status === 'pending' && get('SELECT 1 x FROM reviews WHERE entry_id=? AND round=?', e.id, e.round)) throw new HttpError(409, 'A reviewer has already looked at this entry.');
  const ct = String(c.req.headers['content-type'] || '').toLowerCase();
  if (!(ct.startsWith('audio/') || ct.startsWith('video/webm') || ct.startsWith('video/mp4') || ct === 'application/ogg')) throw bad('Only audio files can be uploaded.');
  const buf = await readBody(c.req, CFG.MAX_AUDIO_UPLOAD_BYTES);
  const a = await storeAudio(buf, audioBase(e));
  const ms = a.ms || Math.min(int(c.req.headers['x-duration-ms']) || 0, CFG.MAX_AUDIO_SECONDS * 1000) || null;
  run(`UPDATE entries SET audio_file=?, audio_mime=?, audio_ms=?, updated_at=datetime('now') WHERE id=?`, a.file, a.mime, ms, e.id);
  if (e.audio_file && e.audio_file !== a.file) removeFile(e.audio_file);
  c.json(200, { ok: true, ms });
});

add('PATCH', '/api/entries/:id', 'user', async (c) => {
  const e = ownEntry(c);
  const b = await c.body();
  const hasReview = !!get('SELECT 1 x FROM reviews WHERE entry_id=? AND round=?', e.id, e.round);
  if (e.status === 'validated' || e.status === 'rejected') throw new HttpError(409, 'This entry is closed and cannot be edited.');
  if (e.status === 'pending' && hasReview) throw new HttpError(409, 'A reviewer has already looked at this entry.');
  let f = { gbari: e.gbari, gloss: e.gloss, dialect: e.dialect, village: e.village };
  if (e.kind === 'translation') f = fields({ ...f, ...b });
  else if (b.dialect) f.dialect = DIALECT_CHOICES.includes(b.dialect) ? b.dialect : e.dialect;
  if (e.kind === 'recording' && !e.audio_file) throw bad('Please add a recording first.');
  run(`UPDATE entries SET gbari=?, gbari_norm=?, gloss=?, dialect=?, village=?, status='pending', round=round+?, updated_at=datetime('now') WHERE id=?`,
    f.gbari, norm(f.gbari), f.gloss, f.dialect, f.village ?? e.village, e.status === 'needs_fix' ? 1 : 0, e.id);
  c.json(200, { ok: true });
});

add('DELETE', '/api/entries/:id', 'user', (c) => {
  const e = ownEntry(c);
  deleteEntries('id=?', e.id);
  c.json(200, { ok: true });
});

add('GET', '/api/my/entries', 'user', (c) => {
  const rows = all(`SELECT e.*, (SELECT COUNT(*) FROM entries r WHERE r.source_entry_id=e.id AND r.kind='recording') recs
    FROM entries e WHERE contributor_id=? ORDER BY (status='needs_fix') DESC, id DESC LIMIT 200`, c.user.id);
  c.json(200, rows.map((e) => {
    const rv = e.status === 'needs_fix' || e.status === 'rejected'
      ? get(`SELECT verdict, fix_text, note FROM reviews WHERE entry_id=? AND round=? ORDER BY id DESC LIMIT 1`, e.id, e.round) : null;
    return entryOut(e, { review: rv });
  }));
});

// ---- audio streaming (with Range support, needed by Safari/iOS)
add('GET', '/api/audio/:id', 'user', (c) => {
  const e = get('SELECT * FROM entries WHERE id=? AND audio_file IS NOT NULL', int(c.params.id));
  if (!e) throw new HttpError(404, 'No audio.');
  const mine = e.contributor_id === c.user.id;
  if (!(mine || e.status === 'validated' || c.user.role === 'admin' || canReview(c.user))) throw new HttpError(403, 'Not allowed.');
  const file = path.join(AUDIO_DIR, path.basename(e.audio_file));
  let st; try { st = fs.statSync(file); } catch { throw new HttpError(404, 'No audio.'); }
  const h = { 'Content-Type': e.audio_mime || 'audio/webm', 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=3600' };
  const m = /bytes=(\d*)-(\d*)/.exec(c.req.headers.range || '');
  if (m) {
    let s = m[1] === '' ? Math.max(0, st.size - Number(m[2])) : Number(m[1]);
    let en = m[1] === '' || m[2] === '' ? st.size - 1 : Math.min(Number(m[2]), st.size - 1);
    if (s > en || s >= st.size) { c.res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return c.res.end(); }
    c.res.writeHead(206, { ...h, 'Content-Range': `bytes ${s}-${en}/${st.size}`, 'Content-Length': en - s + 1 });
    return fs.createReadStream(file, { start: s, end: en }).pipe(c.res);
  }
  c.res.writeHead(200, { ...h, 'Content-Length': st.size });
  fs.createReadStream(file).pipe(c.res);
  c.handled = true;
});

// ---- review
add('GET', '/api/review/next', 'user', (c) => {
  const info = reviewerInfo(c.user);
  if (!info.eligible) return c.json(403, { error: 'Review is not unlocked for you yet.', code: 'not_eligible', reviewer: info });
  const isAdmin = c.user.role ==='admin'? 1:0;
  const skip = (c.query.get('skip') || '').split(',').map(int).filter(Boolean).slice(0, 50);
  const ph = skip.length ? skip.map(() => '?').join(',') : '-1';
  const where = `e.status='pending' AND e.kind IN ('translation','recording') AND (e.kind='translation' OR e.audio_file IS NOT NULL)
    AND (e.contributor_id!=? OR ?=1) AND NOT EXISTS (SELECT 1 FROM reviews r WHERE r.entry_id=e.id AND r.round=e.round AND r.reviewer_id=?)`;
  const e = get(`SELECT e.* FROM entries e WHERE ${where} AND e.id NOT IN (${ph}) ORDER BY (e.audio_file IS NULL), e.id LIMIT 1`, c.user.id, c.user.isAdmin, c.user.id, ...skip);
  const remaining = get(`SELECT COUNT(*) n FROM entries e WHERE ${where}`, c.user.id, c.user.isAdmin, c.user.id).n;
  c.json(200, { entry: e ? entryOut(e) : null, remaining });
});

add('POST', '/api/review', 'user', async (c) => {
  if (!canReview(c.user)) throw new HttpError(403, 'Review is not unlocked for you yet.');
  const b = await c.body();
  const e = get('SELECT * FROM entries WHERE id=?', int(b.entry_id));
  if (!e || e.kind === 'seed') throw new HttpError(404, 'Entry not found.');
  if (e.contributor_id === c.user.id && c.user.role !== "admin") throw new HttpError(403, 'You cannot review your own entry.');
  if (e.status !== 'pending') throw new HttpError(409, 'This entry has already been reviewed.');
  if (!['correct', 'needs_fix', 'reject'].includes(b.verdict)) throw bad('Choose Correct, Needs fix or Reject.');
  const fix = clean(b.fix_text, 500), note = clean(b.note, 300);
  if (b.verdict === 'needs_fix' && !fix && !note) throw bad('Tell the contributor what to fix: write the corrected text or a short note.');
  if (b.verdict === 'reject' && !note) throw bad('Choose or write a short reason for rejecting.');
  if (get('SELECT 1 x FROM reviews WHERE entry_id=? AND round=? AND reviewer_id=?', e.id, e.round, c.user.id)) throw new HttpError(409, 'You already reviewed this entry.');
  const status = tx(() => {
    run('INSERT INTO reviews(entry_id,reviewer_id,round,verdict,fix_text,note) VALUES(?,?,?,?,?,?)', e.id, c.user.id, e.round, b.verdict, fix || null, note || null);
    let st = 'pending';
    if (b.verdict === 'needs_fix') st = 'needs_fix';
    else if (b.verdict === 'reject') st = 'rejected';
    else if (get(`SELECT COUNT(*) n FROM reviews WHERE entry_id=? AND round=? AND verdict='correct'`, e.id, e.round).n >= CFG.REVIEWS_REQUIRED) st = 'validated';
    run(`UPDATE entries SET status=?, updated_at=datetime('now') WHERE id=?`, st, e.id);
    return st;
  });
  c.json(200, { status });
});

// ---- browse
add('GET', '/api/browse', 'user', (c) => {
  const q = clean(c.query.get('q'), 100);
  const dir = c.query.get('dir') === 'en2gb' ? 'en2gb' : 'gb2en';
  const cat = clean(c.query.get('category'), 80).toLowerCase();
  const page = Math.max(0, int(c.query.get('page')) || 0);
  const col = dir === 'gb2en' ? 'e.gbari_norm LIKE ? ESCAPE \'\\\'' : 'e.english LIKE ? ESCAPE \'\\\'';
  const pat = like(dir === 'gb2en' ? norm(q) : q);
  const rows = all(`SELECT e.id, e.english, e.gbari, e.gloss, e.dialect, e.village, e.category,
      CASE WHEN e.audio_file IS NOT NULL THEN e.id ELSE (SELECT r.id FROM entries r WHERE r.source_entry_id=e.id AND r.status='validated' AND r.audio_file IS NOT NULL ORDER BY r.id LIMIT 1) END audio_id
    FROM entries e WHERE e.status='validated' AND e.kind IN ('translation','seed') AND (?='' OR e.category=?) AND (?='' OR ${col})
    ORDER BY ${dir === 'gb2en' ? 'e.gbari_norm' : 'e.english'} COLLATE NOCASE, e.id LIMIT 21 OFFSET ?`, cat, cat, q, pat, page * 20);
  c.json(200, { items: rows.slice(0, 20), more: rows.length > 20 });
});

add('GET', '/api/browse/categories', 'user', (c) => {
  c.json(200, all(`SELECT category, COUNT(*) n FROM entries WHERE status='validated' AND kind IN ('translation','seed') GROUP BY category ORDER BY category`));
});

// ---- profile & leaderboard
add('GET', '/api/profile', 'user', (c) => c.json(200, profileOf(c.user)));
add('GET', '/api/leaderboard', 'user', (c) => {
  const rows = all(`SELECT u.id, u.display_name name, COUNT(e.id) validated FROM users u JOIN entries e ON e.contributor_id=u.id AND e.status='validated'
    WHERE u.consent_at IS NOT NULL GROUP BY u.id ORDER BY validated DESC, MIN(e.id) LIMIT 15`);
  c.json(200, rows.map((r, i) => ({ rank: i + 1, name: r.name, validated: r.validated, me: r.id === c.user.id })));
});

// ---- admin
const admin = 'admin';
add('GET', '/api/admin/stats', admin, (c) => {
  const grid = (col) => {
    const rows = all(`SELECT COALESCE(${col},'(none)') k, status, COUNT(*) n FROM entries WHERE kind!='seed' GROUP BY k, status`);
    const m = new Map();
    for (const r of rows) { const o = m.get(r.k) || { name: r.k, pending: 0, needs_fix: 0, validated: 0, rejected: 0, total: 0 }; o[r.status] = r.n; o.total += r.n; m.set(r.k, o); }
    return [...m.values()].sort((a, b) => b.total - a.total);
  };
  const t = get(`SELECT COUNT(*) total, SUM(status='validated') validated, SUM(status='pending') pending, SUM(status='needs_fix') needs_fix, SUM(status='rejected') rejected,
      SUM(audio_file IS NOT NULL) with_audio, COALESCE(SUM(audio_ms),0) audio_ms FROM entries WHERE kind!='seed'`);
  c.json(200, {
    totals: { ...t, users: get('SELECT COUNT(*) n FROM users').n, reviewers: all('SELECT * FROM users').filter(canReview).length,
      prompts: get('SELECT COUNT(*) n FROM prompts WHERE active=1 AND reading_only=0').n,
      prompts_full: get(`SELECT COUNT(*) n FROM (SELECT p.id FROM prompts p JOIN entries e ON e.prompt_id=p.id AND e.kind='translation' AND e.status='validated' GROUP BY p.id HAVING COUNT(*)>=?)`, CAP).n,
      prompts_empty: get(`SELECT COUNT(*) n FROM prompts p WHERE active=1 AND reading_only=0 AND NOT EXISTS (SELECT 1 FROM entries e WHERE e.prompt_id=p.id AND e.kind='translation' AND e.status='validated')`).n },
    by_category: grid('category'), by_dialect: grid('dialect'),
  });
});

add('GET', '/api/admin/queue', admin, (c) => {
  const status = ['pending', 'needs_fix', 'rejected', 'validated'].includes(c.query.get('status')) ? c.query.get('status') : 'pending';
  const page = Math.max(0, int(c.query.get('page')) || 0);
  const rows = all(`SELECT e.*, u.display_name who FROM entries e LEFT JOIN users u ON u.id=e.contributor_id
    WHERE e.status=? AND e.kind!='seed' ORDER BY e.id LIMIT 21 OFFSET ?`, status, page * 20);
  c.json(200, { items: rows.slice(0, 20).map((e) => entryOut(e, { who: e.who })), more: rows.length > 20 });
});

add('POST', '/api/admin/entries/:id/status', admin, async (c) => {
  const b = await c.body();
  if (!['pending', 'rejected'].includes(b.status)) throw bad('Admins can reopen (pending) or reject entries here.');
  const e = get('SELECT * FROM entries WHERE id=? AND kind!=?', int(c.params.id), 'seed');
  if (!e) throw new HttpError(404, 'Entry not found.');
  run(`UPDATE entries SET status=?, round=round+?, updated_at=datetime('now') WHERE id=?`, b.status, b.status === 'pending' ? 1 : 0, e.id);
  c.json(200, { ok: true });
});

add('DELETE', '/api/admin/entries/:id', admin, (c) => {
  deleteEntries('id=?', int(c.params.id));
  c.json(200, { ok: true });
});

add('POST', '/api/admin/prompts/csv', admin, async (c) => {
  const text = (await readBody(c.req, 2 * 1024 * 1024)).toString('utf8');
  const rows = csv.parse(text);
  if (!rows.length) throw bad('The CSV is empty.');
  let head = rows[0].map((h) => h.trim().toLowerCase());
  let start = 0, ci = { english: 0, category: 1, gbari: 2 };
  if (head.includes('english') || head.includes('category')) {
    start = 1;
    ci = { english: head.indexOf('english'), category: head.indexOf('category'), gbari: head.indexOf('gbari') };
    if (ci.english < 0) throw bad('The CSV needs an "english" column.');
  }
  const res = { added: 0, duplicates: 0, invalid: 0, seeds: 0 };
  tx(() => {
    for (const r of rows.slice(start)) {
      const english = clean(r[ci.english], 300);
      const category = clean(ci.category >= 0 ? r[ci.category] : '', 60).toLowerCase() || 'general';
      const gbari = ci.gbari >= 0 ? clean(r[ci.gbari], 500) : '';
      if (!english) { res.invalid++; continue; }
      if (get('SELECT 1 x FROM prompts WHERE english=? AND category=?', english, category)) { res.duplicates++; continue; }
      const p = run('INSERT INTO prompts(english,category,reading_only) VALUES(?,?,?)', english, category, gbari ? 1 : 0);
      res.added++;
      if (gbari) {
        run(`INSERT INTO entries(kind,prompt_id,english,gbari,gbari_norm,category,status) VALUES('seed',?,?,?,?,?,'validated')`, p.lastInsertRowid, english, gbari, norm(gbari), category);
        res.seeds++;
      }
    }
  });
  c.json(200, res);
});

add('GET', '/api/admin/prompts', admin, (c) => {
  const q = clean(c.query.get('q'), 100);
  const rows = all(`SELECT p.id, p.english, p.category, p.active, p.reading_only,
      (SELECT COUNT(*) FROM entries e WHERE e.prompt_id=p.id AND e.kind='translation' AND e.status='validated') approved
    FROM prompts p WHERE (?='' OR p.english LIKE ? ESCAPE '\\') ORDER BY p.id DESC LIMIT 50`, q, like(q));
  c.json(200, rows);
});
add('PATCH', '/api/admin/prompts/:id', admin, async (c) => {
  const b = await c.body();
  run('UPDATE prompts SET active=? WHERE id=?', b.active ? 1 : 0, int(c.params.id));
  c.json(200, { ok: true });
});

add('GET', '/api/admin/users', admin, (c) => {
  const q = clean(c.query.get('q'), 100);
  const rows = all(`SELECT u.*, (SELECT COUNT(*) FROM entries e WHERE e.contributor_id=u.id) entries,
      (SELECT COUNT(*) FROM entries e WHERE e.contributor_id=u.id AND e.status='validated') approved,
      (SELECT COUNT(*) FROM reviews r WHERE r.reviewer_id=u.id) reviews
    FROM users u WHERE (?='' OR u.display_name LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\') ORDER BY u.id DESC LIMIT 50`, q, like(q), like(q));
  c.json(200, rows.map((u) => ({
    id: u.id, email: u.email, display_name: u.display_name, role: u.role, native_speaker: !!u.native_speaker,
    review_blocked: !!u.review_blocked, entries: u.entries, approved: u.approved, reviews: u.reviews, joined: u.created_at,
    can_review: reviewerInfo(u).eligible, google: !!u.google_sub, super: isSuper(u),b,
  })));
});
add('PATCH', '/api/admin/users/:id', admin, async (c) => {
  const b = await c.body();
  const id = int(c.params.id);
  const u = get('SELECT * FROM users WHERE id=?', id);
  if (!u) throw new HttpError(404, 'User not found.');
  guardTarget(c, u);
  if (b.role === 'admin' && u.role !== 'admin' && !isSuper(c.user)) throw new HttpError(403, 'Only a super admin can promote someone to admin.');
  if (b.role !== undefined) {
    if (!['contributor', 'reviewer', 'admin'].includes(b.role)) throw bad('Unknown role.');
    if (id === c.user.id && b.role !== 'admin') throw bad('You cannot remove your own admin role.');
    run('UPDATE users SET role=? WHERE id=?', b.role, id);
  }
  if (b.review_blocked !== undefined) run('UPDATE users SET review_blocked=? WHERE id=?', b.review_blocked ? 1 : 0, id);
  if (b.native_speaker !== undefined) run('UPDATE users SET native_speaker=? WHERE id=?', b.native_speaker ? 1 : 0, id);
  c.json(200, { ok: true });
});
add('POST', '/api/admin/users/:id/temp-password', admin, async (c) => {
  const id = int(c.params.id);
  if (!get('SELECT 1 x FROM users WHERE id=?', id)) throw new HttpError(404, 'User not found.');
  const pw = crypto.randomBytes(6).toString('base64url');
  const salt = crypto.randomBytes(16).toString('hex');
  run('UPDATE users SET pw_hash=?, pw_salt=? WHERE id=?', await scrypt(pw, salt), salt, id);
  run('DELETE FROM sessions WHERE user_id=?', id);
  c.json(200, { password: pw });
});
add('DELETE', '/api/admin/users/:id', admin, (c) => {
  const id = int(c.params.id);
  if (id === c.user.id) throw bad('Use your profile page to delete your own account.');
  const target = get('SELECT * FROM users WHERE id=?', id);
  if (target) guardTarget(c, target);
  deleteUser(id);
  c.json(200, { ok: true });
});

// ---- export
const EXPORT_COLS = ['id', 'kind', 'english', 'gbari', 'gloss', 'dialect', 'village', 'category', 'prompt_id', 'source_entry_id', 'contributor_id', 'status', 'audio_file', 'audio_seconds', 'reviewer_ids', 'created_at'];
function exportRows() {
  return all(`SELECT e.*, (SELECT GROUP_CONCAT(r.reviewer_id,' ') FROM reviews r WHERE r.entry_id=e.id AND r.round=e.round AND r.verdict='correct') reviewers
    FROM entries e WHERE e.status='validated' ORDER BY e.id`).map((e) => ({
    id: e.id, kind: e.kind, english: e.english, gbari: e.gbari, gloss: e.gloss, dialect: e.dialect, village: e.village, category: e.category,
    prompt_id: e.prompt_id, source_entry_id: e.source_entry_id, contributor_id: e.contributor_id, status: e.status,
    audio_file: e.audio_file ? 'audio/' + e.audio_file : '', audio_seconds: e.audio_ms ? (e.audio_ms / 1000).toFixed(1) : '',
    reviewer_ids: e.reviewers, created_at: e.created_at, _file: e.audio_file,
  }));
}
const stamp = () => new Date().toISOString().slice(0, 10);
add('GET', '/api/admin/export.csv', admin, (c) => {
  c.res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="gbari-english-${stamp()}.csv"` });
  c.res.end(csv.stringify(EXPORT_COLS, exportRows()));
  c.handled = true;
});
add('GET', '/api/admin/export.zip', admin, async (c) => {
  const rows = exportRows();
  c.res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="gbari-english-dataset-${stamp()}.zip"` });
  const files = [{ name: 'metadata.csv', data: Buffer.from(csv.stringify(EXPORT_COLS, rows), 'utf8') }];
  for (const r of rows) if (r._file) files.push({ name: 'audio/' + r._file, path: path.join(AUDIO_DIR, path.basename(r._file)) });
  await streamZip(c.res, files);
  c.handled = true;
});

// ---------------------------------------------------------------- HTTP plumbing
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const staticCache = new Map();
function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return false;
  let st; try { st = fs.statSync(file); } catch { return false; }
  if (!st.isFile()) return false;
  let ent = staticCache.get(file);
  if (!ent || ent.mtime !== st.mtimeMs) {
    const buf = fs.readFileSync(file);
    ent = { mtime: st.mtimeMs, buf, gz: zlib.gzipSync(buf, { level: 9 }), etag: '"' + sha(buf).slice(0, 16) + '"' };
    staticCache.set(file, ent);
  }
  const type = TYPES[path.extname(file)] || 'application/octet-stream';
  const headers = { 'Content-Type': type, ETag: ent.etag, 'Cache-Control': rel === '/sw.js' || rel === '/index.html' ? 'no-cache' : 'public, max-age=300', Vary: 'Accept-Encoding' };
  if (req.headers['if-none-match'] === ent.etag) { res.writeHead(304, headers); res.end(); return true; }
  const gz = /\bgzip\b/.test(req.headers['accept-encoding'] || '') && /text|javascript|json|svg/.test(type);
  if (gz) headers['Content-Encoding'] = 'gzip';
  headers['Content-Length'] = (gz ? ent.gz : ent.buf).length;
  res.writeHead(200, headers); res.end(req.method === 'HEAD' ? undefined : gz ? ent.gz : ent.buf);
  return true;
}

const SECURITY = {
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'microphone=(self), camera=(), geolocation=()',
  'Content-Security-Policy': GOOGLE_CLIENT_ID
    ? "default-src 'self'; script-src 'self' https://accounts.google.com; frame-src https://accounts.google.com; connect-src 'self' https://accounts.google.com; img-src 'self' data:; style-src 'self' 'unsafe-inline' https://accounts.google.com; media-src 'self' blob:; base-uri 'none'; form-action 'self'"
    : "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; media-src 'self' blob:; base-uri 'none'; form-action 'self'",
};

const server = http.createServer(async (req, res) => {
  for (const [k, v] of Object.entries(SECURITY)) res.setHeader(k, v);
  const url = new URL(req.url, 'http://x');
  const ip = (TRUST_PROXY && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '';
  const send = (status, obj) => {
    const body = Buffer.from(JSON.stringify(obj));
    const gz = body.length > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    const out = gz ? zlib.gzipSync(body) : body;
    const h = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': out.length };
    if (gz) h['Content-Encoding'] = 'gzip';
    res.writeHead(status, h); res.end(out);
  };
  try {
    if (!url.pathname.startsWith('/api/')) {
      if ((req.method === 'GET' || req.method === 'HEAD') && serveStatic(req, res, decodeURIComponent(url.pathname))) return;
      if (req.method === 'GET' && !path.extname(url.pathname) && serveStatic(req, res, '/index.html')) return;
      return send(404, { error: 'Not found' });
    }
    let match = null, route = null;
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.re.exec(url.pathname);
      if (m) { match = m; route = r; break; }
    }
    if (!route) return send(404, { error: 'Not found' });
    // CSRF: browsers cannot add this header cross-site without a CORS preflight, which we never allow.
    if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'gv') throw new HttpError(403, 'Blocked request.');

    const c = {
      req, res, ip, query: url.searchParams, params: match.groups || {}, user: null, handled: false,
      json: (s, o) => send(s, o),
      body: async () => {
        const raw = await readBody(req, 100 * 1024);
        try { const j = raw.length ? JSON.parse(raw.toString('utf8')) : {}; return j && typeof j === 'object' ? j : {}; } catch { throw bad('Bad request.'); }
      },
    };
    const level = route.opts;
    if (level) {
      c.user = userByToken(parseCookies(req.headers.cookie).gv);
      if (!c.user) throw new HttpError(401, 'Please log in.', 'login');
      if (level !== 'session' && c.user.consent_version !== CFG.CONSENT_VERSION) throw new HttpError(403, 'Please read and accept the consent notice first.', 'consent');
      if (level === 'admin' && c.user.role !== 'admin') throw new HttpError(403, 'Admins only.');
    }
    await route.fn(c);
  } catch (e) {
    if (res.headersSent) { try { res.end(); } catch { /* ignore */ } return; }
    if (e instanceof HttpError) return send(e.status, { error: e.message, code: e.code });
    if (e && e.status === 400) return send(400, { error: e.message });
    console.error(e);
    send(500, { error: 'Something went wrong on our side. Please try again.' });
  }
});

// ---------------------------------------------------------------- startup
function seedPrompts() {
  if (get('SELECT COUNT(*) n FROM prompts').n > 0) return;
  const f = path.join(__dirname, 'sample', 'starter_prompts.csv');
  if (!fs.existsSync(f)) return;
  const rows = csv.parse(fs.readFileSync(f, 'utf8')).slice(1);
  tx(() => { for (const r of rows) if (r[0]) run('INSERT OR IGNORE INTO prompts(english,category) VALUES(?,?)', clean(r[0], 300), clean(r[1] || 'general', 60).toLowerCase()); });
  console.log(`Loaded ${rows.length} starter prompts.`);
}
seedPrompts();
syncAdmins();
setInterval(() => run('DELETE FROM sessions WHERE expires_at<?', Date.now()), 3600000).unref();

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`${CFG.APP_NAME} running on http://localhost:${PORT}`);
    console.log(`Data folder: ${DATA_DIR}  |  ffmpeg: ${HAS_FFMPEG ? 'found (audio stored as WebM/Opus)' : 'NOT found (audio stored as uploaded)'}`);
    console.log(`Admins: ${ADMIN_EMAILS.length ? ADMIN_EMAILS.join(', ') : 'none yet — set ADMIN_EMAILS'}`);
  });
}
module.exports = server;
