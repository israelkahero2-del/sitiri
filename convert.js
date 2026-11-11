/* Sitiri: reading PDFs, scans and photos.
   Everything here runs in the browser. Pages are turned into text on this computer and are never uploaded. */
(function () {
'use strict';
var pdfjsP = null, ocrP = null, runId = 0;
var $ = function (id) { return document.getElementById(id); };
function abs(p) { return new URL(p, document.baseURI).href; }

/* ---------- loading the readers (only when first needed) ---------- */
function loadPdfjs() {
  if (!pdfjsP) {
    pdfjsP = import('./vendor/pdfjs/pdf.min.mjs').then(function (m) {
      m.GlobalWorkerOptions.workerSrc = abs('vendor/pdfjs/pdf.worker.min.mjs');
      return m;
    });
    pdfjsP.catch(function () { pdfjsP = null; });
  }
  return pdfjsP;
}
function loadScript(src) {
  return new Promise(function (res, rej) {
    var s = document.createElement('script');
    s.src = src; s.onload = res;
    s.onerror = function () { rej(new Error('The scan reader is not on this computer yet. Connect to the internet, open this page once, and try again.')); };
    document.head.appendChild(s);
  });
}
function getOcr() {
  if (!ocrP) {
    ocrP = (window.Tesseract ? Promise.resolve() : loadScript('vendor/tesseract/tesseract.min.js')).then(function () {
      return window.Tesseract.createWorker('eng', 1, {
        workerPath: abs('vendor/tesseract/worker.min.js'),
        corePath: abs('vendor/tesseract/core'),
        langPath: abs('vendor/tesseract/lang'),
        workerBlobURL: false, gzip: true
      });
    });
    ocrP.catch(function () { ocrP = null; });
  }
  return ocrP;
}
async function stopOcr() {
  if (!ocrP) return;
  var p = ocrP; ocrP = null;
  try { (await p).terminate(); } catch (e) { /* already gone */ }
}

/* ---------- turning lines into paragraphs ---------- */
var CLAUSE = /^(?:\(?[0-9]{1,3}[.)]|\(?[a-zA-Z]{1,3}\)|[0-9]{1,2}(?:\.[0-9]{1,2}){1,3}\.?|[A-Z]\.)\s/;
function linesToParas(lines) {
  var paras = [], cur = '', prevShort = false;
  lines.forEach(function (l) {
    var t = String(l.text).replace(/\s+/g, ' ').trim();
    if (!t) { if (cur) { paras.push(cur); cur = ''; } prevShort = false; return; }
    if (cur && (l.gap || prevShort || CLAUSE.test(t))) { paras.push(cur); cur = ''; }
    cur = cur ? cur + ' ' + t : t;
    prevShort = !!l.short;
  });
  if (cur) paras.push(cur);
  return paras;
}
function textToParas(text) {
  var lines = [], gap = false;
  String(text).split(/\r?\n/).forEach(function (raw) {
    if (!raw.trim()) { gap = true; return; }
    lines.push({ text: raw, gap: gap }); gap = false;
  });
  return linesToParas(lines);
}

/* ---------- reading the text that a PDF already carries ---------- */
async function pageText(page) {
  var tc = await page.getTextContent();
  var lines = [], cur = null, minX = Infinity, maxX = -Infinity, chars = 0;
  tc.items.forEach(function (it) {
    if (typeof it.str !== 'string') return;
    var x = it.transform[4], y = it.transform[5];
    var h = it.height || Math.abs(it.transform[3]) || 10;
    if (!cur || Math.abs(y - cur.y) > Math.max(h, cur.h) * 0.5) {
      cur = { y: y, h: h, x: x, endX: x, parts: [] }; lines.push(cur);
    }
    if (cur.parts.length && x - cur.endX > h * 0.2) {
      var last = cur.parts[cur.parts.length - 1];
      if (!/\s$/.test(last) && !/^\s/.test(it.str)) cur.parts.push(' ');
    }
    cur.parts.push(it.str);
    if (it.str.trim()) {
      cur.endX = Math.max(cur.endX, x + (it.width || 0)); cur.h = Math.max(cur.h, h);
      minX = Math.min(minX, x); maxX = Math.max(maxX, x + (it.width || 0));
      chars += it.str.replace(/\s/g, '').length;
    }
  });
  var width = maxX - minX, prev = null, out = [];
  lines.forEach(function (l) {
    var text = l.parts.join('');
    if (!text.trim()) return;
    var gap = prev ? (prev.y - l.y) > 1.45 * Math.max(prev.h, l.h) || l.y > prev.y : false;
    var short = width > 0 && (maxX - l.endX) > 0.18 * width && /[.:;!?)\]"”]$/.test(text.trim());
    out.push({ text: text, gap: gap, short: short });
    prev = l;
  });
  return { paras: linesToParas(out), chars: chars };
}

/* ---------- reading a scanned page ---------- */
function canvasBlob(canvas) {
  return new Promise(function (res) { canvas.toBlob(function (b) { res(b); }, 'image/jpeg', 0.85); });
}
var SYMBOLS = /^[^A-Za-z0-9]+$/;
var CODE = /^[A-Z]{3,}\/[A-Z0-9!?]{2,}/;   // reference codes such as title numbers, which scans often garble
var LABEL = /^\(?[A-Za-z0-9]{1,3}[.)]$/;    // list labels such as "A)" or "2."
var MONTHS = 'January|February|March|April|May|June|July|August|September|October|November|December';
function tidyToken(t) { return String(t).replace(/[.…_]{4,}/g, ' ').replace(/\s+/g, ' ').trim(); }
function ordinal(n) { n = +n; var t = n % 100; if (t >= 11 && t <= 13) return n + 'th'; return n + (['th', 'st', 'nd', 'rd'][n % 10] || 'th'); }
// "16® day of March" and "8™ Floor" are superscript "th" and "st" that the scan reader garbled.
function fixOrdinals(text) {
  return text.replace(new RegExp('\\b(\\d{1,2})\\s?[\\u00ae\\u2122"*%\\u201c\\u201d\'\\u2019]{1,2}\\s+(?=(?:day|floor|' + MONTHS + ')\\b)', 'gi'), function (m, n) { return ordinal(n) + ' '; });
}
function pct(list, q) { var a = list.slice().sort(function (x, y) { return x - y; }); return a.length ? a[Math.min(a.length - 1, Math.floor(q * a.length))] : 0; }
async function ocrCanvas(canvas) {
  var worker = await getOcr();
  var r = await worker.recognize(canvas, {}, { text: true, blocks: true });
  // First pass: collect every word with where it sits and how sure the reader was.
  var raw = [];
  (r.data.blocks || []).forEach(function (b) { (b.paragraphs || []).forEach(function (p) { (p.lines || []).forEach(function (l) {
    var words = [];
    (l.words || []).forEach(function (w) {
      var t = tidyToken(w.text); if (!t) return;
      words.push({ t: t, c: w.confidence, x0: w.bbox.x0, x1: w.bbox.x1, alnum: (t.match(/[A-Za-z0-9]/g) || []).length, code: CODE.test(t) });
    });
    if (words.length) raw.push({ words: words, y0: l.bbox.y0, y1: l.bbox.y1, h: Math.max(8, l.bbox.y1 - l.bbox.y0) });
  }); }); });
  // Where the real text starts and ends, judged from words the reader was sure of.
  var sureL = [], sureR = [];
  raw.forEach(function (l) {
    var sure = l.words.filter(function (w) { return w.c >= 80 && w.alnum >= 3; });
    if (sure.length >= 2) { sureL.push(sure[0].x0); sureR.push(sure[sure.length - 1].x1); }
  });
  var edgeL = sureL.length ? pct(sureL, 0.05) : 0, edgeR = sureR.length ? pct(sureR, 0.97) : Infinity;
  var rows = [], unsure = [], seen = {};
  raw.forEach(function (l) {
    var sureCount = l.words.filter(function (w) { return w.c >= 60 && w.alnum >= 2; }).length;
    var steady = sureCount >= 3 && sureCount / l.words.length >= 0.6;      // a line the reader mostly trusted
    var words = l.words.filter(function (w) {
      if (SYMBOLS.test(w.t)) return /^[-–&]$/.test(w.t) && w.c >= 50;       // stray marks, brackets, dot leaders
      if (w.code) return true;
      if (w.c < 60 && (w.x1 < edgeL - 0.5 * l.h || w.x0 > edgeR + 0.5 * l.h)) return false;   // doubtful marks out in the margins
      if (w.c >= 60) return true;
      if (steady) return w.alnum >= 3 || (LABEL.test(w.t) && w.c >= 20) || (/\d/.test(w.t) && w.c >= 15);   // keep doubtful words in good lines, and flag them
      if (/^\d[\d,./=-]*$/.test(w.t) && w.c >= 15) return true;                 // numbers matter, even doubtful ones
      return w.alnum >= 4 && w.c >= 40;
    });
    while (words.length > 1 && words[0].alnum <= 1 && words[1].x0 - words[0].x1 > 2.5 * l.h) words.shift();
    while (words.length > 1 && words[words.length - 1].alnum <= 1 && words[words.length - 1].x0 - words[words.length - 2].x1 > 2.5 * l.h) words.pop();
    if (!words.length) return;
    var sum = 0, letters = 0, hasCode = false;
    words.forEach(function (w) { sum += w.c; letters += w.alnum; if (w.code) hasCode = true; });
    var mean = sum / words.length;
    if (!hasCode && (mean < 55 || letters < 2 || (letters < 3 && mean < 85) || (letters / words.length < 2 && mean < 80))) return;   // a line of noise
    words.forEach(function (w) {
      if (((w.c < 75 && w.alnum >= 3) || (w.code && w.c < 90)) && !seen[w.t] && unsure.length < 30) { seen[w.t] = 1; unsure.push(w.t); }
    });
    rows.push({ text: fixOrdinals(words.map(function (w) { return w.t; }).join(' ')), x0: words[0].x0, x1: words[words.length - 1].x1, y0: l.y0, y1: l.y1, h: l.h });
  });
  if (!rows.length) return { paras: [], unsure: [] };
  var right = pct(rows.map(function (x) { return x.x1; }), 0.85), left = pct(rows.map(function (x) { return x.x0; }), 0.15), width = right - left;
  var lineH = pct(rows.map(function (x) { return x.h; }), 0.5);   // the usual line height on this page
  rows.forEach(function (row, i) {
    var prev = rows[i - 1];
    row.gap = prev ? (row.y0 - prev.y1) > 0.75 * lineH || row.y0 < prev.y0 - prev.h : false;
    row.short = width > 0 && (right - row.x1) > 0.12 * width && /[.:;!?]$/.test(row.text);
  });
  return { paras: linesToParas(rows), unsure: unsure };
}
async function renderPage(page) {
  var base = page.getViewport({ scale: 1 });
  var scale = Math.max(0.75, Math.min(3, 3000 / Math.max(base.width, base.height)));
  var vp = page.getViewport({ scale: scale });
  var canvas = document.createElement('canvas');
  canvas.width = Math.ceil(vp.width); canvas.height = Math.ceil(vp.height);
  var ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  return canvas;
}
async function imageCanvas(file) {
  var bmp = await createImageBitmap(file);
  var scale = Math.min(1, 3200 / Math.max(bmp.width, bmp.height));
  var canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale); canvas.height = Math.round(bmp.height * scale);
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/* ---------- writing the text out as a Word document ---------- */
function xml(s) {
  return String(s).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F￾￿]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
async function makeDocx(pages) {
  var NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  var body = '', first = true;
  pages.forEach(function (paras) {
    paras.forEach(function (p, i) {
      var ppr = (i === 0 && !first) ? '<w:pPr><w:pageBreakBefore/></w:pPr>' : '';
      body += '<w:p>' + ppr + '<w:r><w:t xml:space="preserve">' + xml(p) + '</w:t></w:r></w:p>';
    });
    if (paras.length) first = false;
  });
  if (!body) body = '<w:p/>';
  var head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  var zip = new JSZip();
  zip.file('[Content_Types].xml', head + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>');
  zip.file('_rels/.rels', head + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/_rels/document.xml.rels', head + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>');
  zip.file('word/styles.xml', head + '<w:styles xmlns:w="' + NS + '"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="Times New Roman" w:cs="Times New Roman"/><w:sz w:val="24"/><w:szCs w:val="24"/><w:lang w:val="en-GB"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="300" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style></w:styles>');
  zip.file('word/document.xml', head + '<w:document xmlns:w="' + NS + '"><w:body>' + body + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>');
  return zip.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE' });
}

/* ---------- the conversion itself ---------- */
function status(cls, text) { var el = $('c-status'); el.className = 'note ' + cls; el.textContent = text; }
function clearCheck() {
  var box = $('c-pages');
  Array.prototype.forEach.call(box.querySelectorAll('img'), function (im) { URL.revokeObjectURL(im.src); });
  box.innerHTML = ''; $('c-check').classList.add('hide');
}
async function readFile(file, id) {
  var pages = [], isPdf = /\.pdf$/i.test(file.name), usedOcr = false;
  if (isPdf) {
    var pdfjs = await loadPdfjs();
    var task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false });
    var doc;
    try { doc = await task.promise; }
    catch (e) { throw new Error(e && e.name === 'PasswordException' ? 'This PDF is locked with a password. Remove the password and try again.' : 'This PDF could not be opened. It may be damaged.'); }
    for (var n = 1; n <= doc.numPages; n++) {
      if (id !== runId) { task.destroy(); return null; }
      status('ok', 'Reading page ' + n + ' of ' + doc.numPages + '.');
      var page = await doc.getPage(n), t = await pageText(page);
      if (t.chars >= 40) pages.push({ n: n, paras: t.paras, ocr: false });
      else {
        status('ok', 'Reading page ' + n + ' of ' + doc.numPages + ' as a scan. This takes a few seconds a page.');
        usedOcr = true;
        var canvas = await renderPage(page);
        var blob = await canvasBlob(canvas);
        var got = await ocrCanvas(canvas);
        pages.push({ n: n, paras: got.paras, unsure: got.unsure, ocr: true, blob: blob });
        canvas.width = canvas.height = 0;
      }
      page.cleanup();
    }
    await task.destroy();
  } else {
    status('ok', 'Reading the picture. This takes a few seconds.');
    var c = await imageCanvas(file);
    var one = await ocrCanvas(c);
    pages.push({ n: 1, paras: one.paras, unsure: one.unsure, ocr: true, blob: file });
  }
  await stopOcr();
  return pages;
}
async function finish(file, pages, id) {
  if (id !== runId) return;
  var buf = await makeDocx(pages.map(function (p) { return p.paras; }));
  var info = await readDocx(buf);
  if (id !== runId) return;
  var scans = pages.filter(function (p) { return p.ocr; }).length;
  state.src = { name: file.name.replace(/\.[^.]+$/, '') + '.docx', buf: buf, info: info, converted: true, scanned: scans > 0 };
  clearCheck();
  $('r-fileinfo').textContent = file.name + ': ' + pages.length + ' page(s) read' + (scans ? ', ' + scans + ' as scans' : '') + '.';
  status('warn', 'The redacted copy will be a Word document with the text only. Tables, columns, pictures, stamps and signatures are not kept.' +
    (info.lines.length ? '' : ' No text was found in this file.'));
  recount();
}
window.startConvert = async function (file) {
  var id = ++runId;
  state.src = null;
  $('r-fileinfo').textContent = '';
  $('c-panel').classList.remove('hide');
  clearCheck();
  if (location.protocol === 'file:') {
    status('bad', 'PDFs, scans and photos can only be read when Sitiri is opened from its web address. Opened from a folder like this, Sitiri reads Word documents and pasted text.');
    return;
  }
  try {
    var pages = await readFile(file, id);
    if (!pages || id !== runId) return;
    var scans = pages.filter(function (p) { return p.ocr; });
    if (!scans.length) { await finish(file, pages, id); return; }
    // Scanned pages must be checked by a person before they are used.
    var box = $('c-pages');
    scans.forEach(function (p) {
      var wrap = document.createElement('div'); wrap.className = 'c-page';
      var img = document.createElement('img'); img.alt = 'Page ' + p.n + ' as scanned'; img.src = URL.createObjectURL(p.blob);
      var side = document.createElement('div');
      var lab = document.createElement('label'); lab.textContent = 'Page ' + p.n + ': what Sitiri read'; lab.htmlFor = 'c-text-' + p.n;
      var ta = document.createElement('textarea'); ta.id = 'c-text-' + p.n; ta.value = p.paras.join('\n\n'); ta.spellcheck = false;
      side.appendChild(lab); side.appendChild(ta);
      if (p.unsure && p.unsure.length) { var hint = document.createElement('p'); hint.className = 'c-unsure'; hint.textContent = 'Check these closely. Sitiri was least sure of: ' + p.unsure.join('   '); side.appendChild(hint); }
      wrap.appendChild(img); wrap.appendChild(side); box.appendChild(wrap);
      p.field = ta;
    });
    status('warn', scans.length + ' page(s) were read as scans. Scan reading makes mistakes. Compare each page with its text and correct it, especially names and numbers, then press "Use this text".');
    $('c-check').classList.remove('hide');
    $('c-accept').onclick = function () {
      scans.forEach(function (p) { p.paras = textToParas(p.field.value); });
      finish(file, pages, id);
    };
  } catch (e) {
    if (id !== runId) return;
    await stopOcr();
    clearCheck();
    status('bad', (e && e.message) || 'This file could not be read.');
  }
};
// Ask the offline helper to fetch the scan reader in the background, so scans can be read offline later.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.ready.then(function (reg) { if (reg.active) reg.active.postMessage('warm'); }).catch(function () {});
}
window.resetConvert = function () { runId++; stopOcr(); clearCheck(); $('c-panel').classList.add('hide'); };

/* Extra search patterns. Scan reading often turns "ID" into "1D", and real documents name
   councils, banks, buildings and streets that the basic search does not look for. */
(function () {
  var D = window.DETECT; if (!D) return;
  function both(list) { return list.map(function (k) { return k + '|' + k.toUpperCase(); }).join('|'); }
  function lead(s) {
    var w = String(s).split(/\s+/);
    while (w.length > 1 && /^(?:floor|advocates|at|on|off|along|of|the|and|in|to|from|near|opposite)$/i.test(w[0].replace(/[.,]/g, ''))) w.shift();
    return window.stripLead ? window.stripLead(w.join(' ')) : w.join(' ');
  }
  D.forEach(function (d) {
    if (d.cat === 'Address') d.re = /\b(?:P\.?\s*[O0]\.?\s*Box|Post\s+Office\s+Box)(?:\s+(?:No\.?|Number))?\s+\d+(?:\s*[-\u2013.]?\s*\d{5})?/gi;
  });
  D.push({ cat: 'ID No', re: /\b(?:1D|lD|I0|ID)\s*N[o0]\.?,?\s*[:.]?\s*([A-Z]{0,2}\d{6,9})\b/g, group: 1 });
  D.push({ cat: 'Company', clean: lead, re: new RegExp("\\b(?:(?:[A-Z][A-Za-z0-9&'\u2019.\\-]*|&)\\s+){1,5}(?:" + both(['County Council', 'Council', 'Authority', 'Commission', 'Corporation', 'Bank', 'Trust', 'Foundation', 'University', 'Society', 'Association', 'Holdings', 'Enterprises', 'Investments', 'Properties', 'Agencies', 'Developers', 'Company']) + ")(?![A-Za-z])", 'g') });
  D.push({ cat: 'Address', clean: lead, re: new RegExp("\\b(?:[A-Z][A-Za-z'\u2019]+\\s+){1,2}(?:" + both(['House', 'Plaza', 'Towers', 'Tower', 'Centre', 'Center', 'Building', 'Arcade', 'Complex', 'Chambers', 'Street', 'Road', 'Avenue', 'Lane', 'Drive', 'Close', 'Highway']) + ")(?![A-Za-z])", 'g') });
  D.push({ cat: 'Land Ref', re: /\b[A-Z][A-Za-z]{3,}\/[A-Za-z][A-Za-z0-9 .]{2,}?\/\d+[A-Z]?\b/g });
  D.push({ cat: 'Ref', re: /\b[A-Z]{4,}\/[A-Z0-9]{4,}(?:\/[A-Z0-9]+)*(?:[!?]\s?\S{0,2}\/\d+)?/g });
})();

/* ---------- near misses: words that look like a hidden name, e.g. "Sarnco" for "Samco" ---------- */
var COMMON = /^(?:the|kenya|kenyan|national|county|hotel|hotels|bank|group|holdings|company|limited|estate|estates|east|west|north|south|africa|african|international|services|service|investments|development|trust|general|united|office|street|road|avenue|house|centre|center|plaza|tower|towers)$/i;
function looks(s) {
  return s.toLowerCase().replace(/rn/g, 'm').replace(/vv/g, 'w').replace(/cl/g, 'd')
    .replace(/0/g, 'o').replace(/[1!|i]/g, 'l').replace(/5/g, 's').replace(/8/g, 'b');
}
function within1(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false;
  var i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}
window.nearMisses = function (rows, lines) {
  var words = [];
  rows.forEach(function (r) {
    String(r.term).split(/\s+/).forEach(function (w) {
      w = w.replace(/[^A-Za-z0-9'’-]/g, '');
      if (w.length >= 5 && /[A-Za-z]/.test(w) && !COMMON.test(w)) words.push({ raw: w.toLowerCase(), look: looks(w), cat: r.cat });
    });
  });
  var seen = {}, out = [];
  // Long numbers that are still visible (ID, account or phone numbers the search did not recognise).
  lines.forEach(function (line) {
    var m, re = /(?<![\d,.\/-])\d{6,}(?![\d,.\/-]*\d)/g;
    while ((m = re.exec(line))) { if (!seen[m[0]]) { seen[m[0]] = 1; out.push({ cat: 'Number', term: m[0] }); } }
  });
  // Garbled copies of a hidden reference code, e.g. "KAJIADO/AMBOSE! 1/8" for "KAJIADO/AMBOSELI/8".
  rows.forEach(function (r) {
    var m = /^([A-Za-z]{4,})\//.exec(String(r.term).trim()); if (!m) return;
    var re = new RegExp(m[1] + "\\/[^\\s,;]+(?:\\s[^\\s,;\\/]{1,3}\\/[^\\s,;]+)?", 'gi');
    lines.forEach(function (line) { var k; while ((k = re.exec(line))) { var t = k[0].replace(/[.)]+$/, ''); if (!seen[t]) { seen[t] = 1; out.push({ cat: r.cat, term: t }); } } });
  });
  if (!words.length) return out;
  lines.forEach(function (line) {
    var m, re = /[A-Za-z0-9][A-Za-z0-9'’-]{3,}/g;
    while ((m = re.exec(line))) {
      var tok = m[0], low = tok.toLowerCase();
      if (seen[low] || !/^[A-Z0-9]/.test(tok)) continue;
      for (var i = 0; i < words.length; i++) {
        var w = words[i];
        if (low === w.raw || low.indexOf(w.raw) === 0 || w.raw.indexOf(low) === 0) continue;
        var lk = looks(tok);
        if (lk === w.look || (w.raw.length >= 6 && within1(lk, w.look))) { seen[low] = 1; out.push({ cat: w.cat, term: tok }); break; }
      }
    }
  });
  return out;
};
})();
