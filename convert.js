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
async function ocrCanvas(canvas) {
  var worker = await getOcr();
  var r = await worker.recognize(canvas);
  return textToParas(r.data.text || '');
}
async function renderPage(page) {
  var base = page.getViewport({ scale: 1 });
  var scale = Math.max(1.5, Math.min(3, 2800 / Math.max(base.width, base.height)));
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
        pages.push({ n: n, paras: await ocrCanvas(canvas), ocr: true, blob: blob });
        canvas.width = canvas.height = 0;
      }
      page.cleanup();
    }
    await task.destroy();
  } else {
    status('ok', 'Reading the picture. This takes a few seconds.');
    var c = await imageCanvas(file);
    pages.push({ n: 1, paras: await ocrCanvas(c), ocr: true, blob: file });
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
      side.appendChild(lab); side.appendChild(ta); wrap.appendChild(img); wrap.appendChild(side); box.appendChild(wrap);
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

/* Scan reading often turns "ID" into "1D" or "lD". Teach the search to see through that. */
if (window.DETECT) window.DETECT.push({ cat: 'ID No', re: /\b(?:1D|lD|I0|ID)\s*N[o0]\.?,?\s*[:.]?\s*([A-Z]{0,2}\d{6,9})\b/g, group: 1 });

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
