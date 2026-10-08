'use strict';
(() => {
  // ------------------------------------------------------------ tiny toolkit
  const S = { cfg: null, user: null, cleanups: [] };
  const GV = (window.GV = { S });

  function add(el, kids) {
    for (const k of kids.flat(Infinity)) {
      if (k === null || k === undefined || k === false) continue;
      el.append(k instanceof Node ? k : document.createTextNode(String(k)));
    }
  }
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    let value;
    for (const [k, v] of Object.entries(props || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'value') value = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    add(el, kids);
    if (value !== undefined) el.value = value;
    return el;
  }
  const ICONS = {
    mic: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 15a3.5 3.5 0 0 0 3.5-3.5v-6a3.5 3.5 0 0 0-7 0v6A3.5 3.5 0 0 0 12 15zm6-3.5a1 1 0 1 0-2 0 4 4 0 0 1-8 0 1 1 0 1 0-2 0 6 6 0 0 0 5 5.91V20H9a1 1 0 1 0 0 2h6a1 1 0 1 0 0-2h-2v-2.59A6 6 0 0 0 18 11.5z"/></svg>',
    stop: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
    play: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
    pause: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M7 5h4v14H7zm6 0h4v14h-4z"/></svg>',
    write: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
    user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>',
    shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/></svg>',
  };
  const icon = (n) => { const s = document.createElement('span'); s.style.display = 'inline-flex'; s.innerHTML = ICONS[n]; return s; }; // constant strings only

  let toastTimer;
  function toast(msg, err) {
    const t = document.getElementById('toast');
    t.textContent = msg; t.className = 'show' + (err ? ' err' : '');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.className = ''), err ? 5000 : 2800);
  }

  async function api(path, o = {}) {
    const init = { method: o.method || 'GET', credentials: 'same-origin', headers: { 'X-Requested-With': 'gv', ...(o.headers || {}) } };
    if (o.json !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(o.json); }
    if (o.raw) { init.headers['Content-Type'] = o.type; init.body = o.raw; }
    let r;
    try { r = await fetch(path, init); } catch { throw Object.assign(new Error('No connection. Check your data or Wi-Fi and try again.'), { offline: true }); }
    const text = await r.text();
    let data = null; try { data = text ? JSON.parse(text) : null; } catch { /* not json */ }
    if (!r.ok) {
      const e = new Error((data && data.error) || 'Something went wrong. Please try again.');
      e.status = r.status; e.code = data && data.code; e.data = data;
      if (r.status === 401 && S.user && path !== '/api/me') { S.user = null; location.hash = '#/login'; }
      if (e.code === 'consent' && S.user) { S.user.consent_ok = false; location.hash = '#/consent'; }
      throw e;
    }
    return data;
  }
  const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
  const wa = (msg) => `https://wa.me/${S.cfg.whatsappIntl}?text=${encodeURIComponent(msg)}`;
  const busy = async (btn, fn) => {
    const label = btn.textContent; btn.disabled = true; btn.textContent = 'Please wait…';
    try { return await fn(); } finally { btn.disabled = false; btn.textContent = label; }
  };
  const navTo = (hash) => { if (location.hash === hash) route(); else location.hash = hash; };
  Object.assign(GV, { h, add, api, toast, icon, cap, wa, busy });

  // ------------------------------------------------------------ shared audio player
  const player = new Audio(); player.preload = 'none';
  let playingBtn = null;
  function resetPlayBtn() { if (playingBtn) { playingBtn.setAttribute('aria-pressed', 'false'); playingBtn.replaceChildren(icon('play'), ' Listen'); playingBtn = null; } }
  player.addEventListener('ended', resetPlayBtn);
  player.addEventListener('error', () => { if (playingBtn) toast('Could not play this recording.', true); resetPlayBtn(); });
  function PlayButton(entryId) {
    const b = h('button', { type: 'button', class: 'play', 'aria-pressed': 'false' }, icon('play'), ' Listen');
    b.addEventListener('click', () => {
      if (playingBtn === b) { player.pause(); resetPlayBtn(); return; }
      resetPlayBtn(); player.pause();
      player.src = `/api/audio/${entryId}`; player.play().catch(() => {});
      playingBtn = b; b.setAttribute('aria-pressed', 'true'); b.replaceChildren(icon('pause'), ' Stop');
    });
    return b;
  }
  Object.assign(GV, { PlayButton });

  // ------------------------------------------------------------ keypad for Gbari letters + tone marks
  function Keypad(getTarget) {
    const wrap = h('div', { class: 'keypad', role: 'group', 'aria-label': 'Gbari letters and tone marks' });
    let upper = false; const letterBtns = [];
    const insert = (s) => {
      const el = getTarget(); if (!el) return;
      const a = el.selectionStart ?? el.value.length, b = el.selectionEnd ?? a;
      el.setRangeText(s, a, b, 'end'); el.focus(); el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const key = (label, title, fn, cls) => {
      const b = h('button', { type: 'button', class: 'key ' + (cls || ''), title, 'aria-label': title, onpointerdown: (e) => e.preventDefault(), onclick: fn }, label);
      return b;
    };
    for (const ch of S.cfg.keypadLetters) {
      const b = key(ch, `Letter ${ch}`, () => insert(upper ? ch.toLocaleUpperCase() : ch));
      b.dataset.ch = ch; letterBtns.push(b); wrap.append(b);
    }
    const shift = key('Aa', 'Capital letters', () => {
      upper = !upper; shift.setAttribute('aria-pressed', String(upper));
      for (const b of letterBtns) b.textContent = upper ? b.dataset.ch.toLocaleUpperCase() : b.dataset.ch;
    }, 'shift');
    shift.setAttribute('aria-pressed', 'false'); wrap.append(shift);
    for (const t of S.cfg.keypadTones) wrap.append(key('\u25CC' + t.mark, t.name + ' – goes on the letter before the cursor', () => insert(t.mark), 'tone'));
    return wrap;
  }
  Object.assign(GV, { Keypad });

  // ------------------------------------------------------------ voice recorder (record, play back, re-record, upload audio file)
  function Recorder(onChange) {
    const MAX = S.cfg.maxSeconds;
    const canRec = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
    const mime = canRec ? ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'].find((t) => MediaRecorder.isTypeSupported(t)) : null;
    const root = h('div', { class: 'rec' });
    const r = { el: root, blob: null, ms: 0, reset, destroy };
    let state = 'idle', stream, mr, chunks = [], t0 = 0, tick, ctx, raf, url, err = '', timerEl, levelEl;

    function setBlob(b, ms) { r.blob = b; r.ms = ms; if (onChange) onChange(); }
    function stopStream() {
      cancelAnimationFrame(raf); clearInterval(tick);
      if (stream) stream.getTracks().forEach((t) => t.stop());
      if (ctx) { ctx.close().catch(() => {}); ctx = null; }
      stream = null;
    }
    function setUrl(b) { if (url) URL.revokeObjectURL(url); url = b ? URL.createObjectURL(b) : null; }
    function reset() { stopStream(); setUrl(null); state = 'idle'; err = ''; setBlob(null, 0); draw(); }
    function destroy() { try { if (mr && mr.state === 'recording') { mr.onstop = null; mr.stop(); } } catch { /* ignore */ } stopStream(); setUrl(null); }

    async function start() {
      err = '';
      if (!window.isSecureContext) { err = 'Recording needs a secure (https) connection. You can upload an audio file instead.'; return draw(); }
      try { stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } }); }
      catch (e) {
        err = e.name === 'NotAllowedError' || e.name === 'SecurityError' ? 'The microphone is blocked. Allow it in your browser settings, or upload an audio file instead.'
          : e.name === 'NotFoundError' ? 'No microphone found. You can upload an audio file instead.' : 'Could not start the microphone. You can upload an audio file instead.';
        return draw();
      }
      chunks = [];
      try { mr = mime ? new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 32000 }) : new MediaRecorder(stream); }
      catch { stopStream(); err = 'This browser cannot record audio. Please upload an audio file instead.'; return draw(); }
      mr.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      mr.onstop = () => {
        const ms = Math.min(Date.now() - t0, MAX * 1000);
        const type = mr.mimeType || mime || 'audio/webm';
        stopStream();
        const b = new Blob(chunks, { type });
        if (ms < 700 || !b.size) { err = 'That was very short. Please record the whole sentence.'; state = 'idle'; setBlob(null, 0); return draw(); }
        setUrl(b); setBlob(b, ms); state = 'ready'; draw();
      };
      t0 = Date.now(); mr.start(); state = 'recording'; draw();
      tick = setInterval(() => {
        const s = (Date.now() - t0) / 1000;
        if (timerEl) timerEl.textContent = `${fmt(s)} / ${fmt(MAX)}`;
        if (s >= MAX && mr.state === 'recording') mr.stop();
      }, 200);
      try { // level meter (non-essential)
        ctx = new (window.AudioContext || window.webkitAudioContext)();
        const an = ctx.createAnalyser(); an.fftSize = 256; ctx.createMediaStreamSource(stream).connect(an);
        const buf = new Uint8Array(an.fftSize);
        const loop = () => {
          an.getByteTimeDomainData(buf); let m = 0; for (const v of buf) m = Math.max(m, Math.abs(v - 128));
          if (levelEl) levelEl.style.width = Math.min(100, (m / 128) * 160) + '%';
          raf = requestAnimationFrame(loop);
        }; loop();
      } catch { /* ignore */ }
    }
    const fmt = (s) => `0:${String(Math.floor(s)).padStart(2, '0')}`;
    function stop() { if (mr && mr.state === 'recording') mr.stop(); }

    function durationOf(file) {
      return new Promise((ok) => {
        const a = new Audio(), u = URL.createObjectURL(file); let done = false;
        const fin = (v) => { if (done) return; done = true; URL.revokeObjectURL(u); ok(v); };
        a.preload = 'metadata'; a.onloadedmetadata = () => fin(a.duration); a.onerror = () => fin(NaN); setTimeout(() => fin(NaN), 4000); a.src = u;
      });
    }
    async function pick(file) {
      err = '';
      if (!file) return;
      const okType = file.type.startsWith('audio/') || (file.type === '' && /\.(webm|ogg|oga|opus|m4a|aac|wav|mp3|flac|amr)$/i.test(file.name));
      if (!okType) { err = 'That is not an audio file. Please choose a sound recording (not a photo, video or document).'; return draw(); }
      if (file.size > S.cfg.maxUploadBytes) { err = `That file is too big (max ${Math.round(S.cfg.maxUploadBytes / 1048576)} MB).`; return draw(); }
      const d = await durationOf(file);
      if (isFinite(d) && d > MAX + 0.5) { err = `That recording is ${Math.round(d)} seconds long. The limit is ${MAX} seconds.`; return draw(); }
      const b = file.type ? file : new Blob([file], { type: 'audio/mpeg' });
      setUrl(b); setBlob(b, isFinite(d) ? Math.round(d * 1000) : 0); state = 'ready'; draw();
    }
    const uploadLabel = () => h('label', { class: 'btn ghost sm', style: 'cursor:pointer' }, 'Upload an audio file instead',
      h('input', { type: 'file', accept: 'audio/*', class: 'visually-hidden', onchange: (e) => { pick(e.target.files[0]); e.target.value = ''; } }));

    function draw() {
      timerEl = levelEl = null;
      const kids = [];
      if (state === 'idle') {
        kids.push(h('div', { class: 'row' },
          canRec ? h('button', { type: 'button', class: 'mic', 'aria-label': 'Start recording', onclick: start }, icon('mic')) : null,
          h('div', { class: 'grow' },
            h('strong', {}, canRec ? 'Record your voice' : 'Add your voice'),
            h('div', { class: 'small muted' }, `Say the Gbari sentence clearly, up to ${MAX} seconds. Find a quiet place.`))));
        kids.push(h('div', { style: 'margin-top:10px' }, uploadLabel()));
      } else if (state === 'recording') {
        timerEl = h('span', { class: 'timer' }, `0:00 / ${fmt(MAX)}`);
        levelEl = h('i');
        kids.push(h('div', { class: 'row' },
          h('button', { type: 'button', class: 'mic live', 'aria-label': 'Stop recording', onclick: stop }, icon('stop')),
          h('div', { class: 'grow' }, h('strong', {}, 'Recording… ', timerEl), h('div', { class: 'level', style: 'margin-top:8px' }, levelEl), h('div', { class: 'small muted' }, 'Tap the red button when you finish.'))));
      } else {
        kids.push(h('audio', { controls: true, src: url, preload: 'metadata' }));
        kids.push(h('div', { class: 'row wrap', style: 'margin-top:10px' },
          h('button', { type: 'button', class: 'btn ghost sm', onclick: () => { reset(); if (canRec) start(); } }, canRec ? 'Record again' : 'Choose another'),
          h('button', { type: 'button', class: 'btn ghost sm danger', onclick: reset }, 'Remove'),
          h('span', { class: 'small muted' }, r.ms ? `${(r.ms / 1000).toFixed(1)} s` : '')));
      }
      if (err) kids.push(h('div', { class: 'note bad small', role: 'alert', style: 'margin-top:10px' }, err));
      root.replaceChildren(...kids);
    }
    draw();
    S.cleanups.push(destroy);
    return r;
  }
  Object.assign(GV, { Recorder });

  // ------------------------------------------------------------ searchable dropdown
  function Combobox({ label, placeholder, fetchItems, onPick }) {
    const id = 'cb' + Math.random().toString(36).slice(2, 7);
    const input = h('input', { type: 'search', id, role: 'combobox', 'aria-expanded': 'false', 'aria-controls': id + '-l', 'aria-autocomplete': 'list', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', placeholder });
    const list = h('ul', { class: 'cb-list', id: id + '-l', role: 'listbox', hidden: true });
    const el = h('div', { class: 'field' }, h('label', { class: 'f', for: id }, label), h('div', { class: 'cb' }, input, list));
    let items = [], active = -1, timer, seq = 0, picked = '';
    const open = (v) => { list.hidden = !v; input.setAttribute('aria-expanded', String(v)); };
    async function load() {
      const my = ++seq;
      const query = input.value === picked ? '' : input.value.trim(); // right after picking, show the full list again
      list.replaceChildren(h('li', { class: 'empty' }, h('span', { class: 'spin' }), ' Searching…')); open(true);
      try { items = await fetchItems(query); } catch (e) { items = null; list.replaceChildren(h('li', { class: 'empty' }, e.message)); return; }
      if (my !== seq) return;
      active = -1; draw();
    }
    function draw() {
      if (!items.length) { list.replaceChildren(h('li', { class: 'empty' }, 'No phrases match. Try a different word.')); return; }
      list.replaceChildren(...items.map((it, i) => {
        const disabled = it.full || it.mine;
        return h('li', { role: 'option', 'aria-selected': String(i === active), 'aria-disabled': disabled ? 'true' : null, onpointerdown: (e) => e.preventDefault(), onclick: () => choose(it) },
          h('span', {}, it.english),
          it.full ? h('span', { class: 'badge full' }, 'Full') : it.mine ? h('span', { class: 'badge done' }, 'Done') : h('span', { class: 'badge' }, `${it.approved}/${S.cfg.cap}`));
      }));
    }
    function choose(it) { input.value = picked = it.english; open(false); input.blur(); onPick(it); }
    input.addEventListener('focus', () => { input.select(); load(); });
    input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 220); });
    input.addEventListener('blur', () => setTimeout(() => open(false), 120));
    input.addEventListener('keydown', (e) => {
      if (list.hidden || !items || !items.length) return;
      if (e.key === 'ArrowDown') { active = Math.min(items.length - 1, active + 1); draw(); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { active = Math.max(0, active - 1); draw(); e.preventDefault(); }
      else if (e.key === 'Enter' && active >= 0) { choose(items[active]); e.preventDefault(); }
      else if (e.key === 'Escape') open(false);
    });
    return { el, input, set: (v) => (input.value = picked = v) };
  }

  // ------------------------------------------------------------ shared pieces
  const lastPref = (k, v) => { try { if (v === undefined) return localStorage.getItem('gv_' + k) || ''; localStorage.setItem('gv_' + k, v); } catch { return ''; } };
  function dialectSelect(selected) {
    const sel = h('select', { id: 'dialect' }, h('option', { value: '' }, 'Choose…'), S.cfg.dialects.map((d) => h('option', { value: d }, d)));
    sel.value = selected || '';
    return sel;
  }
  function thanks({ title, text, again, againLabel, ctx }) {
    const msg = `Hello ${S.cfg.appName} team, I just submitted a contribution${ctx ? ` (${ctx})` : ''}. `;
    return h('div', { class: 'card stack' },
      h('h2', {}, title || 'Thank you!'),
      h('p', {}, text || 'Your entry is saved. A reviewer will check it soon, and you will see its status on your profile.'),
      h('button', { class: 'btn block', type: 'button', onclick: again }, againLabel || 'Add another'),
      h('hr'),
      h('div', { class: 'note info' }, h('strong', {}, 'Need help or have a question?'),
        h('p', { class: 'small', style: 'margin:4px 0 10px' }, `Contact us on WhatsApp: ${S.cfg.whatsappDisplay}. Tell us about a problem, ask about becoming a reviewer, or share ideas.`),
        h('a', { class: 'btn wa block', href: wa(msg), target: '_blank', rel: 'noopener' }, 'Contact us on WhatsApp')));
  }
  Object.assign(GV, { dialectSelect, lastPref, thanks });

  // ------------------------------------------------------------ views
  const view = {};

  // ---- login / sign up
  view.login = (app) => {
    let mode = 'signup';
    const tiles = [...S.cfg.keypadLetters.slice(0, 5), ...S.cfg.keypadTones.slice(0, 3).map((t) => '\u25CC' + t.mark)];
    const form = h('div');
    const draw = () => {
      const err = h('div', { class: 'note bad small', role: 'alert', hidden: true });
      const name = h('input', { type: 'text', id: 'dn', autocomplete: 'nickname', maxlength: 30, placeholder: 'e.g. Ada' });
      const email = h('input', { type: 'email', id: 'em', autocomplete: 'email', inputmode: 'email' });
      const pw = h('input', { type: 'password', id: 'pw', autocomplete: mode === 'signup' ? 'new-password' : 'current-password', minlength: 8 });
      const native = h('input', { type: 'checkbox', id: 'nat' });
      const go = h('button', { class: 'btn block', type: 'submit' }, mode === 'signup' ? 'Create my account' : 'Log in');
      const f = h('form', { class: 'stack', novalidate: true, onsubmit: async (e) => {
        e.preventDefault(); err.hidden = true;
        try {
          S.user = await busy(go, () => api(mode === 'signup' ? '/api/signup' : '/api/login', { method: 'POST', json: { display_name: name.value, email: email.value, password: pw.value, native_speaker: native.checked } }));
          navTo(S.user.consent_ok ? '#/contribute' : '#/consent');
        } catch (ex) { err.textContent = ex.message; err.hidden = false; }
      } },
        mode === 'signup' ? h('div', { class: 'field' }, h('label', { class: 'f', for: 'dn' }, 'Display name', h('span', { class: 'hint' }, 'Shown on the leaderboard. Do not use your email or full name if you prefer privacy.')), name) : null,
        h('div', { class: 'field' }, h('label', { class: 'f', for: 'em' }, 'Email', h('span', { class: 'hint' }, 'Never shown to anyone else.')), email),
        h('div', { class: 'field' }, h('label', { class: 'f', for: 'pw' }, 'Password', mode === 'signup' ? h('span', { class: 'hint' }, 'At least 8 characters.') : null), pw),
        mode === 'signup' ? h('label', { class: 'check', for: 'nat' }, native, h('span', {}, 'I grew up speaking Gbari', h('span', { class: 'hint' }, `Native speakers can become reviewers after ${S.cfg.reviewerMin} approved contributions.`))) : null,
        err, go);
      const kids = [f];
      if (S.cfg.googleClientId) { kids.push(h('div', { class: 'center muted small', style: 'margin:12px 0 8px' }, 'or'), h('div', { id: 'gbtn', style: 'display:flex;justify-content:center;min-height:44px' })); loadGoogle(); }
      form.replaceChildren(...kids);
    };
    app.append(
      h('div', { class: 'tiles', 'aria-hidden': 'true' }, tiles.map((t) => h('div', { class: 'tile' }, t))),
      h('h1', {}, S.cfg.appName),
      h('p', {}, S.cfg.tagline, ' Type a phrase in Gbari, say it aloud, and help build tools that understand our language.'),
      h('div', { class: 'seg', role: 'group' },
        h('button', { type: 'button', 'aria-pressed': 'true', onclick: (e) => sw('signup', e) }, 'Create account'),
        h('button', { type: 'button', 'aria-pressed': 'false', onclick: (e) => sw('login', e) }, 'Log in')),
      h('div', { class: 'card' }, form));
    function sw(m, e) { mode = m; e.target.parentNode.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === e.target))); draw(); }
    draw();
  };
  function loadGoogle() {
    const init = () => {
      window.google.accounts.id.initialize({ client_id: S.cfg.googleClientId, callback: async (resp) => {
        try { S.user = await api('/api/google', { method: 'POST', json: { credential: resp.credential } }); navTo(S.user.consent_ok ? '#/contribute' : '#/consent'); }
        catch (ex) { toast(ex.message, true); }
      } });
      const b = document.getElementById('gbtn'); if (b) window.google.accounts.id.renderButton(b, { theme: 'outline', size: 'large', width: 280, text: 'continue_with' });
    };
    if (window.google && window.google.accounts) return init();
    if (document.getElementById('gsi')) return;
    const s = h('script', { src: 'https://accounts.google.com/gsi/client', id: 'gsi', async: true, defer: true }); s.onload = init; document.head.append(s);
  }

  // ---- consent
  view.consent = (app) => {
    const agree = h('input', { type: 'checkbox', id: 'ag' });
    const go = h('button', { class: 'btn block', type: 'button', disabled: true, onclick: () => busy(go, async () => {
      try { S.user = await api('/api/consent', { method: 'POST', json: { agree: true } }); navTo('#/contribute'); } catch (e) { toast(e.message, true); }
    }) }, 'I agree and continue');
    agree.addEventListener('change', () => (go.disabled = !agree.checked));
    app.append(h('div', { class: 'card stack' },
      h('h1', {}, 'Before you start'),
      h('p', {}, 'Please read how your text and voice will be used and stored.'),
      h('ul', { style: 'padding-left:20px;margin:0' }, S.cfg.consentPoints.map((p) => {
        const i = p.indexOf(':');
        return h('li', { style: 'margin-bottom:10px' }, i > 0 && i < 40 ? [h('strong', {}, p.slice(0, i + 1)), p.slice(i + 1)] : p);
      })),
      h('label', { class: 'check', for: 'ag' }, agree, h('span', {}, 'I have read this and I agree that my text and voice recordings may be used in this way.')),
      go,
      h('button', { class: 'linkish', type: 'button', onclick: logout }, 'No thanks, log me out')));
  };

  // ---- contribute
  let contribMode = 'translate';
  view.contribute = (app) => {
    const body = h('div');
    const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Mode' },
      ['translate', 'read'].map((m) => h('button', { type: 'button', 'aria-pressed': String(m === contribMode), onclick: () => { contribMode = m; seg.querySelectorAll('button').forEach((b, i) => b.setAttribute('aria-pressed', String(['translate', 'read'][i] === m))); runCleanups(); m === 'translate' ? translate(body) : readAloud(body); } },
        m === 'translate' ? 'Translate' : 'Read aloud')));
    app.append(h('h1', {}, 'Contribute'), seg, body);
    contribMode === 'translate' ? translate(body) : readAloud(body);
  };

  function translate(root) {
    root.replaceChildren();
    let prompt = null, createdId = null;
    const catSel = h('select', { id: 'cat', 'aria-label': 'Category' }, h('option', { value: '' }, 'All categories'));
    const info = h('div', { 'aria-live': 'polite' });
    const formBox = h('div');
    const cb = Combobox({
      label: 'Phrase to translate', placeholder: 'Search a word or phrase…',
      fetchItems: (q) => api(`/api/prompts?category=${encodeURIComponent(catSel.value)}&q=${encodeURIComponent(q)}`),
      onPick: (p) => showPrompt(p.id),
    });
    let pseq = 0; // guards against a slow response overwriting a phrase the person picked meanwhile
    const skip = h('button', { class: 'btn ghost block', type: 'button', onclick: async () => {
      const mark = pseq;
      try { const n = await api(`/api/prompts/next?category=${encodeURIComponent(catSel.value)}&exclude=${prompt ? prompt.id : 0}`); if (mark !== pseq) return; if (!n) { toast('No more phrases here. Try another category.'); return; } cb.set(n.english); showPrompt(n.id); } catch (e) { toast(e.message, true); }
    } }, 'Skip – show me another phrase');
    root.append(
      h('div', { class: 'card' },
        h('div', { class: 'field' }, h('label', { class: 'f', for: 'cat' }, 'Category'), catSel),
        cb.el, skip),
      info, formBox);
    api('/api/categories').then((cs) => { catSel.append(cs.map((c) => h('option', { value: c.category }, `${cap(c.category)} (${c.n})`))); }).catch(() => {});
    catSel.addEventListener('change', () => { cb.set(''); prompt = null; info.replaceChildren(); formBox.replaceChildren(); skip.click(); });
    skip.click(); // start with one phrase on screen

    async function showPrompt(id) {
      const my = ++pseq;
      info.replaceChildren(h('p', { class: 'center' }, h('span', { class: 'spin' }))); formBox.replaceChildren(); createdId = null;
      let p; try { p = await api(`/api/prompts/${id}`); } catch (e) { if (my === pseq) info.replaceChildren(h('div', { class: 'note bad' }, e.message)); return; }
      if (my !== pseq) return;
      prompt = p;
      const left = Math.max(0, S.cfg.cap - prompt.approved);
      if (prompt.full) {
        info.replaceChildren(h('div', { class: 'note bad', role: 'alert' }, h('strong', {}, `This phrase has ${prompt.approved} approved contributions.`), h('p', { style: 'margin:4px 0 0' }, 'It is complete. Please select another word or phrase.')));
        return;
      }
      if (prompt.mine) { info.replaceChildren(h('div', { class: 'note warn' }, 'You have already translated this phrase. Please select another word or phrase.')); return; }
      info.replaceChildren(h('div', { class: 'note info' },
        h('strong', {}, `${prompt.approved} of ${S.cfg.cap} contributions approved`), ` for this phrase. ${left} more ${left === 1 ? 'is' : 'are'} needed.`,
        h('div', { class: 'meter', 'aria-hidden': 'true' }, h('i', { style: `width:${(prompt.approved / S.cfg.cap) * 100}%` }))));
      drawForm();
    }

    function drawForm() {
      const gb = h('textarea', { id: 'gb', class: 'gbari-input', lang: 'gby', rows: 2, maxlength: 500, autocapitalize: 'sentences', spellcheck: 'false', placeholder: 'Write it in Gbari' });
      const gl = h('textarea', { id: 'gl', rows: 2, maxlength: 500, placeholder: 'e.g. I – go – farm' });
      const dia = dialectSelect(lastPref('dialect'));
      const vil = h('input', { type: 'text', id: 'vil', maxlength: 80, value: lastPref('village'), placeholder: 'e.g. Paiko' });
      const rec = Recorder();
      const err = h('div', { class: 'note bad small', role: 'alert', hidden: true });
      const go = h('button', { class: 'btn block', type: 'button' }, 'Submit for review');
      go.addEventListener('click', () => busy(go, async () => {
        err.hidden = true;
        const fail = (m) => { err.textContent = m; err.hidden = false; err.scrollIntoView({ block: 'center', behavior: 'smooth' }); };
        if (!gb.value.trim()) return fail('Write the Gbari sentence.');
        if (!gl.value.trim()) return fail('Add the word-for-word English gloss.');
        if (!dia.value) return fail('Choose a dialect, or "Not sure".');
        if (S.cfg.requireAudio && !rec.blob) return fail('Please record your voice or upload an audio file.');
        try {
          if (!createdId) createdId = (await api('/api/entries', { method: 'POST', json: { prompt_id: prompt.id, gbari: gb.value, gloss: gl.value, dialect: dia.value, village: vil.value } })).id;
          if (rec.blob) await api(`/api/entries/${createdId}/audio`, { method: 'PUT', raw: rec.blob, type: rec.blob.type || 'audio/webm', headers: { 'X-Duration-Ms': String(rec.ms) } });
        } catch (e) {
          if (e.code === 'full' || e.code === 'mine') { toast(e.message, true); return showPrompt(prompt.id); }
          return fail(createdId ? `Your text is saved, but the recording did not upload: ${e.message} Tap Submit to try the recording again.` : e.message);
        }
        lastPref('dialect', dia.value); lastPref('village', vil.value);
        runCleanups(); root.replaceChildren(thanks({ again: () => translate(root), againLabel: 'Translate another phrase', ctx: `phrase: "${prompt.english}"` }));
        window.scrollTo(0, 0);
      }));
      formBox.replaceChildren(h('div', { class: 'card stack' },
        h('div', {}, h('div', { class: 'small muted' }, 'Translate this into Gbari'), h('p', { class: 'phrase' }, prompt.english)),
        h('div', { class: 'field' }, h('label', { class: 'f', for: 'gb' }, 'Gbari sentence', h('span', { class: 'hint' }, 'Use the keys below for special letters. Tap a tone mark after a letter to put it on that letter.')), gb, Keypad(() => gb)),
        h('div', { class: 'field' }, h('label', { class: 'f', for: 'gl' }, 'Word-for-word English gloss', h('span', { class: 'hint' }, 'Write the English meaning of each Gbari word, in the same order.')), gl),
        h('div', { class: 'field' }, h('label', { class: 'f', for: 'dialect' }, 'Dialect'), dia),
        h('div', { class: 'field' }, h('label', { class: 'f', for: 'vil' }, 'Village or town ', h('span', { class: 'muted' }, '(optional)')), vil),
        h('div', { class: 'field' }, h('div', { class: 'f' }, 'Your voice', S.cfg.requireAudio ? '' : h('span', { class: 'muted' }, ' (strongly encouraged)')), rec.el),
        err, go));
    }
  }

  function readAloud(root) {
    root.replaceChildren();
    const skipped = []; let current = null;
    const box = h('div'); root.append(box);
    load();
    async function load() {
      box.replaceChildren(h('p', { class: 'center' }, h('span', { class: 'spin' })));
      let item;
      try { item = await api(`/api/read/next?skip=${skipped.join(',')}`); } catch (e) { box.replaceChildren(h('div', { class: 'note bad' }, e.message)); return; }
      current = item;
      if (!item) { box.replaceChildren(h('div', { class: 'card stack' }, h('h2', {}, 'Nothing to read right now'), h('p', {}, 'There are no approved Gbari texts waiting for a recording. Try "Translate a phrase", or check back soon.'), skipped.length ? h('button', { class: 'btn ghost', onclick: () => { skipped.length = 0; load(); } }, 'Show skipped texts again') : null)); return; }
      const dia = dialectSelect(lastPref('dialect'));
      const vil = h('input', { type: 'text', id: 'vil', maxlength: 80, value: lastPref('village'), placeholder: 'e.g. Paiko' });
      const rec = Recorder();
      const err = h('div', { class: 'note bad small', role: 'alert', hidden: true });
      const go = h('button', { class: 'btn block', type: 'button' }, 'Submit recording');
      go.addEventListener('click', () => busy(go, async () => {
        err.hidden = true;
        const fail = (m) => { err.textContent = m; err.hidden = false; };
        if (!rec.blob) return fail('Please record yourself reading the text.');
        if (!dia.value) return fail('Choose your dialect, or "Not sure".');
        try {
          const { id } = await api('/api/entries/read', { method: 'POST', json: { source_entry_id: item.id, dialect: dia.value, village: vil.value } });
          await api(`/api/entries/${id}/audio`, { method: 'PUT', raw: rec.blob, type: rec.blob.type || 'audio/webm', headers: { 'X-Duration-Ms': String(rec.ms) } });
        } catch (e) { return fail(e.message); }
        lastPref('dialect', dia.value); lastPref('village', vil.value); runCleanups();
        root.replaceChildren(thanks({ again: () => readAloud(root), againLabel: 'Read another text', text: 'Your recording is saved. A reviewer will check that it matches the text.', ctx: 'a read-aloud recording' }));
      }));
      box.replaceChildren(h('div', { class: 'card stack' },
        h('div', {}, h('div', { class: 'small muted' }, 'Read this aloud in Gbari'), h('p', { class: 'gbari phrase', lang: 'gby' }, item.gbari), h('div', { class: 'small muted' }, `Meaning: ${item.english}`)),
        h('div', { class: 'field' }, h('label', { class: 'f', for: 'dialect' }, 'Your dialect'), dia),
        h('div', { class: 'field' }, h('label', { class: 'f', for: 'vil' }, 'Village or town ', h('span', { class: 'muted' }, '(optional)')), vil),
        h('div', { class: 'field' }, h('div', { class: 'f' }, 'Your voice'), rec.el),
        err, go,
        h('button', { class: 'btn ghost block', type: 'button', onclick: () => { skipped.push(item.id); runCleanups(); load(); } }, 'Skip this text')));
    }
  }

  // ---- review
  view.review = async (app) => {
    app.append(h('h1', {}, 'Review'));
    const box = h('div'); app.append(box);
    const me = S.user.reviewer;
    if (!me.eligible) {
      const pct = Math.min(100, Math.round((me.approved / me.needed) * 100));
      const nat = h('button', { class: 'btn ghost sm', type: 'button', onclick: async () => { try { S.user = await api('/api/me', { method: 'PATCH', json: { native_speaker: true } }); route(); } catch (e) { toast(e.message, true); } } }, 'I am a native Gbari speaker');
      box.append(h('div', { class: 'card stack' },
        me.blocked ? h('div', { class: 'note bad' }, 'Reviewing has been turned off for your account. Contact us on WhatsApp if you think this is a mistake.') : h('p', {}, 'Reviewing keeps the dataset accurate. It unlocks automatically when you meet these conditions:'),
        h('div', {}, h('strong', {}, `${me.approved} of ${me.needed} approved contributions`), h('div', { class: 'meter' }, h('i', { style: `width:${pct}%` }))),
        me.needsNative ? h('div', {}, h('strong', {}, me.isNative ? '✓ You told us you are a native speaker' : 'Native speaker: not yet confirmed'), me.isNative ? null : h('div', { style: 'margin-top:8px' }, nat)) : null,
        h('a', { class: 'btn ghost', href: '#/contribute' }, 'Keep contributing'),
        h('a', { class: 'small', href: wa('Hello, I would like to become a reviewer on ' + S.cfg.appName + '.'), target: '_blank', rel: 'noopener' }, 'Ask us about becoming a reviewer on WhatsApp')));
      return;
    }
    const skipped = [];
    const next = async () => {
      runCleanups(); resetPlayBtn(); player.pause();
      box.replaceChildren(h('p', { class: 'center' }, h('span', { class: 'spin' })));
      let r; try { r = await api(`/api/review/next?skip=${skipped.join(',')}`); } catch (e) { box.replaceChildren(h('div', { class: 'note bad' }, e.message)); return; }
      if (!r.entry) { box.replaceChildren(h('div', { class: 'card stack center' }, h('h2', {}, 'All caught up'), h('p', {}, 'There is nothing waiting for your review right now. Thank you!'), skipped.length ? h('button', { class: 'btn ghost', onclick: () => { skipped.length = 0; next(); } }, 'Show skipped entries again') : null)); return; }
      box.replaceChildren(reviewCard(r.entry, r.remaining, next, skipped));
    };
    next();
  };

  function reviewCard(e, remaining, next, skipped) {
    const isRec = e.kind === 'recording';
    const panel = h('div');
    const submit = async (verdict, extra, btn) => {
      try { await busy(btn, () => api('/api/review', { method: 'POST', json: { entry_id: e.id, verdict, ...extra } })); toast(verdict === 'correct' ? 'Marked correct. Thank you!' : 'Review sent. Thank you!'); next(); }
      catch (ex) { toast(ex.message, true); if (ex.status === 409 || ex.status === 403) next(); }
    };
    const choose = (which) => {
      if (which === 'needs_fix') {
        const fix = h('textarea', { class: 'gbari-input', lang: 'gby', rows: 2, id: 'fx' }, e.gbari); fix.value = e.gbari;
        const note = h('input', { type: 'text', maxlength: 300, id: 'nt', placeholder: isRec ? 'What should they fix? e.g. "Too quiet", "Read the whole text"' : 'Short note (optional if you wrote the fix)' });
        const send = h('button', { class: 'btn warn block', type: 'button' }, 'Send fix request');
        send.onclick = () => submit('needs_fix', { fix_text: !isRec && fix.value.trim() !== e.gbari ? fix.value : '', note: note.value }, send);
        panel.replaceChildren(h('div', { class: 'card stack', style: 'background:var(--oil-soft)' },
          isRec ? null : h('div', { class: 'field' }, h('label', { class: 'f', for: 'fx' }, 'Corrected Gbari', h('span', { class: 'hint' }, 'Edit the text so it is correct. The contributor will see your version.')), fix, Keypad(() => fix)),
          h('div', { class: 'field' }, h('label', { class: 'f', for: 'nt' }, 'Note'), note), send));
      } else {
        const why = h('select', { id: 'why' }, ['Not Gbari', 'Wrong meaning', 'Audio is silent or unclear', 'Private or inappropriate content', 'Spam or random text'].map((x) => h('option', { value: x }, x)));
        const note = h('input', { type: 'text', maxlength: 200, id: 'nt', placeholder: 'More detail (optional)' });
        const send = h('button', { class: 'btn danger block', type: 'button' }, 'Reject entry');
        send.onclick = () => submit('reject', { note: why.value + (note.value ? ': ' + note.value : '') }, send);
        panel.replaceChildren(h('div', { class: 'card stack', style: 'background:var(--brick-soft)' }, h('div', { class: 'field' }, h('label', { class: 'f', for: 'why' }, 'Reason'), why), h('div', { class: 'field' }, note), send));
      }
      panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    };
    const okBtn = h('button', { class: 'btn good block', type: 'button' }, icon('check'), ' Correct');
    okBtn.onclick = () => submit('correct', {}, okBtn);
    return h('div', { class: 'stack' },
      h('div', { class: 'small muted' }, `${remaining} waiting for review`),
      h('div', { class: 'card stack' },
        h('div', {}, h('span', { class: 'chip' }, isRec ? 'Recording' : 'Translation'), h('span', { class: 'chip' }, cap(e.category))),
        h('div', {}, h('div', { class: 'small muted' }, 'English'), h('p', { class: 'phrase', style: 'font-size:1.2rem' }, e.english)),
        h('div', {}, h('div', { class: 'small muted' }, 'Gbari'), h('p', { class: 'gbari', lang: 'gby', style: 'margin:0;font-weight:650' }, e.gbari)),
        !isRec && e.gloss ? h('div', {}, h('div', { class: 'small muted' }, 'Word-for-word gloss'), h('div', {}, e.gloss)) : null,
        h('div', { class: 'small muted' }, [e.dialect, e.village].filter(Boolean).join(' · ')),
        e.has_audio ? h('div', {}, PlayButton(e.id)) : h('div', { class: 'note warn small' }, 'No recording with this entry. Judge the text only.')),
      h('details', { class: 'card' }, h('summary', {}, 'What should I check?'),
        h('ul', { class: 'small', style: 'padding-left:18px' },
          isRec ? [h('li', {}, 'Does the speaker read exactly the text shown?'), h('li', {}, 'Is the voice clear, without loud noise or long silence?'), h('li', {}, 'Are the tones natural for the dialect?')]
            : [h('li', {}, 'Is the Gbari natural and correct for the English meaning?'), h('li', {}, 'Are special letters and tone marks right?'), h('li', {}, 'Does the gloss match the words?'), h('li', {}, 'Does the recording say the same sentence, clearly?')])),
      okBtn,
      h('div', { class: 'row' },
        h('button', { class: 'btn warn grow', type: 'button', onclick: () => choose('needs_fix') }, 'Needs fix'),
        h('button', { class: 'btn danger ghost grow', type: 'button', onclick: () => choose('reject') }, 'Reject')),
      panel,
      h('button', { class: 'linkish', type: 'button', onclick: () => { skipped.push(e.id); next(); } }, 'Skip for now'));
  }

  // ---- browse
  view.browse = (app) => {
    let dir = 'gb2en', page = 0, timer, seq = 0;
    const q = h('input', { type: 'search', id: 'bq', placeholder: 'Search…', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Search' });
    const cat = h('select', { 'aria-label': 'Category' }, h('option', { value: '' }, 'All categories'));
    const out = h('div'), more = h('button', { class: 'btn ghost block', type: 'button', hidden: true, onclick: () => { page++; run(true); } }, 'Show more');
    const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Direction' },
      h('button', { type: 'button', 'aria-pressed': 'true', onclick: (e) => setDir('gb2en', e) }, 'Gbari → English'),
      h('button', { type: 'button', 'aria-pressed': 'false', onclick: (e) => setDir('en2gb', e) }, 'English → Gbari'));
    function setDir(d, e) { dir = d; seg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === e.target))); q.placeholder = d === 'gb2en' ? 'Type a Gbari word (tone marks optional)' : 'Type an English word'; page = 0; run(); }
    q.placeholder = 'Type a Gbari word (tone marks optional)';
    q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { page = 0; run(); }, 250); });
    cat.addEventListener('change', () => { page = 0; run(); });
    api('/api/browse/categories').then((cs) => cat.append(cs.map((c) => h('option', { value: c.category }, `${cap(c.category)} (${c.n})`)))).catch(() => {});
    async function run(append) {
      const my = ++seq;
      if (!append) out.replaceChildren(h('p', { class: 'center' }, h('span', { class: 'spin' })));
      let r; try { r = await api(`/api/browse?dir=${dir}&q=${encodeURIComponent(q.value)}&category=${encodeURIComponent(cat.value)}&page=${page}`); } catch (e) { out.replaceChildren(h('div', { class: 'note bad' }, e.message)); return; }
      if (my !== seq) return;
      const rows = r.items.map((it) => {
        const first = dir === 'gb2en' ? h('div', { class: 'gbari', lang: 'gby', style: 'font-weight:650' }, it.gbari) : h('div', { style: 'font-weight:700;font-size:1.1rem' }, it.english);
        const second = dir === 'gb2en' ? h('div', {}, it.english) : h('div', { class: 'gbari', lang: 'gby' }, it.gbari);
        return h('div', { class: 'item' }, first, second,
          it.gloss ? h('div', { class: 'small muted' }, 'Gloss: ' + it.gloss) : null,
          h('div', { class: 'row wrap', style: 'margin-top:8px' }, it.audio_id ? PlayButton(it.audio_id) : h('span', { class: 'small muted' }, 'No recording yet'),
            h('span', { class: 'small muted' }, [cap(it.category), it.dialect, it.village].filter(Boolean).join(' · '))));
      });
      if (!append) out.replaceChildren();
      if (!rows.length && !append) out.append(h('div', { class: 'card center muted' }, q.value ? 'No approved entries match yet.' : 'No approved entries yet. Contributions appear here after a reviewer approves them.'));
      else out.append(...rows);
      more.hidden = !r.more;
    }
    app.append(h('h1', {}, 'Browse'), seg, h('div', { class: 'card stack' }, q, cat), h('div', { class: 'card', style: 'padding:14px 16px' }, out), more);
    run();
  };

  // ---- profile
  view.me = async (app) => {
    app.append(h('p', { class: 'center' }, h('span', { class: 'spin' })));
    let pf, lb, mine;
    try { [pf, lb, mine] = await Promise.all([api('/api/profile'), api('/api/leaderboard'), api('/api/my/entries')]); } catch (e) { app.replaceChildren(h('div', { class: 'note bad' }, e.message)); return; }
    const fixes = mine.filter((e) => e.status === 'needs_fix');
    const list = h('div');
    const drawList = () => list.replaceChildren(...(mine.length ? mine.map((e) => entryRow(e)) : [h('p', { class: 'muted' }, 'Nothing yet. Tap Contribute to add your first phrase.')]));
    function entryRow(e) {
      const wrap = h('div', { class: 'item' });
      const label = { pending: 'Waiting for review', needs_fix: 'Needs a fix', validated: 'Approved', rejected: 'Rejected' }[e.status];
      const del = h('button', { class: 'linkish', type: 'button', style: 'color:var(--brick)', onclick: async () => { if (!confirm('Delete this entry and its recording? This cannot be undone.')) return; try { await api(`/api/entries/${e.id}`, { method: 'DELETE' }); mine.splice(mine.indexOf(e), 1); drawList(); toast('Deleted.'); } catch (x) { toast(x.message, true); } } }, 'Delete');
      const show = () => wrap.replaceChildren(
        h('div', { class: 'row between wrap' }, h('span', {}, h('span', { class: 'chip ' + e.status }, label), e.kind === 'recording' ? h('span', { class: 'chip' }, 'Read aloud') : null), h('span', { class: 'small muted' }, e.created_at.slice(0, 10))),
        h('div', { style: 'margin-top:6px;font-weight:650' }, e.english),
        h('div', { class: 'gbari', lang: 'gby' }, e.gbari),
        e.review && e.review.verdict !== 'correct' ? h('div', { class: 'note ' + (e.status === 'rejected' ? 'bad' : 'warn') + ' small', style: 'margin-top:6px' },
          h('strong', {}, e.status === 'rejected' ? 'Rejected: ' : 'Reviewer says: '), e.review.note || '', e.review.fix_text ? h('div', {}, 'Suggested text: ', h('span', { class: 'gbari', lang: 'gby' }, e.review.fix_text)) : null) : null,
        h('div', { class: 'row wrap', style: 'margin-top:8px' }, e.has_audio ? PlayButton(e.id) : null,
          e.status === 'needs_fix' ? h('button', { class: 'btn warn sm', type: 'button', onclick: () => edit() }, 'Fix and resubmit') : null,
          del));
      function edit() {
        const isT = e.kind === 'translation';
        const gb = h('textarea', { class: 'gbari-input', lang: 'gby', rows: 2, id: 'e-gb' }, e.gbari); gb.value = e.gbari;
        const gl = h('textarea', { rows: 2, id: 'e-gl' }, e.gloss || ''); gl.value = e.gloss || '';
        const dia = dialectSelect(e.dialect); const vil = h('input', { type: 'text', value: e.village || '', maxlength: 80 });
        const rec = Recorder(); const err = h('div', { class: 'note bad small', hidden: true });
        const go = h('button', { class: 'btn block', type: 'button' }, 'Resubmit for review');
        go.onclick = () => busy(go, async () => {
          try {
            if (rec.blob) await api(`/api/entries/${e.id}/audio`, { method: 'PUT', raw: rec.blob, type: rec.blob.type || 'audio/webm', headers: { 'X-Duration-Ms': String(rec.ms) } });
            await api(`/api/entries/${e.id}`, { method: 'PATCH', json: isT ? { gbari: gb.value, gloss: gl.value, dialect: dia.value, village: vil.value } : { dialect: dia.value } });
            toast('Resubmitted. Thank you!'); route();
          } catch (x) { err.textContent = x.message; err.hidden = false; }
        });
        wrap.replaceChildren(h('div', { class: 'stack' },
          h('div', { class: 'note warn small' }, h('strong', {}, 'Reviewer says: '), e.review ? (e.review.note || '') : ''),
          h('div', { style: 'font-weight:650' }, e.english),
          isT ? [
            e.review && e.review.fix_text ? h('button', { class: 'btn ghost sm', type: 'button', onclick: () => { gb.value = e.review.fix_text; } }, 'Use the reviewer\u2019s suggested text') : null,
            h('div', { class: 'field' }, h('label', { class: 'f', for: 'e-gb' }, 'Gbari sentence'), gb, Keypad(() => gb)),
            h('div', { class: 'field' }, h('label', { class: 'f', for: 'e-gl' }, 'Word-for-word gloss'), gl),
            h('div', { class: 'field' }, h('label', { class: 'f' }, 'Dialect'), dia),
            h('div', { class: 'field' }, h('label', { class: 'f' }, 'Village or town'), vil)] : [h('div', { class: 'gbari', lang: 'gby' }, e.gbari), h('div', { class: 'field' }, h('label', { class: 'f' }, 'Dialect'), dia)],
          h('div', { class: 'field' }, h('div', { class: 'f' }, 'New recording ', h('span', { class: 'muted' }, e.has_audio ? '(optional – keeps your old one if empty)' : '')), rec.el), err, go,
          h('button', { class: 'linkish', type: 'button', onclick: () => { runCleanups(); show(); } }, 'Cancel')));
      }
      show(); return wrap;
    }
    drawList();

    const nm = h('input', { type: 'text', id: 's-nm', maxlength: 30, value: S.user.display_name });
    const nat = h('input', { type: 'checkbox', id: 's-nat' }); nat.checked = S.user.native_speaker;
    const dia = dialectSelect(S.user.home_dialect);
    const save = h('button', { class: 'btn sm', type: 'button' }, 'Save settings');
    save.onclick = () => busy(save, async () => { try { S.user = await api('/api/me', { method: 'PATCH', json: { display_name: nm.value, native_speaker: nat.checked, home_dialect: dia.value || null } }); toast('Saved.'); renderNav(); } catch (e) { toast(e.message, true); } });
    const delBox = h('input', { type: 'text', placeholder: 'Type DELETE', autocomplete: 'off', 'aria-label': 'Type DELETE to confirm' });
    const delBtn = h('button', { class: 'btn danger sm', type: 'button' }, 'Delete everything');
    delBtn.onclick = () => busy(delBtn, async () => { try { await api('/api/me', { method: 'DELETE', json: { confirm: delBox.value } }); S.user = null; toast('Your account and all your data were deleted.'); navTo('#/login'); } catch (e) { toast(e.message, true); } });

    app.replaceChildren(
      h('div', { class: 'row between' }, h('h1', { style: 'margin:0' }, pf.display_name), S.user.role !== 'contributor' ? h('span', { class: 'chip' }, cap(S.user.role)) : (S.user.reviewer.eligible ? h('span', { class: 'chip' }, 'Reviewer') : null)),
      h('div', { class: 'stats', style: 'margin-top:12px' },
        h('div', { class: 'stat' }, h('b', {}, pf.validated), h('span', {}, 'Approved')),
        h('div', { class: 'stat' }, h('b', {}, pf.submitted), h('span', {}, 'Submitted')),
        h('div', { class: 'stat' }, h('b', {}, pf.streak), h('span', {}, pf.streak === 1 ? 'Day streak' : 'Days streak'))),
      fixes.length ? h('div', { class: 'note warn', style: 'margin-bottom:14px' }, h('strong', {}, `${fixes.length} ${fixes.length === 1 ? 'entry needs' : 'entries need'} a fix.`), ' Find them at the top of your list below.') : null,
      h('div', { class: 'card' }, h('h2', {}, 'Badges'), h('div', { class: 'badges' }, pf.badges.map((b) => h('div', { class: 'bdg' + (b.got ? ' got' : '') }, h('b', {}, (b.got ? '✓ ' : '') + b.name), h('span', {}, b.desc))))),
      h('div', { class: 'card' }, h('h2', {}, 'Leaderboard'), h('p', { class: 'small muted' }, 'Approved entries. Only display names are shown.'),
        lb.length ? h('ol', { class: 'lb' }, lb.map((r) => h('li', { class: r.me ? 'me' : '' }, h('span', { class: 'rank' }, r.rank), h('span', { class: 'grow' }, r.name + (r.me ? ' (you)' : '')), h('b', {}, r.validated)))) : h('p', { class: 'muted' }, 'No approved entries yet. Be the first!')),
      h('div', { class: 'card' }, h('h2', {}, 'My contributions'), list),
      h('div', { class: 'card stack' }, h('h2', {}, 'Settings'),
        h('div', { class: 'field' }, h('label', { class: 'f', for: 's-nm' }, 'Display name'), nm),
        h('label', { class: 'check', for: 's-nat' }, nat, h('span', {}, 'I grew up speaking Gbari')),
        h('div', { class: 'field' }, h('label', { class: 'f' }, 'My home dialect'), dia), save),
      h('div', { class: 'card stack' }, h('h2', {}, 'Your data'),
        h('p', { class: 'small' }, 'Download everything we hold about you, or delete your account together with all your entries and recordings.'),
        h('a', { class: 'btn ghost sm', href: '/api/me/data', download: 'my-gbari-voices-data.json' }, 'Download my data'),
        h('div', { class: 'field' }, delBox), delBtn),
      h('div', { class: 'row wrap' },
        S.user.role === 'admin' ? h('a', { class: 'btn ghost', href: '#/admin' }, 'Admin dashboard') : null,
        h('button', { class: 'btn ghost', type: 'button', onclick: logout }, 'Log out')));
  };

  // ---- admin (separate file, loaded only for admins)
  view.admin = async (app) => {
    if (S.user.role !== 'admin') { location.hash = '#/contribute'; return; }
    if (!GV.admin) {
      app.append(h('p', { class: 'center' }, h('span', { class: 'spin' })));
      await new Promise((ok, no) => { const s = h('script', { src: '/admin.js' }); s.onload = ok; s.onerror = () => no(); document.head.append(s); }).catch(() => {});
      app.replaceChildren();
      if (!GV.admin) { app.append(h('div', { class: 'note bad' }, 'Could not load the admin tools. Check your connection.')); return; }
    }
    GV.admin(app);
  };

  // ------------------------------------------------------------ router, nav, boot
  function runCleanups() { const c = S.cleanups; S.cleanups = []; c.forEach((f) => { try { f(); } catch { /* ignore */ } }); }
  async function logout() { try { await api('/api/logout', { method: 'POST' }); } catch { /* ignore */ } S.user = null; navTo('#/login'); }

  function renderNav() {
    const nav = document.getElementById('nav'), top = document.getElementById('topwa');
    top.hidden = !S.cfg; if (S.cfg) { top.href = wa(`Hello ${S.cfg.appName} team, `); }
    if (!S.user || !S.user.consent_ok) { nav.hidden = true; return; }
    const cur = (location.hash.replace(/^#\/?/, '').split('/')[0]) || 'contribute';
    const items = [['contribute', 'Contribute', 'write'], ['review', 'Review', 'check', !S.user.reviewer.eligible], ['browse', 'Browse', 'search'], ['me', 'Me', 'user']];
    if (S.user.role === 'admin') items.push(['admin', 'Admin', 'shield']);
    nav.replaceChildren(...items.map(([id, label, ic, lock]) => h('a', { href: '#/' + id, 'aria-current': cur === id ? 'page' : null }, icon(ic), label, lock ? h('i', { class: 'lock', title: 'Locked' }) : null)));
    nav.hidden = false;
  }

  async function route() {
    runCleanups(); resetPlayBtn(); player.pause();
    const app = document.getElementById('app'); app.replaceChildren();
    let name = location.hash.replace(/^#\/?/, '').split('/')[0] || 'contribute';
    if (!S.user) name = 'login';
    else if (!S.user.consent_ok) name = 'consent';
    else if (name === 'login' || name === 'consent' || !view[name]) name = 'contribute';
    if (S.user && (name === 'review' || name === 'me')) { try { S.user = await api('/api/me'); } catch { /* keep */ } }
    renderNav();
    document.title = `${S.cfg.appName}`;
    try { await view[name](app); } catch (e) { app.replaceChildren(h('div', { class: 'note bad' }, e.message || 'Something went wrong.')); }
    window.scrollTo(0, 0);
  }
  window.addEventListener('hashchange', route);

  async function boot() {
    if (!S.cfg) {
      try { S.cfg = await api('/api/config'); } catch (e) { document.getElementById('app').replaceChildren(h('div', { class: 'note bad' }, e.message)); return; }
      document.getElementById('brandname').textContent = S.cfg.appName; document.title = S.cfg.appName;
      document.getElementById('foot').replaceChildren('Need help? WhatsApp ', h('a', { href: wa(`Hello ${S.cfg.appName} team, `), target: '_blank', rel: 'noopener' }, S.cfg.whatsappDisplay));
    }
    if (!S.user) { try { S.user = await api('/api/me'); } catch { S.user = null; } }
    route();
  }
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('/sw.js').catch(() => {});
  boot();
})();
