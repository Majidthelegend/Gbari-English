'use strict';
(() => {
  const { h, api, toast, cap, S, PlayButton, busy } = window.GV;

  window.GV.admin = (app) => {
    let tab = 'overview';
    const labels = { overview: 'Overview', queue: 'Review queue', phrases: 'Phrases', people: 'People', export: 'Export' };
    const body = h('div');
    const seg = h('div', { class: 'seg scroll', role: 'group', 'aria-label': 'Admin sections' },
      Object.keys(labels).map((t) => h('button', { type: 'button', 'aria-pressed': String(t === tab), onclick: () => { tab = t; seg.querySelectorAll('button').forEach((b, i) => b.setAttribute('aria-pressed', String(Object.keys(labels)[i] === t))); draw(); } }, labels[t])));
    app.append(h('h1', {}, 'Admin'), seg, body);
    const draw = () => { body.replaceChildren(h('p', { class: 'center' }, h('span', { class: 'spin' }))); ({ overview, queue, phrases, people, export: exporter })[tab](body).catch((e) => body.replaceChildren(h('div', { class: 'note bad' }, e.message))); };
    draw();
  };

  const stat = (n, label) => h('div', { class: 'stat' }, h('b', {}, n), h('span', {}, label));
  const breakdown = (title, rows) => h('div', { class: 'card' }, h('h2', {}, title),
    rows.length ? rows.map((r) => {
      const pc = (n) => (r.total ? (n / r.total) * 100 : 0);
      return h('div', { class: 'item' },
        h('div', { class: 'row between' }, h('strong', {}, cap(r.name)), h('span', { class: 'small muted' }, `${r.total} total`)),
        h('div', { class: 'bar', 'aria-hidden': 'true' }, h('i', { class: 'v', style: `width:${pc(r.validated)}%` }), h('i', { class: 'p', style: `width:${pc(r.pending)}%` }), h('i', { class: 'n', style: `width:${pc(r.needs_fix)}%` }), h('i', { class: 'r', style: `width:${pc(r.rejected)}%` })),
        h('div', { class: 'small muted', style: 'margin-top:4px' }, `Approved ${r.validated} · Waiting ${r.pending} · Needs fix ${r.needs_fix} · Rejected ${r.rejected}`));
    }) : h('p', { class: 'muted' }, 'No entries yet.'));

  async function overview(root) {
    const s = await api('/api/admin/stats'), t = s.totals;
    const mins = Math.round((t.audio_ms || 0) / 60000);
    root.replaceChildren(
      h('div', { class: 'stats' }, stat(t.validated || 0, 'Approved'), stat(t.pending || 0, 'Waiting'), stat(t.needs_fix || 0, 'Needs fix')),
      h('div', { class: 'stats' }, stat(t.rejected || 0, 'Rejected'), stat(t.with_audio || 0, 'Recordings'), stat(mins, 'Audio minutes')),
      h('div', { class: 'stats' }, stat(t.users, 'People'), stat(t.reviewers, 'Can review'), stat(t.prompts, 'Phrases')),
      h('div', { class: 'note info small', style: 'margin-bottom:14px' }, `${t.prompts_full} phrases are complete (${S.cfg.cap}+ approved). ${t.prompts_empty} phrases have no approved translation yet.`),
      breakdown('By category', s.by_category), breakdown('By dialect', s.by_dialect));
  }

  async function queue(root) {
    let status = 'pending', page = 0;
    const list = h('div'), more = h('button', { class: 'btn ghost block', type: 'button', hidden: true, onclick: () => { page++; load(true); } }, 'Show more');
    const sel = h('select', { 'aria-label': 'Status', onchange: () => { status = sel.value; page = 0; load(); } },
      [['pending', 'Waiting for review'], ['needs_fix', 'Needs a fix'], ['rejected', 'Rejected'], ['validated', 'Approved']].map(([v, l]) => h('option', { value: v }, l)));
    root.replaceChildren(h('div', { class: 'card' }, sel), h('div', { class: 'card' }, list), more);
    async function act(btn, fn, msg) { try { await busy(btn, fn); toast(msg); page = 0; load(); } catch (e) { toast(e.message, true); } }
    async function load(append) {
      if (!append) list.replaceChildren(h('p', { class: 'center' }, h('span', { class: 'spin' })));
      const r = await api(`/api/admin/queue?status=${status}&page=${page}`).catch((e) => { list.replaceChildren(h('div', { class: 'note bad' }, e.message)); return null; });
      if (!r) return;
      if (!append) list.replaceChildren();
      if (!r.items.length && !append) list.append(h('p', { class: 'muted center' }, 'Nothing here.'));
      for (const e of r.items) {
        const approve = h('button', { class: 'btn good sm', type: 'button' }, 'Approve');
        approve.onclick = () => act(approve, () => api('/api/review', { method: 'POST', json: { entry_id: e.id, verdict: 'correct' } }), 'Approved.');
        const reject = h('button', { class: 'btn danger ghost sm', type: 'button' }, 'Reject');
        reject.onclick = () => { const why = prompt('Reason for rejecting (the contributor will see this):'); if (why) act(reject, () => e.status === 'pending' ? api('/api/review', { method: 'POST', json: { entry_id: e.id, verdict: 'reject', note: why } }) : api(`/api/admin/entries/${e.id}/status`, { method: 'POST', json: { status: 'rejected' } }), 'Rejected.'); };
        const reopen = h('button', { class: 'btn ghost sm', type: 'button' }, 'Reopen');
        reopen.onclick = () => act(reopen, () => api(`/api/admin/entries/${e.id}/status`, { method: 'POST', json: { status: 'pending' } }), 'Moved back to the review queue.');
        const del = h('button', { class: 'linkish', type: 'button', style: 'color:var(--brick)' }, 'Delete');
        del.onclick = () => { if (confirm('Delete this entry and its recording permanently?')) act(del, () => api(`/api/admin/entries/${e.id}`, { method: 'DELETE' }), 'Deleted.'); };
        list.append(h('div', { class: 'item' },
          h('div', {}, h('span', { class: 'chip ' + e.status }, e.status.replace('_', ' ')), h('span', { class: 'chip' }, e.kind === 'recording' ? 'Read aloud' : 'Translation'), h('span', { class: 'small muted' }, `by ${e.who || 'deleted user'} · ${cap(e.category)}`)),
          h('div', { style: 'margin-top:6px;font-weight:650' }, e.english),
          h('div', { class: 'gbari', lang: 'gby' }, e.gbari),
          e.gloss ? h('div', { class: 'small muted' }, 'Gloss: ' + e.gloss) : null,
          h('div', { class: 'small muted' }, [e.dialect, e.village].filter(Boolean).join(' · ')),
          h('div', { class: 'row wrap', style: 'margin-top:8px' }, e.has_audio ? PlayButton(e.id) : null,
            e.status === 'pending' ? [approve, reject] : e.status === 'validated' ? [reject, reopen] : [reopen], del)));
      }
      more.hidden = !r.more;
    }
    load();
  }

  async function phrases(root) {
    const out = h('div'), list = h('div');
    const file = h('input', { type: 'file', accept: '.csv,text/csv,text/plain', 'aria-label': 'Choose a CSV file' });
    const up = h('button', { class: 'btn block', type: 'button' }, 'Upload phrases');
    const tmpl = URL.createObjectURL(new Blob(['\uFEFFenglish,category,gbari\r\nGood morning,greetings,\r\nHow is your family?,family,\r\n'], { type: 'text/csv' }));
    up.onclick = () => busy(up, async () => {
      if (!file.files[0]) return toast('Choose a CSV file first.', true);
      try {
        const buf = await file.files[0].arrayBuffer();
        const r = await api('/api/admin/prompts/csv', { method: 'POST', raw: buf, type: 'text/csv' });
        out.replaceChildren(h('div', { class: 'note good' }, `Added ${r.added} new phrases (${r.seeds} with Gbari text for read-aloud). Skipped ${r.duplicates} duplicates and ${r.invalid} blank rows.`));
        file.value = ''; search();
      } catch (e) { out.replaceChildren(h('div', { class: 'note bad' }, e.message)); }
    });
    const q = h('input', { type: 'search', placeholder: 'Search phrases…', 'aria-label': 'Search phrases', oninput: () => { clearTimeout(q._t); q._t = setTimeout(search, 250); } });
    async function search() {
      const rows = await api('/api/admin/prompts?q=' + encodeURIComponent(q.value));
      list.replaceChildren(...(rows.length ? rows.map((p) => {
        const t = h('button', { class: 'btn ghost sm', type: 'button' }, p.active ? 'Hide' : 'Show');
        t.onclick = () => busy(t, async () => { await api(`/api/admin/prompts/${p.id}`, { method: 'PATCH', json: { active: !p.active } }); search(); });
        return h('div', { class: 'item row between', style: p.active ? '' : 'opacity:.55' }, h('div', { class: 'grow' }, h('div', { style: 'font-weight:650' }, p.english), h('div', { class: 'small muted' }, `${cap(p.category)} · ${p.reading_only ? 'read-aloud text' : p.approved + ' approved'}${p.active ? '' : ' · hidden'}`)), t);
      }) : [h('p', { class: 'muted' }, 'No phrases found.')]));
    }
    root.replaceChildren(
      h('div', { class: 'card stack' }, h('h2', {}, 'Add phrases from a CSV'),
        h('p', { class: 'small' }, 'Columns: ', h('code', {}, 'english'), ', ', h('code', {}, 'category'), ' and optionally ', h('code', {}, 'gbari'), '. Rows with Gbari text become read-aloud texts for recording; the rest appear in the Translate dropdown. Save as UTF-8.'),
        h('a', { class: 'small', href: tmpl, download: 'phrases-template.csv' }, 'Download a template'), file, up, out),
      h('div', { class: 'card' }, h('h2', {}, 'All phrases'), h('div', { class: 'field' }, q), list));
    search();
  }

  async function people(root) {
    const list = h('div');
    const q = h('input', { type: 'search', placeholder: 'Search name or email…', 'aria-label': 'Search people', oninput: () => { clearTimeout(q._t); q._t = setTimeout(load, 250); } });
    async function load() {
      const rows = await api('/api/admin/users?q=' + encodeURIComponent(q.value));
      list.replaceChildren(...rows.map((u) => {
        const role = h('select', { 'aria-label': 'Role', onchange: () => patch({ role: role.value }) }, ['contributor', 'reviewer', 'admin'].map((r) => h('option', { value: r }, cap(r)))); role.value = u.role;
        const patch = async (d) => { try { await api(`/api/admin/users/${u.id}`, { method: 'PATCH', json: d }); toast('Saved.'); load(); } catch (e) { toast(e.message, true); load(); } };
        const nat = h('input', { type: 'checkbox', onchange: () => patch({ native_speaker: nat.checked }) }); nat.checked = u.native_speaker;
        const blk = h('input', { type: 'checkbox', onchange: () => patch({ review_blocked: blk.checked }) }); blk.checked = u.review_blocked;
        const tp = h('button', { class: 'btn ghost sm', type: 'button' }, 'Temporary password');
        tp.onclick = async () => { if (!confirm(`Create a new temporary password for ${u.display_name}? Their current password stops working.`)) return; try { const r = await api(`/api/admin/users/${u.id}/temp-password`, { method: 'POST' }); alert(`Temporary password for ${u.display_name}:\n\n${r.password}\n\nShare it privately and ask them to change it.`); } catch (e) { toast(e.message, true); } };
        const del = h('button', { class: 'btn danger ghost sm', type: 'button' }, 'Delete');
        del.onclick = async () => { if (!confirm(`Delete ${u.display_name} and ALL their entries and recordings? This cannot be undone.`)) return; try { await api(`/api/admin/users/${u.id}`, { method: 'DELETE' }); toast('Deleted.'); load(); } catch (e) { toast(e.message, true); } };
        return h('div', { class: 'item stack' },
          h('div', { class: 'row between wrap' }, h('strong', {}, u.display_name), h('span', { class: 'chip ' + (u.can_review ? 'validated' : '') }, u.can_review ? 'Can review' : 'Contributor')),
          h('div', { class: 'small muted' }, `${u.email || '(no email)'}${u.google ? ' · Google' : ''} · joined ${u.joined.slice(0, 10)}`),
          h('div', { class: 'small' }, `${u.entries} entries · ${u.approved} approved · ${u.reviews} reviews given`),
          h('div', { class: 'row wrap' }, role,
            h('label', { class: 'check small' }, nat, 'Native speaker'),
            h('label', { class: 'check small' }, blk, 'Block reviewing')),
          h('div', { class: 'row wrap' }, tp, del));
      }));
      if (!rows.length) list.append(h('p', { class: 'muted' }, 'No one found.'));
    }
    root.replaceChildren(h('div', { class: 'note info small', style: 'margin-bottom:14px' }, `People become reviewers automatically after ${S.cfg.reviewerMin} approved contributions${S.cfg.reviewerNative ? ' if they are native speakers' : ''}. Use the role menu to promote someone sooner, or "Block reviewing" to switch it off.`),
      h('div', { class: 'card' }, h('div', { class: 'field' }, q), list));
    await load();
  }

  async function exporter(root) {
    const s = await api('/api/admin/stats'), t = s.totals;
    root.replaceChildren(h('div', { class: 'card stack' },
      h('h2', {}, 'Export approved data'),
      h('p', {}, `${t.validated || 0} approved entries are ready. Only approved entries are exported.`),
      h('a', { class: 'btn block', href: '/api/admin/export.zip' }, 'Download CSV + audio (ZIP)'),
      h('a', { class: 'btn ghost block', href: '/api/admin/export.csv' }, 'Download CSV only'),
      h('hr'),
      h('p', { class: 'small' }, h('strong', {}, 'metadata.csv columns: '), 'id, kind, english, gbari, gloss, dialect, village, category, prompt_id, source_entry_id, contributor_id, status, audio_file, audio_seconds, reviewer_ids, created_at.'),
      h('p', { class: 'small' }, h('strong', {}, 'Audio files: '), h('code', {}, 'category_promptID_contributorID.webm'), ' (read-aloud recordings add ', h('code', {}, '_read<entryID>'), '). Compressed WebM/Opus, mono.'),
      h('p', { class: 'small' }, 'Emails are never included. The CSV opens correctly in Excel and Google Sheets with tone marks intact.')));
  }
})();
