'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile, execFileSync } = require('child_process');
const { AUDIO_DIR } = require('./db');
const CFG = require('../config');

let HAS_FFMPEG = false;
try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); execFileSync('ffprobe', ['-version'], { stdio: 'ignore' }); HAS_FFMPEG = true; } catch { /* optional */ }

const MIME = { webm: 'audio/webm', ogg: 'audio/ogg', m4a: 'audio/mp4', wav: 'audio/wav', mp3: 'audio/mpeg', flac: 'audio/flac' };

// Identify the real file type from its first bytes. Never trust the file name or declared type.
function sniff(b) {
  if (b.length < 12) return null;
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'webm';
  if (b.toString('latin1', 0, 4) === 'OggS') return 'ogg';
  if (b.toString('latin1', 4, 8) === 'ftyp') return 'm4a';
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WAVE') return 'wav';
  if (b.toString('latin1', 0, 4) === 'fLaC') return 'flac';
  if (b.toString('latin1', 0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return 'mp3';
  return null;
}

const exec = (cmd, args, timeout = 30000) =>
  new Promise((resolve, reject) => execFile(cmd, args, { timeout }, (err, out) => (err ? reject(err) : resolve(out))));

class AudioError extends Error { constructor(m) { super(m); this.status = 400; } }

/**
 * Validate the upload is real audio and store it as compressed WebM/Opus when ffmpeg is present.
 * Returns { file, mime, ms } where file is the name inside AUDIO_DIR.
 */
async function storeAudio(buf, baseName) {
  const type = sniff(buf);
  if (!type) throw new AudioError('That file is not an audio file. Please record again or choose an audio file.');

  if (!HAS_FFMPEG) {
    const file = `${baseName}.${type}`;
    await fs.promises.writeFile(path.join(AUDIO_DIR, file), buf);
    return { file, mime: MIME[type], ms: null };
  }

  const tmpIn = path.join(os.tmpdir(), `gv_${crypto.randomBytes(8).toString('hex')}.in`);
  const file = `${baseName}.webm`;
  const tmpOut = path.join(AUDIO_DIR, `.tmp_${crypto.randomBytes(6).toString('hex')}.webm`);
  try {
    await fs.promises.writeFile(tmpIn, buf);
    await exec('ffmpeg', ['-nostdin', '-y', '-v', 'error', '-i', tmpIn, '-vn', '-t', String(CFG.MAX_AUDIO_SECONDS + 2),
      '-ac', '1', '-ar', '48000', '-c:a', 'libopus', '-b:a', '32k', tmpOut]);
    const out = await exec('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', tmpOut]);
    const secs = parseFloat(String(out).trim());
    if (!isFinite(secs) || secs < 0.5) throw new AudioError('That recording is too short. Please record the whole sentence.');
    if (secs > CFG.MAX_AUDIO_SECONDS + 0.7) throw new AudioError(`Recordings can be at most ${CFG.MAX_AUDIO_SECONDS} seconds.`);
    await fs.promises.rename(tmpOut, path.join(AUDIO_DIR, file));
    return { file, mime: 'audio/webm', ms: Math.round(secs * 1000) };
  } catch (e) {
    if (e instanceof AudioError) throw e;
    throw new AudioError('We could not read that audio. Please record again or choose a different file.');
  } finally {
    fs.promises.unlink(tmpIn).catch(() => {});
    fs.promises.unlink(tmpOut).catch(() => {});
  }
}

const removeFile = (name) => name && fs.promises.unlink(path.join(AUDIO_DIR, path.basename(name))).catch(() => {});

module.exports = { storeAudio, removeFile, HAS_FFMPEG };
