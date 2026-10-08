'use strict';
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const AUDIO_DIR = path.join(DATA_DIR, 'audio');
fs.mkdirSync(AUDIO_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'gbari.db'));
db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=NORMAL;');

db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY,
  email TEXT UNIQUE COLLATE NOCASE,
  google_sub TEXT UNIQUE,
  pw_hash TEXT, pw_salt TEXT,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'contributor',        -- contributor | reviewer | admin
  native_speaker INTEGER NOT NULL DEFAULT 0,
  home_dialect TEXT,
  review_blocked INTEGER NOT NULL DEFAULT 0,
  consent_at TEXT, consent_version INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions(
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS prompts(
  id INTEGER PRIMARY KEY,
  english TEXT NOT NULL,
  category TEXT NOT NULL,
  reading_only INTEGER NOT NULL DEFAULT 0,          -- 1 = has admin-supplied Gbari text; used only for "Read aloud"
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(english, category)
);
CREATE TABLE IF NOT EXISTS entries(
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,                               -- translation | recording | seed
  prompt_id INTEGER NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
  source_entry_id INTEGER REFERENCES entries(id) ON DELETE CASCADE,
  english TEXT NOT NULL,
  gbari TEXT NOT NULL,
  gbari_norm TEXT NOT NULL,
  gloss TEXT, dialect TEXT, village TEXT,
  category TEXT NOT NULL,
  audio_file TEXT, audio_mime TEXT, audio_ms INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',           -- pending | needs_fix | validated | rejected
  round INTEGER NOT NULL DEFAULT 1,
  contributor_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS reviews(
  id INTEGER PRIMARY KEY,
  entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  reviewer_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  round INTEGER NOT NULL,
  verdict TEXT NOT NULL,                            -- correct | needs_fix | reject
  fix_text TEXT, note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(entry_id, reviewer_id, round)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_trans ON entries(contributor_id, prompt_id) WHERE kind='translation';
CREATE UNIQUE INDEX IF NOT EXISTS ux_read  ON entries(contributor_id, source_entry_id) WHERE kind='recording';
CREATE INDEX IF NOT EXISTS ix_entries_prompt ON entries(prompt_id, kind, status);
CREATE INDEX IF NOT EXISTS ix_entries_status ON entries(status, kind);
CREATE INDEX IF NOT EXISTS ix_entries_user ON entries(contributor_id);
CREATE INDEX IF NOT EXISTS ix_entries_source ON entries(source_entry_id);
CREATE INDEX IF NOT EXISTS ix_reviews_entry ON reviews(entry_id);
CREATE INDEX IF NOT EXISTS ix_reviews_user ON reviews(reviewer_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_users_name ON users(lower(display_name));
`);

const cache = new Map();
const stmt = (sql) => {
  let s = cache.get(sql);
  if (!s) { s = db.prepare(sql); cache.set(sql, s); }
  return s;
};
const clean = (p) => p.map((v) => (v === undefined ? null : v));
const get = (sql, ...p) => stmt(sql).get(...clean(p));
const all = (sql, ...p) => stmt(sql).all(...clean(p));
const run = (sql, ...p) => stmt(sql).run(...clean(p));

function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

// Lower-case and strip tone marks/diacritics (and fold special letters like ɛ→e) so people can search with a plain keyboard.
const FOLD = { 'ɛ': 'e', 'ɔ': 'o', 'ɓ': 'b', 'ɗ': 'd', 'ŋ': 'ng', 'ɲ': 'ny', 'ʼ': '', '’': '', "'": '' };
const norm = (s) => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[ɛɔɓɗŋɲʼ’']/g, (c) => FOLD[c]).trim();

module.exports = { db, get, all, run, tx, norm, DATA_DIR, AUDIO_DIR };
