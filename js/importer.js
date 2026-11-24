/* importer.js — parse pasted text / CSV / Excel into word objects. IIFE -> `Importer`. */
(function () {
  'use strict';

  /* Normalize one raw row into the shared word schema, skipping empties. */
  function normalizeRow(fields) {
    // fields: [word, phonetic?, pos?, meaning?, example?, topic?]
    const word = (fields[0] || '').trim();
    if (!word) return null;
    const entry = { word };
    const phonetic = (fields[1] || '').trim();
    const pos = (fields[2] || '').trim();
    const meaning = (fields[3] || '').trim();
    const example = (fields[4] || '').trim();
    const topic = (fields[5] || '').trim();
    if (phonetic) entry.phonetic = phonetic;
    if (pos) entry.pos = pos;
    if (meaning) entry.meaning = meaning;
    if (example) entry.example = example;
    if (topic) entry.topic = topic;
    return entry;
  }

  /* Parse free-form pasted text. Accepts one word per line, with fields
   * separated by TAB, comma, or the first run of 2+ spaces. A leading header
   * line (contains "word" / "单词") is skipped. */
  function parseText(text) {
    const out = [];
    const lines = String(text || '').split(/\r?\n/);
    for (let line of lines) {
      line = line.trim();
      if (!line) continue;
      if (/^(word|单词|词汇)\b/i.test(line) && /(meaning|释义|意思)/i.test(line)) continue;
      let fields;
      if (line.includes('\t')) fields = line.split('\t');
      else if (line.includes(',')) fields = line.split(',');
      else fields = line.split(/\s{2,}/);
      const row = normalizeRow(fields);
      if (row) out.push(row);
    }
    return out;
  }

  /* Minimal CSV parser handling quoted cells. */
  function parseCSV(text) {
    const rows = [];
    let row = [];
    let cur = '';
    let inQuotes = false;
    const s = String(text || '');
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (inQuotes) {
        if (c === '"') {
          if (s[i + 1] === '"') { cur += '"'; i++; }
          else inQuotes = false;
        } else cur += c;
      } else if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(cur); cur = ''; }
      else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
      else if (c === '\r') { /* skip */ }
      else cur += c;
    }
    if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
    const out = [];
    for (const r of rows) {
      if (r.length && /^(word|单词)$/i.test((r[0] || '').trim())) continue;
      const rowObj = normalizeRow(r);
      if (rowObj) out.push(rowObj);
    }
    return out;
  }

  let excelReader;
  function loadExcelReader() {
    if (window.XLSX) return Promise.resolve();
    if (!excelReader) {
      excelReader = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
        script.integrity = 'sha384-vtjasyidUo0kW94K5MXDXntzOJpQgBKXmE7e2Ga4LG0skTTLeBi97eFAXsqewJjw';
        script.crossOrigin = 'anonymous';
        script.referrerPolicy = 'no-referrer';
        script.onload = resolve;
        script.onerror = () => {
          script.remove();
          excelReader = null;
          reject(new Error('无法加载 Excel 读取器，请检查网络或另存为 CSV 导入'));
        };
        document.head.append(script);
      });
    }
    return excelReader;
  }

  function parseExcel(arrayBuffer) {
    if (window.XLSX) {
      const wb = window.XLSX.read(arrayBuffer, { type: 'array' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const aoa = window.XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false });
      const out = [];
      for (const r of aoa) {
        const cells = (r || []).map(c => (c == null ? '' : String(c)));
        if (cells.length && /^(word|单词)$/i.test(cells[0].trim())) continue;
        const rowObj = normalizeRow(cells);
        if (rowObj) out.push(rowObj);
      }
      return out;
    }
    return [];
  }

  /* Merge new words into existing, deduping by lowercase word (existing wins
   * so re-imports don't clobber edits). Returns {merged, added}. */
  function merge(existing, incoming) {
    const seen = new Set(existing.map(w => (w.word || '').toLowerCase()));
    let added = 0;
    const merged = existing.slice();
    for (const w of incoming) {
      const k = (w.word || '').toLowerCase();
      if (!k || seen.has(k)) continue;
      seen.add(k);
      merged.push(w);
      added++;
    }
    return { merged, added };
  }

  window.Importer = { parseText, parseCSV, parseExcel, loadExcelReader, merge, normalizeRow };
})();
