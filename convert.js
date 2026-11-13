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

/* ---------- what kind of page is this, and is the scan good enough? ---------- */
// Finds the largest picture on a PDF page: how much of the page it covers and how many dots per inch it holds.
async function pageImageInfo(page, pdfjs) {
  var info = { cover: 0, dpi: 0, px: 0 };
  try {
    var ops = await page.getOperatorList(), O = pdfjs.OPS, view = page.view;
    var pageArea = Math.abs((view[2] - view[0]) * (view[3] - view[1])) || 1;
    var m = [1, 0, 0, 1, 0, 0], stack = [];
    for (var i = 0; i < ops.fnArray.length; i++) {
      var fn = ops.fnArray[i], a = ops.argsArray[i];
      if (fn === O.save) stack.push(m.slice());
      else if (fn === O.restore) { if (stack.length) m = stack.pop(); }
      else if (fn === O.transform) m = [m[0] * a[0] + m[2] * a[1], m[1] * a[0] + m[3] * a[1], m[0] * a[2] + m[2] * a[3], m[1] * a[2] + m[3] * a[3], m[0] * a[4] + m[2] * a[5] + m[4], m[1] * a[4] + m[3] * a[5] + m[5]];
      else if (fn === O.paintImageXObject || fn === O.paintInlineImageXObject || fn === O.paintImageXObjectRepeat) {
        var area = Math.abs(m[0] * m[3] - m[1] * m[2]), cover = area / pageArea;
        if (cover > info.cover) {
          info.cover = cover;
          var wPts = Math.sqrt(m[0] * m[0] + m[1] * m[1]), px = fn === O.paintInlineImageXObject ? (a[0] && a[0].width) : a[1];
          var hPts = Math.sqrt(m[2] * m[2] + m[3] * m[3]), pxH = fn === O.paintInlineImageXObject ? (a[0] && a[0].height) : a[2];
          var inches = Math.max(wPts, hPts) / 72;
          info.px = Math.max(px || 0, pxH || 0);
          // Phone scanning apps often give the page a made-up paper size, so dots per inch only mean something for a believable page.
          info.dpi = px && wPts && inches >= 5 && inches <= 18 ? Math.round(px / (wPts / 72)) : 0;
        }
      }
    }
  } catch (e) {}
  return info;
}
// A plain-words warning when a scan is too coarse or too faint to read well. Empty when the scan is fine.
function scanWarning(canvas, dpi, longSidePx, words) {
  var notes = [];
  if (dpi && dpi < 180) notes.push('This page was scanned at about ' + dpi + ' dots per inch, which is too coarse to read reliably.');
  else if (!dpi && longSidePx && longSidePx < 1500) notes.push('This picture is small (' + longSidePx + ' pixels on its long side), which is too coarse to read reliably.');
  try {
    var g = grayOf(canvas), hist = new Uint32Array(256), n = 0, i;
    for (i = 0; i < g.length; i += 7) { hist[g[i]]++; n++; }
    var acc = 0, ink = 0, paper = 255;
    for (i = 0; i < 256; i++) { acc += hist[i]; if (acc >= n * 0.01) { ink = i; break; } }
    for (acc = 0, i = 0; i < 256; i++) { acc += hist[i]; if (acc >= n * 0.8) { paper = i; break; } }
    if (words >= 20 && paper > 60 && ink > paper * 0.6) notes.push('The print on this page is very faint.');
  } catch (e) {}
  return notes.length ? notes.join(' ') + ' If you can, scan it again at 300 dots per inch, in black and white or greyscale.' : '';
}
function realWords(text) {
  var W = wordSet(), n = 0;
  String(text).split(/\s+/).forEach(function (w) { var a = w.replace(/[^A-Za-z]/g, ''); if (a.length >= 3 && (!W || W.has(a.toLowerCase()))) n++; });
  return n;
}
// Where two readings of the same page differ. Returns pairs: what the first says, what the second says.
function disagreements(textA, textB) {
  function toks(t) { return String(t).split(/\s+/).filter(Boolean).map(function (w) { return { w: w, k: w.toLowerCase().replace(/[^a-z0-9]/g, '') }; }).filter(function (x) { return x.k; }); }
  var A = toks(textA), B = toks(textB), n = A.length, m = B.length;
  if (!n || !m || n * m > 4e6) return [];
  var L = new Array(n + 1), i, j;
  for (i = 0; i <= n; i++) L[i] = new Uint16Array(m + 1);
  for (i = n - 1; i >= 0; i--) for (j = m - 1; j >= 0; j--) L[i][j] = A[i].k === B[j].k ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  var out = [], a = [], b = [];
  function flush() {
    if (a.length && b.length && a.length <= 6 && b.length <= 6) {
      var ka = a.map(function (x) { return x.k; }).join(''), kb = b.map(function (x) { return x.k; }).join('');
      if (ka !== kb) out.push([a.map(function (x) { return x.w; }).join(' '), b.map(function (x) { return x.w; }).join(' ')]);
    }
    a = []; b = [];
  }
  i = 0; j = 0;
  while (i < n && j < m) {
    if (A[i].k === B[j].k) { flush(); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) a.push(A[i++]); else b.push(B[j++]);
  }
  while (i < n) a.push(A[i++]); while (j < m) b.push(B[j++]);
  flush();
  return out;
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
var wordsP = null;
function wordSet() { if (!wordsP && window.SITIRI_WORDS) wordsP = new Set(window.SITIRI_WORDS.split('|')); return wordsP; }
// Reads the cleaned-up page. If that reading is doubtful, reads the page as it is too, and keeps whichever has more real words.
async function readScan(canvas) {
  var cleaned = enhance(canvas, 'dark');
  var a = await ocrCanvas(cleaned.canvas);
  cleaned.canvas.width = cleaned.canvas.height = 0;
  if (a.total >= 20 && a.score / a.total >= 0.9) return a;      // a clean reading: no need for a second look
  var b = await ocrCanvas(canvas);
  return b.score > a.score * 1.02 ? b : a;
}
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
  var W = wordSet(), score = 0, total = 0;
  raw.forEach(function (l) { l.words.forEach(function (w) {
    var a = w.t.replace(/[^A-Za-z]/g, ''); if (a.length < 3) return; total++; if (w.c < 60) return;
    if (!W || W.has(a.toLowerCase())) score++;
  }); });
  if (!rows.length) return { paras: [], unsure: [], score: 0, total: total };
  var right = pct(rows.map(function (x) { return x.x1; }), 0.85), left = pct(rows.map(function (x) { return x.x0; }), 0.15), width = right - left;
  var lineH = pct(rows.map(function (x) { return x.h; }), 0.5);   // the usual line height on this page
  rows.forEach(function (row, i) {
    var prev = rows[i - 1];
    row.gap = prev ? (row.y0 - prev.y1) > 0.75 * lineH || row.y0 < prev.y0 - prev.h : false;
    row.short = width > 0 && (right - row.x1) > 0.12 * width && /[.:;!?]$/.test(row.text);
  });
  return { paras: linesToParas(rows), unsure: unsure, score: score, total: total };
}
/* ---------- the enhancer: cleans a scanned page before it is read ---------- */
function grayOf(canvas) {
  var w = canvas.width, h = canvas.height, d = canvas.getContext('2d').getImageData(0, 0, w, h).data, g = new Uint8ClampedArray(w * h);
  for (var i = 0, j = 0; j < g.length; i += 4, j++) g[j] = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
  return g;
}
// The tilt of the page in degrees, found by trying small angles and keeping the one that makes the text lines sharpest.
function findTilt(g, w, h) {
  var step = Math.max(1, Math.round(w / 500)), sw = Math.floor(w / step), sh = Math.floor(h / step), pts = [], sum = 0, x, y;
  for (y = 0; y < sh; y++) for (x = 0; x < sw; x++) sum += g[y * step * w + x * step];
  var cut = (sum / (sw * sh)) * 0.72;
  for (y = Math.floor(sh * 0.04); y < sh * 0.96; y++) for (x = Math.floor(sw * 0.06); x < sw * 0.94; x++) if (g[y * step * w + x * step] < cut) pts.push(x, y);
  if (pts.length < 400) return 0;
  function score(deg) {
    var t = Math.tan(deg * Math.PI / 180), rows = new Float64Array(sh + sw), n = 0, s = 0;
    for (var i = 0; i < pts.length; i += 2) rows[Math.round(pts[i + 1] + pts[i] * t) + (sw >> 1)]++;
    for (i = 1; i < rows.length; i++) { var dlt = rows[i] - rows[i - 1]; s += dlt * dlt; }
    return s;
  }
  var best = 0, bestS = score(0), a, sc;
  for (a = -5; a <= 5; a += 0.5) { sc = score(a); if (sc > bestS) { bestS = sc; best = a; } }
  var mid = best;
  for (a = mid - 0.4; a <= mid + 0.4; a += 0.1) { sc = score(a); if (sc > bestS) { bestS = sc; best = a; } }
  return bestS > score(0) * 1.08 ? best : 0;
}
function rotated(canvas, deg) {
  var out = document.createElement('canvas'); out.width = canvas.width; out.height = canvas.height;
  var c = out.getContext('2d'); c.fillStyle = '#fff'; c.fillRect(0, 0, out.width, out.height);
  c.translate(out.width / 2, out.height / 2); c.rotate(deg * Math.PI / 180); c.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
  return out;
}
// Evens out the paper (shadows, grey or yellowed background) and darkens the print.
// mode 'clean' keeps soft edges; mode 'strong' turns the page to pure black on white for faint or patchy print.
function enhance(canvas, mode) {
  var g = grayOf(canvas), w = canvas.width, h = canvas.height;
  var tilt = findTilt(g, w, h);
  if (Math.abs(tilt) >= 0.3) { canvas = rotated(canvas, tilt); g = grayOf(canvas); }
  var B = Math.max(16, Math.round(Math.max(w, h) / 90)), bw = Math.ceil(w / B), bh = Math.ceil(h / B), bg = new Float32Array(bw * bh), x, y, i;
  for (var by = 0; by < bh; by++) for (var bx = 0; bx < bw; bx++) {
    var hist = new Uint32Array(256), n = 0, y1 = Math.min(h, (by + 1) * B), x1 = Math.min(w, (bx + 1) * B);
    for (y = by * B; y < y1; y += 2) for (x = bx * B; x < x1; x += 2) { hist[g[y * w + x]]++; n++; }
    var need = n * 0.2, v = 255; while (v > 0 && (need -= hist[v]) > 0) v--;     // the paper: the brightest fifth of the block
    bg[by * bw + bx] = v;
  }
  for (var pass = 0; pass < 2; pass++) {                                           // smooth the paper map
    var nb = new Float32Array(bw * bh);
    for (by = 0; by < bh; by++) for (bx = 0; bx < bw; bx++) {
      var s = 0, c = 0;
      for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) { var yy = by + dy, xx = bx + dx; if (yy >= 0 && yy < bh && xx >= 0 && xx < bw) { s += bg[yy * bw + xx]; c++; } }
      nb[by * bw + bx] = s / c;
    }
    bg = nb;
  }
  var out = document.createElement('canvas'); out.width = w; out.height = h;
  var ctx = out.getContext('2d'), img = ctx.createImageData(w, h), d = img.data, strong = mode === 'strong';
  for (y = 0; y < h; y++) {
    var fy = Math.min(bh - 1, Math.max(0, (y - B / 2) / B)), y0 = Math.floor(fy), y1b = Math.min(bh - 1, y0 + 1), ty = fy - y0;
    for (x = 0; x < w; x++) {
      var fx = Math.min(bw - 1, Math.max(0, (x - B / 2) / B)), x0 = Math.floor(fx), x1b = Math.min(bw - 1, x0 + 1), tx = fx - x0;
      var paper = (bg[y0 * bw + x0] * (1 - tx) + bg[y0 * bw + x1b] * tx) * (1 - ty) + (bg[y1b * bw + x0] * (1 - tx) + bg[y1b * bw + x1b] * tx) * ty;
      if (paper < 90) paper = 90;
      var r = g[y * w + x] / paper, val;                                           // 1 = paper, 0 = ink
      if (strong) val = r < 0.72 ? 0 : 255;
      else if (mode === 'dark') { r = (r - 0.3) / 0.62; val = r <= 0 ? 0 : r >= 1 ? 255 : Math.round(255 * Math.pow(r, 2.4)); }
      else { r = (r - 0.35) / 0.55; val = r <= 0 ? 0 : r >= 1 ? 255 : Math.round(255 * Math.pow(r, 1.3)); }
      i = (y * w + x) * 4; d[i] = d[i + 1] = d[i + 2] = val; d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return { canvas: out, tilt: tilt };
}
async function renderPage(page, target) {
  var base = page.getViewport({ scale: 1 });
  var scale = Math.max(0.75, Math.min(target ? 6 : 3, (target || 3000) / Math.max(base.width, base.height)));
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
      var page = await doc.getPage(n), t = await pageText(page), pic = await pageImageInfo(page, pdfjs);
      if (t.chars >= 40 && pic.cover < 0.6) pages.push({ n: n, paras: t.paras, ocr: false });
      else if (t.chars >= 40) {
        // A scanned page that already carries text from the scanner. That text can be wrong, so it is checked like any scan.
        status('ok', 'Page ' + n + ' of ' + doc.numPages + ' is a scan with text added by the scanner. Reading it a second time to compare.');
        usedOcr = true;
        var cv = await renderPage(page), bl = await canvasBlob(cv);
        var own = await readScan(cv), warn1 = scanWarning(cv, pic.dpi, pic.dpi ? 0 : pic.px, own.total), layer = t.paras.join('\n\n'), mine = own.paras.join('\n\n');
        var useLayer = realWords(layer) * 1.05 >= own.score;
        pages.push({ n: n, ocr: true, blob: bl, warn: warn1, layer: true, usesLayer: useLayer,
          paras: useLayer ? t.paras : own.paras, alt: useLayer ? mine : layer,
          diffs: useLayer ? disagreements(layer, mine) : disagreements(mine, layer) });
        cv.width = cv.height = 0;
      } else {
        status('ok', 'Cleaning up and reading page ' + n + ' of ' + doc.numPages + ' as a scan. This takes several seconds a page.');
        usedOcr = true;
        var canvas = await renderPage(page);
        var blob = await canvasBlob(canvas);
        var got = await readScan(canvas), warn2 = scanWarning(canvas, pic.dpi, pic.dpi ? 0 : pic.px, got.total);
        pages.push({ n: n, paras: got.paras, unsure: got.unsure, ocr: true, blob: blob, warn: warn2 });
        canvas.width = canvas.height = 0;
      }
      page.cleanup();
    }
    await task.destroy();
  } else {
    status('ok', 'Cleaning up and reading the picture. This takes several seconds.');
    var c = await imageCanvas(file);
    var one = await readScan(c), warn3 = scanWarning(c, 0, Math.max(c.width, c.height), one.total);
    pages.push({ n: 1, paras: one.paras, unsure: one.unsure, ocr: true, blob: file, warn: warn3 });
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
      var lab = document.createElement('label'); lab.htmlFor = 'c-text-' + p.n;
      function label() { lab.textContent = 'Page ' + p.n + (p.layer ? (p.usesLayer ? ": the scanner's text" : ": what Sitiri read (the scanner's text looked worse)") : ': what Sitiri read'); }
      label();
      if (p.warn) { var w = document.createElement('p'); w.className = 'note warn c-warn'; w.textContent = p.warn; side.appendChild(w); }
      var ta = document.createElement('textarea'); ta.id = 'c-text-' + p.n; ta.value = p.paras.join('\n\n'); ta.spellcheck = false;
      side.appendChild(lab); side.appendChild(ta);
      if (p.layer) {
        var d = document.createElement('div'); d.className = 'c-unsure c-diff';
        if (p.diffs.length) {
          var other = p.usesLayer ? 'Sitiri read' : 'the scanner has';
          d.appendChild(document.createTextNode('The two readings of this page disagree in ' + p.diffs.length + ' place(s). Check these against the page:'));
          var ul = document.createElement('ul');
          p.diffs.slice(0, 40).forEach(function (pair) {
            var li = document.createElement('li'), b1 = document.createElement('b'); b1.textContent = pair[0];
            li.appendChild(b1); li.appendChild(document.createTextNode(' \u2014 ' + other + ' \u201c' + pair[1] + '\u201d')); ul.appendChild(li);
          });
          d.appendChild(ul);
          if (p.diffs.length > 40) d.appendChild(document.createTextNode('and ' + (p.diffs.length - 40) + ' more.'));
        } else d.textContent = "Sitiri read this page too, and its reading matches the scanner's text.";
        side.appendChild(d);
        var swap = document.createElement('button'); swap.type = 'button'; swap.className = 'btn alt';
        function swapLabel() { swap.textContent = p.usesLayer ? "Use Sitiri's reading instead" : "Use the scanner's text instead"; }
        swapLabel();
        swap.onclick = function () { var now = ta.value; ta.value = p.alt; p.alt = now; p.usesLayer = !p.usesLayer; swapLabel(); label(); d.classList.add('hide'); };
        var srow = document.createElement('div'); srow.className = 'row'; srow.appendChild(swap); side.appendChild(srow);
      }
      if (p.unsure && p.unsure.length) { var hint = document.createElement('p'); hint.className = 'c-unsure'; hint.textContent = 'Check these closely. Sitiri was least sure of: ' + p.unsure.join('   '); side.appendChild(hint); }
      var again = document.createElement('button'); again.type = 'button'; again.className = 'btn alt'; again.textContent = 'Read this page again, stronger clean-up';
      var first = null;
      again.onclick = async function () {
        if (first !== null) { ta.value = first; first = null; again.textContent = 'Read this page again, stronger clean-up'; return; }
        again.disabled = true; again.textContent = 'Reading again\u2026';
        try {
          var bmp = await createImageBitmap(p.blob), c2 = document.createElement('canvas');
          c2.width = bmp.width; c2.height = bmp.height; c2.getContext('2d').drawImage(bmp, 0, 0);
          var e2 = enhance(c2, 'strong'), got2 = await ocrCanvas(e2.canvas);
          await stopOcr();
          first = ta.value; ta.value = got2.paras.join('\n\n'); again.textContent = 'Go back to the first reading';
        } catch (err) { again.textContent = 'Could not read it again'; }
        again.disabled = false;
      };
      var arow = document.createElement('div'); arow.className = 'row'; arow.appendChild(again); side.appendChild(arow);
      wrap.appendChild(img); wrap.appendChild(side); box.appendChild(wrap);
      p.field = ta;
    });
    var layered = scans.filter(function (p) { return p.layer; }).length, poor = scans.filter(function (p) { return p.warn; }).length;
    status('warn', scans.length + ' page(s) are scans.' + (layered ? ' ' + layered + ' came with text from the scanner, which Sitiri compared with its own reading.' : '') + (poor ? ' ' + poor + ' may be too coarse or faint to read well.' : '') + ' Scan reading makes mistakes. Compare each page with its text and correct it, especially names and numbers, then press "Use this text".');
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
window.__scan = { loadPdfjs: loadPdfjs, getOcr: getOcr, stopOcr: stopOcr, renderPage: renderPage, enhance: enhance, ocrCanvas: ocrCanvas, readScan: readScan };
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
