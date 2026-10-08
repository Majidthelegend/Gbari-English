'use strict';
// Small RFC-4180 CSV reader/writer (UTF-8, handles quotes, BOM, comma/semicolon/tab).
function parse(text) {
  text = String(text).replace(/^\uFEFF/, '');
  const first = text.split(/\r?\n/, 1)[0] || '';
  const count = (ch) => first.split(ch).length - 1;
  const delim = count('\t') > count(',') && count('\t') >= count(';') ? '\t' : count(';') > count(',') ? ';' : ',';
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === delim) { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cur); cur = '';
      if (row.some((x) => x.trim() !== '')) rows.push(row);
      row = [];
    } else cur += c;
  }
  row.push(cur);
  if (row.some((x) => x.trim() !== '')) rows.push(row);
  return rows;
}
function field(v) {
  v = v == null ? '' : String(v);
  // Neutralise spreadsheet formula injection
  if (/^[=+@]/.test(v) || /^-[^0-9]/.test(v)) v = "'" + v;
  return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}
function stringify(header, rows) {
  const out = [header.map(field).join(',')];
  for (const r of rows) out.push(header.map((h) => field(r[h])).join(','));
  return '\uFEFF' + out.join('\r\n') + '\r\n'; // BOM so Excel shows tone marks correctly
}
module.exports = { parse, stringify };
