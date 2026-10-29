if (window.pdfjsLib) pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
(() => {
"use strict";
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const state = { books: [], urls: new Map(), reader: null };
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} }
};

/* ---------- toast ---------- */
let toastT;
function toast(msg, ms = 3200) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, ms); }

/* ---------- storage ---------- */
/* Stores: 'meta' holds each book's details (title, last opened, ...), 'books' holds its file and cover, 'marks' holds
   highlights and bookmarks. Details change often (every open), and putting a record that contains a Blob makes
   IndexedDB write the whole file again, so files are written once, on import, and never rewritten. */
const metaOf = b => { const { blob, cover, ...m } = b; return m; };
const DB = {
  db: null, mem: new Map(), memMarks: new Map(),
  async open() {
    try {
      this.db = await new Promise((res, rej) => {
        const r = indexedDB.open('reflow-reader', 3);
        r.onupgradeneeded = e => {
          const d = r.result;
          if (!d.objectStoreNames.contains('books')) d.createObjectStore('books', { keyPath: 'id' });
          if (!d.objectStoreNames.contains('marks')) d.createObjectStore('marks', { keyPath: 'id' }).createIndex('bookId', 'bookId');
          if (!d.objectStoreNames.contains('meta')) {
            const meta = d.createObjectStore('meta', { keyPath: 'id' });
            // up to version 2, 'books' held details and file together: copy the details out (the files stay where they are)
            if (e.oldVersion > 0) r.transaction.objectStore('books').openCursor().onsuccess = ev => {
              const c = ev.target.result; if (!c) return;
              meta.put(metaOf(c.value)); c.continue();
            };
          }
        };
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
      });
    } catch { this.db = null; }
  },
  req(store, mode, fn) {
    return new Promise((res, rej) => { const r = fn(this.db.transaction(store, mode).objectStore(store)); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  },
  async all() {
    if (this.db) {
      try {
        const [metas, files] = await Promise.all([this.req('meta', 'readonly', s => s.getAll()), this.req('books', 'readonly', s => s.getAll())]);
        const byId = new Map(files.map(f => [f.id, f]));
        return metas.filter(m => byId.has(m.id)).map(m => Object.assign(m, { blob: byId.get(m.id).blob, cover: byId.get(m.id).cover || null }));
      } catch {}
    }
    return [...this.mem.values()];
  },
  /* a new book: file and details together */
  async add(b) {
    this.mem.set(b.id, b);
    if (!this.db) return;
    try {
      await new Promise((res, rej) => {
        const tx = this.db.transaction(['books', 'meta'], 'readwrite');
        tx.objectStore('books').put({ id: b.id, blob: b.blob, cover: b.cover || null });
        tx.objectStore('meta').put(metaOf(b));
        tx.oncomplete = res; tx.onerror = tx.onabort = () => rej(tx.error);
      });
    } catch { toast('Could not save to app storage. The book lasts until you close the app.'); }
  },
  /* details only: never rewrites the file */
  async put(b) { this.mem.set(b.id, b); if (this.db) { try { await this.req('meta', 'readwrite', s => s.put(metaOf(b))); } catch {} } },
  async del(id) {
    this.mem.delete(id);
    if (!this.db) return;
    try { await new Promise((res, rej) => { const tx = this.db.transaction(['books', 'meta'], 'readwrite'); tx.objectStore('books').delete(id); tx.objectStore('meta').delete(id); tx.oncomplete = res; tx.onerror = tx.onabort = () => rej(tx.error); }); } catch {}
  },
  async marksFor(bookId) {
    if (this.db) { try { return await this.req('marks', 'readonly', s => s.index('bookId').getAll(bookId)); } catch {} }
    return [...this.memMarks.values()].filter(m => m.bookId === bookId);
  },
  async allMarks() { if (this.db) { try { return await this.req('marks', 'readonly', s => s.getAll()); } catch {} } return [...this.memMarks.values()]; },
  async putMark(m) { this.memMarks.set(m.id, m); if (this.db) { try { await this.req('marks', 'readwrite', s => s.put(m)); } catch {} } },
  async delMark(id) { this.memMarks.delete(id); if (this.db) { try { await this.req('marks', 'readwrite', s => s.delete(id)); } catch {} } },
  async delMarksFor(bookId) { for (const m of await this.marksFor(bookId)) await this.delMark(m.id); }
};

/* ---------- native bridge (Capacitor) ---------- */
const Cap = window.Capacitor;
const isNative = !!(Cap && Cap.isNativePlatform && Cap.isNativePlatform());
function plug(name) {
  if (!isNative) return null;
  try { return (Cap.Plugins && Cap.Plugins[name]) || (Cap.registerPlugin ? Cap.registerPlugin(name) : null); } catch { return null; }
}
const NATIVE = () => plug('ReflowNative');
function keepAwake(on) { const N = NATIVE(); if (N) try { N.setKeepAwake({ on: !!on }).catch(() => {}); } catch {} }
function volumePaging(on) { const N = NATIVE(); if (N) try { N.setVolumePaging({ on: !!on }).catch(() => {}); } catch {} }
const PAPER_BG = { white: '#FFFFFF', sepia: '#F5EDDF', night: '#14161C' };
function paperNow() { return prefs.paper === 'auto' ? (isDark() ? 'night' : 'white') : prefs.paper; }
function setStatusBar() {
  const SB = plug('StatusBar'); if (!SB) return;
  const R = state.reader;
  const night = R ? paperNow() === 'night' : isDark();
  const bg = R ? (PAPER_BG[paperNow()] || '#FFFFFF') : (isDark() ? '#0E1016' : '#F3F4F7');
  try { SB.setStyle({ style: night ? 'DARK' : 'LIGHT' }).catch(() => {}); } catch {}
  try { SB.setBackgroundColor({ color: bg }).catch(() => {}); } catch {}
  const N = NATIVE();
  if (N) try { N.setImmersive({ on: !!(R && prefs.full), color: bg }).catch(() => {}); } catch {}
}
function blobToB64(blob) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] || ''); r.onerror = () => rej(r.error); r.readAsDataURL(blob); });
}
const safeName = s => (s || 'file').replace(/[\\/:*?"<>|\u0000-\u001F]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 100) || 'file';
async function saveBlob(filename, blob, dialogTitle) {
  if (!isNative) {
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename;
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 8000); return;
  }
  const FS = plug('Filesystem'), SH = plug('Share');
  try {
    toast('Preparing the file…', 60000);
    const path = `share/${filename}`;
    try { await FS.deleteFile({ path, directory: 'CACHE' }); } catch {}
    const CH = 3 * 1024 * 1024; // multiple of 3, so base64 chunks join cleanly
    let off = 0;
    do {
      const b64 = await blobToB64(blob.slice(off, off + CH));
      if (off === 0) await FS.writeFile({ path, data: b64, directory: 'CACHE', recursive: true });
      else await FS.appendFile({ path, data: b64, directory: 'CACHE' });
      off += CH;
      if (blob.size > 4 * CH) toast(`Preparing the file… ${Math.min(99, Math.round(off / blob.size * 100))}%`, 60000);
    } while (off < blob.size);
    const { uri } = await FS.getUri({ path, directory: 'CACHE' });
    $('#toast').hidden = true;
    await SH.share({ title: filename, files: [uri], dialogTitle: dialogTitle || 'Share or save' });
  } catch (e) {
    $('#toast').hidden = true;
    const msg = (e && e.message) || '';
    if (/cancel/i.test(msg)) return;
    toast('Could not share the file. ' + msg);
  }
}

/* ---------- text helpers ---------- */
const LIG = { 'ﬀ': 'ff', 'ﬁ': 'fi', 'ﬂ': 'fl', 'ﬃ': 'ffi', 'ﬄ': 'ffl', 'ﬅ': 'st', 'ﬆ': 'st' };
function clean(s) {
  return String(s).replace(/[ﬀ-ﬆ]/g, c => LIG[c])
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
}
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const pad = (n, w) => String(n).padStart(w, '0');
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); }));
const fmt = n => n.toLocaleString('en-IN');
const fmtDur = ms => { const s = Math.round(ms / 1000); if (s < 60) return `${s} s`; const m = Math.round(s / 60); if (m < 60) return `${m} min`; return `${Math.floor(m / 60)} h ${m % 60} min`; };
const tick = () => new Promise(r => setTimeout(r, 0));

/* ---------- EPUB builder ---------- */
const EPUB_CSS = `body{font-family:serif;line-height:1.55;margin:0 4%}
p{margin:0 0 .8em;text-indent:0}
p.small{font-size:.85em}
h1{font-size:1.6em;margin:1.2em 0 .6em}h2{font-size:1.3em;margin:1.1em 0 .5em}h3{font-size:1.1em;margin:1em 0 .4em}
figure{margin:1em 0;text-align:center}figure img{max-width:100%}
div.eq{margin:.7em 0;text-align:center}div.eq img{max-width:100%;vertical-align:middle}
figcaption{font-size:.75em;color:#666}`;
const IMG_TYPE = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png' };

function chapterXhtml(title, body) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="en" lang="en">
<head>
<meta charset="UTF-8"/>
<title>${esc(title)}</title>
<link rel="stylesheet" type="text/css" href="../style.css"/>
</head>
<body>
<section epub:type="chapter">
${body}
</section>
</body>
</html>`;
}

async function buildEpub({ title, author, chapters, images = [], cover = null, lang = 'en' }) {
  const zip = new JSZip();
  const id = uuid();
  const mod = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const chName = i => `text/ch${pad(i + 1, 3)}.xhtml`;
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file('META-INF/container.xml', `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`);
  zip.file('OEBPS/style.css', EPUB_CSS);
  chapters.forEach((c, i) => zip.file('OEBPS/' + chName(i), chapterXhtml(c.title, c.html)));
  for (const im of images) zip.file('OEBPS/images/' + im.name, im.blob, { compression: 'STORE' });
  if (cover) zip.file('OEBPS/images/cover.jpg', cover, { compression: 'STORE' });
  zip.file('OEBPS/nav.xhtml', `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="en" lang="en">
<head><meta charset="UTF-8"/><title>Contents</title><link rel="stylesheet" type="text/css" href="style.css"/></head>
<body><nav epub:type="toc" id="toc"><h1>Contents</h1><ol>
${chapters.map((c, i) => `<li><a href="${chName(i)}">${esc(c.title)}</a></li>`).join('\n')}
</ol></nav></body></html>`);
  zip.file('OEBPS/toc.ncx', `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="urn:uuid:${id}"/><meta name="dtb:depth" content="1"/><meta name="dtb:totalPageCount" content="0"/><meta name="dtb:maxPageNumber" content="0"/></head>
<docTitle><text>${esc(title)}</text></docTitle><navMap>
${chapters.map((c, i) => `<navPoint id="np${i + 1}" playOrder="${i + 1}"><navLabel><text>${esc(c.title)}</text></navLabel><content src="${chName(i)}"/></navPoint>`).join('\n')}
</navMap></ncx>`);
  zip.file('OEBPS/content.opf', `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="${lang}">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="bookid">urn:uuid:${id}</dc:identifier>
<dc:title>${esc(title)}</dc:title>
${author ? `<dc:creator>${esc(author)}</dc:creator>` : ''}
<dc:language>${lang}</dc:language>
<meta property="dcterms:modified">${mod}</meta>
${cover ? '<meta name="cover" content="cover-img"/>' : ''}
</metadata>
<manifest>
<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
<item id="css" href="style.css" media-type="text/css"/>
${cover ? '<item id="cover-img" href="images/cover.jpg" media-type="image/jpeg" properties="cover-image"/>' : ''}
${images.map((im, i) => `<item id="img${i}" href="images/${im.name}" media-type="${IMG_TYPE[im.name.split('.').pop()] || 'image/jpeg'}"/>`).join('\n')}
${chapters.map((c, i) => `<item id="ch${i + 1}" href="${chName(i)}" media-type="application/xhtml+xml"/>`).join('\n')}
</manifest>
<spine toc="ncx">
${chapters.map((c, i) => `<itemref idref="ch${i + 1}"/>`).join('\n')}
</spine>
</package>`);
  return zip.generateAsync({ type: 'blob', mimeType: 'application/epub+zip', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}

/* ---------- EPUB reading ---------- */
function parseXml(s) {
  let d = new DOMParser().parseFromString(s, 'application/xml');
  if (d.getElementsByTagName('parsererror').length) d = new DOMParser().parseFromString(s, 'text/html');
  return d;
}
const dirOf = p => { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); };
function decode(s) { try { return decodeURIComponent(s); } catch { return s; } }
function resolvePath(base, href) {
  href = decode((href || '').split('#')[0].split('?')[0]);
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return href;
  const parts = href.startsWith('/') ? [] : base.split('/').filter(Boolean);
  for (const seg of href.split('/')) { if (seg === '..') parts.pop(); else if (seg && seg !== '.') parts.push(seg); }
  return parts.join('/');
}
function zipFile(zip, path) { return zip.file(path) || zip.file(encodeURI(path)) || zip.file(decode(path)) || null; }
const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp' };

async function parseEpub(blob) {
  const zip = await JSZip.loadAsync(blob);
  const cf = zip.file('META-INF/container.xml');
  if (!cf) throw new Error('This file has no container.xml, so it is not a valid EPUB.');
  const cx = parseXml(await cf.async('string'));
  const rf = cx.getElementsByTagNameNS('*', 'rootfile')[0];
  const opfPath = rf && rf.getAttribute('full-path');
  const opfFile = opfPath && zipFile(zip, opfPath);
  if (!opfFile) throw new Error('The EPUB package file is missing.');
  // shop DRM (Adobe, Apple, Readium LCP) encrypts the chapters; font obfuscation alone is fine (fonts are not used anyway)
  const encF = zip.file('META-INF/encryption.xml');
  const encOther = encF && [...parseXml(await encF.async('string')).getElementsByTagNameNS('*', 'EncryptionMethod')].some(m => !/idpf\.org\/2008\/embedding|ns\.adobe\.com\/pdf\/enc#RC/.test(m.getAttribute('Algorithm') || ''));
  if (encOther || zip.file('META-INF/sinf.xml') || zip.file('META-INF/license.lcpl')) throw new Error('This EPUB is locked with DRM, so it only opens in the app of the shop that sold it. Books without DRM work in Panna.');
  const opf = parseXml(await opfFile.async('string'));
  const base = dirOf(opfPath);
  const txt = tag => { const e = opf.getElementsByTagNameNS('*', tag)[0]; return e ? e.textContent.replace(/\s+/g, ' ').trim() : ''; };
  const man = new Map();
  for (const it of opf.getElementsByTagNameNS('*', 'item')) man.set(it.getAttribute('id'), { href: resolvePath(base, it.getAttribute('href') || ''), type: it.getAttribute('media-type') || '', props: it.getAttribute('properties') || '' });
  const spine = [];
  const spineEl0 = opf.getElementsByTagNameNS('*', 'spine')[0];
  const lang0 = txt('language');
  // right-to-left books (Urdu, Shahmukhi Punjabi, Arabic, Persian, Hebrew…) turn pages the other way
  const rtl = spineEl0 && spineEl0.getAttribute('page-progression-direction') ? spineEl0.getAttribute('page-progression-direction') === 'rtl' : /^(ar|fa|ur|he|iw|ps|sd|ug|yi|dv|ckb|pnb)(-|$)/i.test(lang0);
  for (const ir of opf.getElementsByTagNameNS('*', 'itemref')) { if (ir.getAttribute('linear') === 'no') continue; const m = man.get(ir.getAttribute('idref')); if (m && !spine.includes(m.href)) spine.push(m.href); }
  let toc = [];
  const navItem = [...man.values()].find(m => m.props.split(/\s+/).includes('nav'));
  if (navItem && zipFile(zip, navItem.href)) {
    const nd = parseXml(await zipFile(zip, navItem.href).async('string'));
    const navs = [...nd.getElementsByTagNameNS('*', 'nav')];
    const tn = navs.find(n => ((n.getAttributeNS && n.getAttributeNS('http://www.idpf.org/2007/ops', 'type')) || n.getAttribute('epub:type') || '').includes('toc')) || navs[0];
    if (tn) for (const a of tn.getElementsByTagNameNS('*', 'a')) {
      const h = a.getAttribute('href'); if (!h) continue;
      let depth = 0, e = a.parentNode; while (e && e !== tn) { if (e.localName === 'ol') depth++; e = e.parentNode; }
      toc.push({ title: a.textContent.replace(/\s+/g, ' ').trim(), path: resolvePath(dirOf(navItem.href), h), frag: h.split('#')[1] || '', depth: Math.max(0, depth - 1) });
    }
  }
  if (!toc.length) {
    const spineEl = opf.getElementsByTagNameNS('*', 'spine')[0];
    const ncx = spineEl && man.get(spineEl.getAttribute('toc'));
    if (ncx && zipFile(zip, ncx.href)) {
      const nd = parseXml(await zipFile(zip, ncx.href).async('string'));
      for (const np of nd.getElementsByTagNameNS('*', 'navPoint')) {
        const lab = np.getElementsByTagNameNS('*', 'text')[0], c = np.getElementsByTagNameNS('*', 'content')[0];
        if (!c) continue; const src = c.getAttribute('src') || '';
        let depth = 0, e = np.parentNode; while (e && e.localName === 'navPoint') { depth++; e = e.parentNode; }
        toc.push({ title: lab ? lab.textContent.trim() : 'Section', path: resolvePath(dirOf(ncx.href), src), frag: src.split('#')[1] || '', depth });
      }
    }
  }
  let coverPath = null;
  const ci = [...man.values()].find(m => m.props.split(/\s+/).includes('cover-image'));
  if (ci) coverPath = ci.href;
  else { const meta = [...opf.getElementsByTagNameNS('*', 'meta')].find(m => m.getAttribute('name') === 'cover'); const m = meta && man.get(meta.getAttribute('content')); if (m && /^image\//.test(m.type)) coverPath = m.href; }
  // uncompressed size of each section: progress is weighted by length, so a one-page cover doesn't count as much as a long chapter
  const sizes = spine.map(h => { const f = zipFile(zip, h); return Math.max(1, (f && f._data && f._data.uncompressedSize) || 1); });
  return { zip, title: txt('title'), author: txt('creator'), lang: lang0, spine, toc, coverPath, sizes, rtl };
}

/* ---------- sample book ---------- */
const SAMPLE = [
  { title: 'Welcome', html: `<h1>Welcome to Panna</h1>
<p>Panna is an offline reader for <b>EPUB</b>, <b>PDF</b> and <b>DjVu</b> files. Books open exactly as they are; nothing is converted, uploaded or tracked.</p>
<p>Tap <b>Add</b> on the library screen, or open a file from WhatsApp, Files or Drive and choose Panna.</p>
<h2>Turning pages</h2>
<ul>
<li>Tap the right side of the page to go forward and the left side to go back, or swipe.</li>
<li>Tap the middle to show or hide the menu.</li>
<li>The volume keys turn pages too. You can switch that off under <b>Aa</b>.</li>
</ul>` },
  { title: 'EPUB books', html: `<h1>EPUB books</h1>
<p>EPUB text flows to fit your screen. Under <b>Aa</b> you can change the text size, typeface, spacing, line width, hyphenation and page colour.</p>
<ul>
<li>Press and hold a word, drag to select, then pick a colour to highlight it or tap <b>Note</b>.</li>
<li>Select a single word and tap <b>Define</b> for an English dictionary entry. It works offline.</li>
<li>Tap a footnote number to read the note without losing your place.</li>
<li>The list button opens Contents, Search and Marks. Marks can be shared as a notes file.</li>
</ul>` },
  { title: 'PDF and DjVu', html: `<h1>PDF and DjVu</h1>
<p>PDF and DjVu pages are shown exactly as printed, so equations, tables and diagrams stay intact.</p>
<ul>
<li>Pinch or double-tap to zoom. Double-tap again to fit the page.</li>
<li>Choose <b>Scroll</b> for a continuous column of pages or <b>Pages</b> for one page at a time.</li>
<li><b>Night</b> and <b>Sepia</b> recolour the pages for reading in the dark.</li>
<li>In PDFs with real text you can select words, tap <b>Define</b> and search. Scanned PDFs and most DjVu books are pictures of pages, so they can be read and bookmarked but not searched.</li>
</ul>` }
];

/* ---------- theme ---------- */
let theme = LS.get('reflow:theme', 'light');
const mq = window.matchMedia ? matchMedia('(prefers-color-scheme: dark)') : null;
const isDark = () => theme === 'dark' || (theme === 'system' && !!(mq && mq.matches));
const THEME_ICON = {
  light: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  dark: '<svg viewBox="0 0 24 24"><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/></svg>',
  system: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 3.5v17A8.5 8.5 0 0 0 12 3.5z" fill="currentColor"/></svg>'
};
function applyTheme() {
  document.documentElement.dataset.theme = isDark() ? 'dark' : 'light';
  $('#theme-btn').innerHTML = THEME_ICON[theme];
  $('#theme-btn').setAttribute('aria-label', `Theme: ${theme}. Tap to change.`);
  $$('#theme-seg button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === theme)));
  if (state.reader) applyPrefs(); else setStatusBar();
}
function setTheme(t) { theme = t; LS.set('reflow:theme', t); applyTheme(); }
$('#theme-btn').addEventListener('click', () => { const order = ['light', 'dark', 'system']; setTheme(order[(order.indexOf(theme) + 1) % 3]); toast(`Theme: ${theme === 'system' ? 'follows the phone' : theme}`, 1600); });
$('#theme-seg').addEventListener('click', e => { const b = e.target.closest('button[data-v]'); if (b) setTheme(b.dataset.v); });
if (mq && mq.addEventListener) mq.addEventListener('change', () => { if (theme === 'system') applyTheme(); });

/* ---------- library ---------- */
const CLOTH = ['#2F46B8', '#1D5A48', '#7B2C3A', '#4A3A7C', '#2C5B7C', '#6A5424', '#3F4A5E', '#8A4B14'];
const hash = s => { let h = 0; for (const c of s) h = (h * 31 + c.codePointAt(0)) | 0; return Math.abs(h); };
const FMT_LABEL = { epub: 'EPUB', pdf: 'PDF', djvu: 'DjVu' };
const fmtOf = b => b.format || 'epub';
function urlFor(key, blob) { if (!blob) return null; if (!state.urls.has(key)) state.urls.set(key, URL.createObjectURL(blob)); return state.urls.get(key); }
const FINISHED = 0.99; // one threshold for the ✓ badge, the "Finished" label and leaving "Continue reading"
function progressOf(b) {
  const p = LS.get('reflow:pos:' + b.id, null); if (!p || !p.total) return 0;
  if (typeof p.p === 'number') return Math.min(1, Math.max(0, p.p)); // saved by the reader (EPUB: weighted by section length)
  return p.fixed ? Math.min(1, (p.page + 1) / p.total) : Math.min(1, (p.idx + p.frac) / p.total);
}
function placeOf(b) {
  const p = LS.get('reflow:pos:' + b.id, null);
  if (!p) return '';
  if (p.fixed) return `Page ${fmt(p.page + 1)} of ${fmt(p.total)}`;
  return `Section ${p.idx + 1} of ${p.total}`;
}
const lib = { q: '', sort: LS.get('reflow:sort', 'recent'), fmt: 'all' };
$('#lib-sort').value = lib.sort;
$('#lib-sort').addEventListener('change', e => { lib.sort = e.target.value; LS.set('reflow:sort', lib.sort); renderGrid(); });
$('#lib-q').addEventListener('input', e => { lib.q = e.target.value.trim().toLowerCase(); renderGrid(); });
$('#chips').addEventListener('click', e => { const c = e.target.closest('.chip'); if (!c) return; lib.fmt = c.dataset.f; renderChips(); renderGrid(); });

function coverEl(b, cls) {
  const cov = document.createElement('button'); cov.type = 'button'; cov.className = 'cover' + (cls ? ' ' + cls : '');
  cov.setAttribute('aria-label', 'Read ' + b.title);
  const cu = urlFor('cover:' + b.id, b.cover);
  if (cu) { const img = document.createElement('img'); img.src = cu; img.alt = ''; img.loading = 'lazy'; cov.append(img); if (fmtOf(b) !== 'epub') cov.classList.add('page'); }
  else {
    cov.style.background = CLOTH[hash(b.title) % CLOTH.length];
    const g = document.createElement('div'); g.className = 'gen';
    const t = document.createElement('b'); t.textContent = b.title;
    const s = document.createElement('small'); s.textContent = b.author || (b.id === 'sample' ? 'Panna' : FMT_LABEL[fmtOf(b)]);
    g.append(t, s); cov.append(g);
  }
  return cov;
}
function renderShelf() { renderHero(); renderChips(); renderGrid(); widgetSync(); }
function renderHero() {
  const cands = state.books.filter(b => b.opened && progressOf(b) < FINISHED).sort((a, b) => b.opened - a.opened);
  const b = cands[0];
  $('#hero').hidden = !b; if (!b) return;
  const old = $('#hero-cover'); const cov = coverEl(b); cov.id = 'hero-cover'; old.replaceWith(cov);
  cov.addEventListener('click', () => openBook(b.id));
  const cu = urlFor('cover:' + b.id, b.cover);
  $('#hero-bg').style.backgroundImage = cu ? `url("${cu}")` : 'none';
  $('#hero-bg').style.backgroundColor = cu ? '' : CLOTH[hash(b.title) % CLOTH.length];
  $('#hero-title').textContent = b.title;
  $('#hero-sub').textContent = [b.author, placeOf(b)].filter(Boolean).join(' · ');
  const pr = progressOf(b);
  $('#hero-bar').style.width = (pr * 100).toFixed(1) + '%';
  $('#hero-pct').textContent = Math.round(pr * 100) + '%';
  $('#hero-go').onclick = () => openBook(b.id);
}
function renderChips() {
  const counts = { all: state.books.length, epub: 0, pdf: 0, djvu: 0 };
  for (const b of state.books) counts[fmtOf(b)]++;
  const present = ['epub', 'pdf', 'djvu'].filter(f => counts[f]);
  const box = $('#chips'); box.replaceChildren();
  box.hidden = present.length < 2;
  if (!present.includes(lib.fmt)) lib.fmt = 'all';
  for (const f of ['all', ...present]) {
    const c = document.createElement('button'); c.type = 'button'; c.className = 'chip'; c.dataset.f = f;
    c.textContent = `${f === 'all' ? 'All' : FMT_LABEL[f]} ${counts[f]}`;
    c.setAttribute('aria-pressed', String(lib.fmt === f));
    box.append(c);
  }
}
function renderGrid() {
  const grid = $('#grid'); grid.replaceChildren();
  $('#lib-count').textContent = state.books.length ? `Library · ${state.books.length}` : 'Library';
  if (!state.books.length) {
    const e = document.createElement('div'); e.className = 'empty';
    e.innerHTML = `<svg viewBox="0 0 120 80" aria-hidden="true"><rect x="14" y="14" width="18" height="56" rx="2" fill="var(--accent-soft)" stroke="var(--accent)" stroke-width="1.5"/><rect x="34" y="8" width="16" height="62" rx="2" fill="var(--raise)" stroke="var(--line-strong)" stroke-width="1.5"/><rect x="52" y="18" width="20" height="52" rx="2" fill="var(--accent-soft)" stroke="var(--accent)" stroke-width="1.5"/><rect x="76" y="12" width="14" height="58" rx="2" transform="rotate(12 83 41)" fill="var(--raise)" stroke="var(--line-strong)" stroke-width="1.5"/><path d="M6 71h108" stroke="var(--line-strong)" stroke-width="2" stroke-linecap="round"/></svg><h3>Your library is empty</h3><p>Add EPUB, PDF or DjVu files. They stay on this phone.</p>`;
    const add = document.createElement('button'); add.type = 'button'; add.className = 'add'; add.textContent = 'Add books'; add.addEventListener('click', () => $('#file').click());
    e.append(add); grid.append(e); return;
  }
  let list = state.books.filter(b => (lib.fmt === 'all' || fmtOf(b) === lib.fmt) && (!lib.q || `${b.title} ${b.author || ''}`.toLowerCase().includes(lib.q)));
  const by = {
    recent: (a, b) => (b.opened || b.added || 0) - (a.opened || a.added || 0),
    added: (a, b) => (b.added || 0) - (a.added || 0),
    title: (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base', numeric: true }),
    author: (a, b) => (a.author || '￿').localeCompare(b.author || '￿', undefined, { sensitivity: 'base' }) || a.title.localeCompare(b.title),
    progress: (a, b) => progressOf(b) - progressOf(a)
  }[lib.sort] || (() => 0);
  list.sort(by);
  if (!list.length) { const p = document.createElement('p'); p.className = 'nores'; p.textContent = lib.q ? `Nothing matches “${lib.q}”.` : 'No books in this format.'; grid.append(p); return; }
  for (const b of list) {
    const card = document.createElement('article'); card.className = 'book';
    const cov = coverEl(b);
    const f = document.createElement('span'); f.className = 'fmt'; f.textContent = FMT_LABEL[fmtOf(b)].toUpperCase(); cov.append(f);
    const pr = progressOf(b);
    if (pr >= FINISHED) { const d = document.createElement('span'); d.className = 'done'; d.title = 'Finished'; d.innerHTML = '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>'; cov.append(d); }
    cov.addEventListener('click', () => openBook(b.id));
    const row = document.createElement('div'); row.className = 'b-row';
    const tx = document.createElement('div'); tx.className = 'b-txt';
    const t = document.createElement('div'); t.className = 'b-title'; t.textContent = b.title;
    const m = document.createElement('div'); m.className = 'b-meta';
    const bits = [];
    if (b.author) bits.push(b.author); else if (b.pages && fmtOf(b) !== 'epub') bits.push(`${fmt(b.pages)} pages`);
    bits.push(pr >= FINISHED ? 'Finished' : pr > 0 ? `${Math.round(pr * 100)}%` : 'New');
    m.textContent = bits.join(' · ');
    tx.append(t, m);
    const more = document.createElement('button'); more.type = 'button'; more.className = 'b-more'; more.setAttribute('aria-label', 'Options for ' + b.title);
    more.innerHTML = '<svg viewBox="0 0 24 24"><circle cx="12" cy="5" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="12" cy="19" r="1.8"/></svg>';
    more.addEventListener('click', () => openBookSheet(b));
    row.append(tx, more);
    card.append(cov, row);
    if (pr > 0 && pr < FINISHED) { const bar = document.createElement('div'); bar.className = 'b-prog'; const bi = document.createElement('i'); bi.style.width = (pr * 100) + '%'; bar.append(bi); card.append(bar); }
    grid.append(card);
  }
}

/* library sheets */
function closeLSheets() { $('#book-sheet').hidden = true; $('#set-sheet').hidden = true; $('#lscrim').hidden = true; }
const lsheetOpen = () => !$('#book-sheet').hidden || !$('#set-sheet').hidden;
$('#lscrim').addEventListener('click', closeLSheets);
$('#settings-btn').addEventListener('click', () => { closeLSheets(); $('#set-sheet').hidden = false; $('#lscrim').hidden = false; });
let sheetBook = null, rmArmed = null;
function openBookSheet(b) {
  closeLSheets(); sheetBook = b;
  $('#bs-title').textContent = b.title;
  const sz = b.blob && b.blob.size ? ` · ${(b.blob.size / 1048576).toFixed(b.blob.size > 10485760 ? 0 : 1)} MB` : '';
  $('#bs-sub').textContent = [b.author, FMT_LABEL[fmtOf(b)] + (b.pages && fmtOf(b) !== 'epub' ? ` · ${fmt(b.pages)} pages` : '') + sz].filter(Boolean).join(' · ');
  $('#bs-share').hidden = b.id === 'sample';
  $('#bs-reset').hidden = !LS.get('reflow:pos:' + b.id, null);
  clearTimeout(rmArmed); rmArmed = null; $('#bs-remove-t').textContent = 'Remove from library';
  $('#book-sheet').hidden = false; $('#lscrim').hidden = false;
}
$('#bs-open').addEventListener('click', () => { const b = sheetBook; closeLSheets(); if (b) openBook(b.id); });
$('#bs-share').addEventListener('click', () => { const b = sheetBook; closeLSheets(); if (b) saveBlob(safeName(b.title) + '.' + ({ epub: 'epub', pdf: 'pdf', djvu: 'djvu' }[fmtOf(b)]), b.blob, 'Share or save the book'); });
$('#bs-reset').addEventListener('click', () => { const b = sheetBook; closeLSheets(); if (!b) return; LS.del('reflow:pos:' + b.id); b.opened = 0; if (b.id !== 'sample') DB.put(b); renderShelf(); toast('Marked as unread.'); });
$('#bs-remove').addEventListener('click', async () => {
  const b = sheetBook; if (!b) return;
  if (!rmArmed) { $('#bs-remove-t').textContent = 'Tap again to remove'; rmArmed = setTimeout(() => { $('#bs-remove-t').textContent = 'Remove from library'; rmArmed = null; }, 3000); return; }
  clearTimeout(rmArmed); rmArmed = null; closeLSheets(); await removeBook(b);
});
async function removeBook(b) {
  state.books = state.books.filter(x => x.id !== b.id);
  if (b.id === 'sample') LS.set('reflow:hideSample', true); else await DB.del(b.id);
  await DB.delMarksFor(b.id);
  LS.del('reflow:pos:' + b.id);
  const u = state.urls.get('cover:' + b.id); if (u) { URL.revokeObjectURL(u); state.urls.delete('cover:' + b.id); }
  renderShelf(); toast(`Removed “${b.title}”.`);
}

/* ---------- adding books ---------- */
$('#add-btn').addEventListener('click', () => $('#file').click());
$('#file').addEventListener('change', e => { const fs = [...e.target.files]; e.target.value = ''; handleFiles(fs); });
let dragN = 0;
window.addEventListener('dragenter', e => { if (state.reader || !e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return; dragN++; $('#drop-hint').hidden = false; });
window.addEventListener('dragleave', () => { if (--dragN <= 0) { dragN = 0; $('#drop-hint').hidden = true; } });
window.addEventListener('dragover', e => { if (!state.reader) e.preventDefault(); });
window.addEventListener('drop', e => { e.preventDefault(); dragN = 0; $('#drop-hint').hidden = true; if (!state.reader && e.dataTransfer) handleFiles([...e.dataTransfer.files]); });

async function sniff(f) {
  const h = new Uint8Array(await f.slice(0, 1024).arrayBuffer());
  const s = String.fromCharCode(...h.slice(0, 16));
  if (s.startsWith('%PDF')) return 'pdf';
  if (s.startsWith('AT&TFORM') || s.startsWith('FORM')) return 'djvu';
  // zip before the loose "%PDF-" check below: a backup can store a PDF as its first entry
  if (h[0] === 0x50 && h[1] === 0x4B) {
    const first = String.fromCharCode(...h.slice(30, 38)), head = String.fromCharCode(...h.slice(30, 90));
    if (first === 'mimetype' && head.includes('application/epub+zip')) return 'epub';
    try { const z = await zipEntries(f); if (z.has('reflow-backup.json')) return 'backup'; if (z.has('META-INF/container.xml')) return 'epub'; } catch {} // central directory only: never loads the file
    return 'zip';
  }
  if (String.fromCharCode(...h).includes('%PDF-')) return 'pdf'; // some PDFs have junk before the header
  const ext =((f.name || '').match(/\.([a-z0-9]+)$/i) || [])[1];
  return { epub: 'epub', pdf: 'pdf', djvu: 'djvu', djv: 'djvu' }[(ext || '').toLowerCase()] || 'unknown';
}
async function handleFile(f) {
  let kind; try { kind = await sniff(f); } catch { kind = 'unknown'; }
  if (kind === 'backup') { await importBackup(f); return null; }
  if (!['epub', 'pdf', 'djvu'].includes(kind)) { toast(`${f.name || 'That file'} is not an EPUB, PDF or DjVu file.`, 4000); return null; }
  const dup = state.books.find(b => b.fileName && b.fileName === f.name && b.blob && b.blob.size === f.size);
  if (dup) { toast(`“${dup.title}” is already in your library.`); return dup; }
  toast(`Adding ${f.name || 'book'}…`, 60000);
  try {
    const rec = kind === 'epub' ? await importEpub(f) : kind === 'pdf' ? await importPdf(f) : await importDjvu(f);
    rec.id = uuid(); rec.format = kind; rec.blob = f; rec.fileName = f.name || ''; rec.added = Date.now();
    await DB.add(rec); state.books.push(rec); renderShelf();
    toast(`Added “${rec.title}”.`);
    return rec;
  } catch (e) { toast((e && e.message) || `${f.name} could not be added.`, 5000); return null; }
}
async function handleFiles(files) {
  let last = null; for (const f of files) { const r = await handleFile(f); if (r) last = r; }
  return last;
}
const nameTitle = n => (n || 'Untitled').replace(/\.(epub|pdf|djvu|djv)$/i, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Untitled';
async function thumbFromCanvas(c) { return new Promise(r => c.toBlob(r, 'image/jpeg', 0.84)); }
async function importEpub(f) {
  const bk = await parseEpub(f);
  let cover = null;
  if (bk.coverPath) { const cf = zipFile(bk.zip, bk.coverPath); if (cf) { const ext = bk.coverPath.split('.').pop().toLowerCase(); cover = new Blob([await cf.async('arraybuffer')], { type: MIME[ext] || 'image/jpeg' }); } }
  return { title: bk.title || nameTitle(f.name), author: bk.author, cover, pages: bk.spine.length };
}
async function importPdf(f) {
  let pdf;
  try { pdf = await BlobRange.open(f); }
  catch (e) { throw new Error(e && e.name === 'PasswordException' ? 'This PDF is password-protected. Remove the password in another app, then add it again.' : `${f.name} could not be opened as a PDF.`); }
  try {
    let info = {}; try { info = (await pdf.getMetadata()).info || {}; } catch {}
    let title = clean(info.Title || '').trim();
    if (!title || title.length < 3 || /^(untitled|document\d*|microsoft word|slide \d+|title)$/i.test(title) || /\.(docx?|pdf|tex|indd|dvi)$/i.test(title)) title = nameTitle(f.name);
    let author = clean(info.Author || '').trim().slice(0, 120);
    if (/^\(?(anonymous|unknown|user|admin|administrator|owner|author|none|n\/a|default)\)?$/i.test(author) || /^[\W\d_]+$/.test(author)) author = '';
    let cover = null;
    try {
      const p = await pdf.getPage(1); const v = p.getViewport({ scale: 1 }); const vp = p.getViewport({ scale: 420 / v.width });
      const c = document.createElement('canvas'); c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
      const ctx = c.getContext('2d'); ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, c.width, c.height);
      await p.render({ canvasContext: ctx, viewport: vp }).promise; cover = await thumbFromCanvas(c); c.width = c.height = 0;
    } catch {}
    return { title, author, cover, pages: pdf.numPages };
  } finally { try { await pdf.destroy(); } catch {} }
}
async function importDjvu(f) {
  if (!window.DjVu) throw new Error('The DjVu engine did not load. Reinstall the app.');
  const w = new DjVu.Worker();
  try {
    try { await w.createDocument(await f.arrayBuffer()); }
    catch { throw new Error(`${f.name} could not be opened as a DjVu book. Multi-file (indirect) DjVu books are not supported.`); }
    const n = await w.doc.getPagesQuantity().run();
    let cover = null;
    try {
      const r = await w.doc.getPage(1).createPngObjectUrl().run();
      const img = new Image(); img.src = r.url; await img.decode();
      const c = document.createElement('canvas'); const sc = 420 / img.naturalWidth;
      c.width = 420; c.height = Math.round(img.naturalHeight * sc);
      const ctx = c.getContext('2d'); ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, c.width, c.height); ctx.drawImage(img, 0, 0, c.width, c.height);
      cover = await thumbFromCanvas(c); c.width = c.height = 0; try { w.revokeObjectURL(r.url); } catch {}
    } catch {}
    return { title: nameTitle(f.name), author: '', cover, pages: n };
  } finally { setTimeout(() => { try { w.terminate(); } catch {} }, 200); }
}

/* ---------- zip (stored, streamed) ----------
   A backup holds every book, so it can be several GB. JSZip builds the whole archive in memory and has no ZIP64,
   so backups are written and read here: entries are stored uncompressed, the archive is a Blob that only refers
   to the book files (nothing is copied into memory), and reading takes slices of the chosen file. */
// CRC-32 by "slicing by 8": eight bytes per step with eight tables, several times faster than one byte at a time
const CRC_T = (() => {
  const t = new Uint32Array(256 * 8);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  for (let k = 1; k < 8; k++) for (let n = 0; n < 256; n++) { const p = t[(k - 1) * 256 + n]; t[k * 256 + n] = (p >>> 8) ^ t[p & 255]; }
  return t;
})();
async function crc32(blob, onBytes) {
  let c = 0xFFFFFFFF; const CH = 4 << 20;
  for (let off = 0; off < blob.size; off += CH) {
    const b = new Uint8Array(await blob.slice(off, off + CH).arrayBuffer());
    const T = CRC_T, L = b.length - 7; let i = 0;
    for (; i < L; i += 8) {
      const a = (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) ^ c;
      c = T[1792 + (a & 255)] ^ T[1536 + ((a >>> 8) & 255)] ^ T[1280 + ((a >>> 16) & 255)] ^ T[1024 + (a >>> 24)] ^ T[768 + b[i + 4]] ^ T[512 + b[i + 5]] ^ T[256 + b[i + 6]] ^ T[b[i + 7]];
    }
    for (; i < b.length; i++) c = T[(c ^ b[i]) & 255] ^ (c >>> 8);
    if (onBytes) onBytes(b.length);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}
const U32 = 0xFFFFFFFF;
function zip64Extra(vals) { const v = new DataView(new ArrayBuffer(4 + 8 * vals.length)); v.setUint16(0, 1, true); v.setUint16(2, 8 * vals.length, true); vals.forEach((x, i) => v.setBigUint64(4 + 8 * i, BigInt(x), true)); return new Uint8Array(v.buffer); }
async function zipBlob(entries, onBytes) { // entries: [{ name, blob }]
  const enc = new TextEncoder(), parts = [], central = [];
  const d = new Date(), time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  let off = 0;
  for (const e of entries) {
    const name = enc.encode(e.name), size = e.blob.size, crc = await crc32(e.blob, onBytes), big = size >= U32;
    const x = big ? zip64Extra([size, size]) : new Uint8Array(0);
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, big ? 45 : 20, true); h.setUint16(6, 0x0800, true); // UTF-8 names, stored
    h.setUint16(10, time, true); h.setUint16(12, date, true); h.setUint32(14, crc, true);
    h.setUint32(18, big ? U32 : size, true); h.setUint32(22, big ? U32 : size, true); h.setUint16(26, name.length, true); h.setUint16(28, x.length, true);
    parts.push(h.buffer, name, x, e.blob);
    central.push({ name, size, crc, off });
    off += 30 + name.length + x.length + size;
  }
  const cdStart = off;
  for (const c of central) {
    const vals = c.size >= U32 ? [c.size, c.size] : []; if (c.off >= U32) vals.push(c.off);
    const x = vals.length ? zip64Extra(vals) : new Uint8Array(0);
    const h = new DataView(new ArrayBuffer(46));
    h.setUint32(0, 0x02014b50, true); h.setUint16(4, 45, true); h.setUint16(6, vals.length ? 45 : 20, true); h.setUint16(8, 0x0800, true);
    h.setUint16(12, time, true); h.setUint16(14, date, true); h.setUint32(16, c.crc, true);
    h.setUint32(20, c.size >= U32 ? U32 : c.size, true); h.setUint32(24, c.size >= U32 ? U32 : c.size, true);
    h.setUint16(28, c.name.length, true); h.setUint16(30, x.length, true); h.setUint32(42, c.off >= U32 ? U32 : c.off, true);
    parts.push(h.buffer, c.name, x); off += 46 + c.name.length + x.length;
  }
  const cdSize = off - cdStart, n = central.length, z64 = cdStart >= U32 || n >= 0xFFFF;
  if (z64) {
    const r = new DataView(new ArrayBuffer(76));
    r.setUint32(0, 0x06064b50, true); r.setBigUint64(4, 44n, true); r.setUint16(12, 45, true); r.setUint16(14, 45, true);
    r.setBigUint64(24, BigInt(n), true); r.setBigUint64(32, BigInt(n), true); r.setBigUint64(40, BigInt(cdSize), true); r.setBigUint64(48, BigInt(cdStart), true);
    r.setUint32(56, 0x07064b50, true); r.setBigUint64(64, BigInt(off), true); r.setUint32(72, 1, true);
    parts.push(r.buffer);
  }
  const e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, z64 ? 0xFFFF : n, true); e.setUint16(10, z64 ? 0xFFFF : n, true);
  e.setUint32(12, cdSize, true); e.setUint32(16, z64 ? U32 : cdStart, true);
  parts.push(e.buffer);
  return new Blob(parts, { type: 'application/zip' });
}
async function zipEntries(blob) { // reads the central directory: Map name → { method, csize, size, off }
  const tl = Math.min(blob.size, 65557);
  const t = new DataView(await blob.slice(blob.size - tl).arrayBuffer());
  let e = -1; for (let i = tl - 22; i >= 0; i--) if (t.getUint32(i, true) === 0x06054b50) { e = i; break; }
  if (e < 0) throw new Error('not a zip file');
  let n = t.getUint16(e + 10, true), cdSize = t.getUint32(e + 12, true), cdOff = t.getUint32(e + 16, true);
  if ((n === 0xFFFF || cdSize === U32 || cdOff === U32) && e >= 20 && t.getUint32(e - 20, true) === 0x07064b50) {
    const at = Number(t.getBigUint64(e - 12, true));
    const z = new DataView(await blob.slice(at, at + 56).arrayBuffer());
    if (z.getUint32(0, true) === 0x06064b50) { n = Number(z.getBigUint64(32, true)); cdSize = Number(z.getBigUint64(40, true)); cdOff = Number(z.getBigUint64(48, true)); }
  }
  const cd = new DataView(await blob.slice(cdOff, cdOff + cdSize).arrayBuffer()), dec = new TextDecoder(), out = new Map();
  for (let k = 0, p = 0; k < n && p + 46 <= cd.byteLength && cd.getUint32(p, true) === 0x02014b50; k++) {
    let csize = cd.getUint32(p + 20, true), size = cd.getUint32(p + 24, true), off = cd.getUint32(p + 42, true);
    const nl = cd.getUint16(p + 28, true), xl = cd.getUint16(p + 30, true), cl = cd.getUint16(p + 32, true);
    for (let q = p + 46 + nl; q + 4 <= p + 46 + nl + xl; q += 4 + cd.getUint16(q + 2, true)) {
      if (cd.getUint16(q, true) !== 1) continue;
      let r = q + 4;
      if (size === U32) { size = Number(cd.getBigUint64(r, true)); r += 8; }
      if (csize === U32) { csize = Number(cd.getBigUint64(r, true)); r += 8; }
      if (off === U32) off = Number(cd.getBigUint64(r, true));
    }
    out.set(dec.decode(new Uint8Array(cd.buffer, p + 46, nl)), { method: cd.getUint16(p + 10, true), csize, size, off });
    p += 46 + nl + xl + cl;
  }
  return out;
}
async function zipEntryBlob(blob, ent, type = '') {
  const h = new DataView(await blob.slice(ent.off, ent.off + 30).arrayBuffer());
  if (h.getUint32(0, true) !== 0x04034b50) throw new Error('damaged zip entry');
  const start = ent.off + 30 + h.getUint16(26, true) + h.getUint16(28, true);
  const raw = blob.slice(start, start + ent.csize, type);
  if (ent.method === 0) return raw; // stored: a slice of the file, read only when used
  if (ent.method === 8 && window.DecompressionStream) return new Blob([await new Response(raw.stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer()], { type });
  throw new Error('unsupported zip compression');
}

/* ---------- backup ---------- */
const EXT = { epub: 'epub', pdf: 'pdf', djvu: 'djvu' };
const TYPE = { epub: 'application/epub+zip', pdf: 'application/pdf', djvu: 'image/vnd.djvu' };
async function exportBackup() {
  closeLSheets();
  const books = state.books.filter(b => b.id !== 'sample');
  if (!books.length) { toast('There are no books to back up yet.'); return; }
  toast('Packing the backup…', 120000);
  try {
    const marks = (await DB.allMarks()).filter(m => books.some(b => b.id === m.bookId));
    const meta = { app: 'reflow', format: 2, created: new Date().toISOString(), prefs, theme, ttsRate: TTS.rate, books: [], marks };
    const entries = [];
    for (const b of books) {
      const f = fmtOf(b);
      const e = { id: b.id, title: b.title, author: b.author, format: f, fileName: b.fileName, pages: b.pages, added: b.added, opened: b.opened, pos: LS.get('reflow:pos:' + b.id, null), cover: false, file: `books/${b.id}.${EXT[f]}` };
      entries.push({ name: e.file, blob: b.blob });
      if (b.cover) { entries.push({ name: `covers/${b.id}`, blob: b.cover }); e.cover = true; e.coverType = b.cover.type || 'image/jpeg'; }
      meta.books.push(e);
    }
    entries.unshift({ name: 'reflow-backup.json', blob: new Blob([JSON.stringify(meta)], { type: 'application/json' }) });
    const total = entries.reduce((n, e) => n + e.blob.size, 0); let done = 0, shown = -1;
    const blob = await zipBlob(entries, k => { done += k; const pc = Math.floor(done / Math.max(1, total) * 100); if (pc !== shown) { shown = pc; toast(`Packing the backup… ${pc}%`, 120000); } });
    const d = new Date(); const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1, 2)}-${pad(d.getDate(), 2)}`;
    $('#toast').hidden = true;
    await saveBlob(`Panna backup ${stamp}.zip`, blob, 'Save your Panna backup');
  } catch (e) { toast('The backup could not be made. ' + ((e && e.message) || '')); }
}
async function importBackup(file) {
  closeLSheets();
  let ents, readEntry;
  try {
    ents = await zipEntries(file);
    readEntry = (name, type) => { const en = ents.get(name); return en ? zipEntryBlob(file, en, type) : null; };
  } catch { toast('That file is not a Panna or Reflow backup.'); return; }
  if (!ents.has('reflow-backup.json')) { toast('That zip file is not a Panna or Reflow backup.'); return; }
  toast('Restoring…', 120000);
  try {
    const meta = JSON.parse(await (await readEntry('reflow-backup.json')).text());
    // restoring into an empty library means moving to a new phone or install: bring the reading settings along too
    if (!state.books.some(b => b.id !== 'sample')) {
      if (meta.prefs && typeof meta.prefs === 'object') { prefs = Object.assign({}, PREF_DEF, meta.prefs); LS.set('reflow:prefs', prefs); applyPrefs(); }
      if (['light', 'dark', 'system'].includes(meta.theme)) setTheme(meta.theme);
      if (meta.ttsRate) { TTS.rate = meta.ttsRate; LS.set('reflow:ttsRate', TTS.rate); }
    }
    const have = new Set(state.books.map(b => b.id));
    let nb = 0, nm = 0, skipped = 0, i = 0;
    for (const e of meta.books || []) {
      i++;
      if (have.has(e.id)) { skipped++; continue; }
      const f = e.format || 'epub';
      const blob = await readEntry(e.file || `books/${e.id}.epub`, TYPE[f]); if (!blob) continue;
      const cover = e.cover ? await readEntry(`covers/${e.id}`, e.coverType || 'image/jpeg') : null;
      const rec = { id: e.id, title: e.title || 'Untitled', author: e.author || '', format: f, fileName: e.fileName || '', pages: e.pages, added: e.added || Date.now(), opened: e.opened, blob, cover };
      toast(`Restoring… book ${i} of ${meta.books.length}`, 120000);
      await DB.add(rec); state.books.push(rec); nb++;
      if (e.pos && !LS.get('reflow:pos:' + e.id, null)) LS.set('reflow:pos:' + e.id, e.pos);
    }
    const existing = new Set((await DB.allMarks()).map(m => m.id));
    for (const m of meta.marks || []) { if (!existing.has(m.id) && state.books.some(b => b.id === m.bookId)) { await DB.putMark(m); nm++; } }
    renderShelf();
    toast(`Restored ${nb} book${nb === 1 ? '' : 's'} and ${nm} mark${nm === 1 ? '' : 's'}${skipped ? `. ${skipped} already in the library.` : '.'}`, 5000);
  } catch (e) { toast('The backup could not be read. ' + ((e && e.message) || '')); }
}
$('#backup-btn').addEventListener('click', exportBackup);
$('#restore-btn').addEventListener('click', () => $('#restore-file').click());
$('#restore-file').addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; if (f) importBackup(f); });

/* ---------- files from other apps ---------- */
async function pullIncoming() {
  const N = NATIVE(); if (!N) return;
  let res; try { res = await N.take(); } catch { return; }
  const files = (res && res.files) || [];
  if (res && res.open) { // a book tapped on the home-screen widget
    const b = state.books.find(x => x.id === res.open);
    if (b && !(state.reader && state.reader.rec.id === b.id)) openBook(b.id);
  }
  if (!files.length) { if (res && res.busy) toast('Receiving the file…', 60000); return; }
  let last = null;
  for (const f of files) {
    if (f.error) { toast(`Could not open ${f.name || 'the shared file'}. ${f.error}`, 6000); continue; }
    try {
      const r = await fetch(Cap.convertFileSrc('file://' + f.path));
      const blob = await r.blob();
      const file = new File([blob], f.name || 'shared-file', { type: f.type || blob.type || '' });
      const rec = await handleFile(file); if (rec) last = rec;
    } catch { toast(`Could not open ${f.name || 'the shared file'}.`); }
    try { await plug('Filesystem').deleteFile({ path: 'file://' + f.path }); } catch {}
  }
  if (last && files.length === 1) { if (state.reader) closeReader(); openBook(last.id); }
}
/* ---------- home-screen widget ----------
   The widget is native and can't read the library, so it is sent a summary of the books in progress (title,
   place, progress) and covers shrunk to 420 px, whenever the shelf is redrawn or the app goes to the background. */
let widgetT = 0;
const widgetSent = new Set(); // covers already sent in this session
function widgetSync(now) { if (!NATIVE()) return; clearTimeout(widgetT); widgetT = setTimeout(widgetPush, now ? 0 : 400); }
async function widgetPush() {
  const N = NATIVE(); if (!N) return;
  const list = state.books.filter(b => b.id !== 'sample' && b.opened && progressOf(b) < FINISHED).sort((a, b) => b.opened - a.opened).slice(0, 3);
  const covers = {};
  for (const b of list) if (!widgetSent.has(b.id)) { try { covers[b.id] = await widgetCover(b); } catch {} }
  const books = list.map(b => ({ id: b.id, title: b.title, author: b.author || '', pct: +progressOf(b).toFixed(4), place: placeOf(b), nudge: widgetNudge(b) }));
  try { await N.setWidget({ books, covers }); Object.keys(covers).forEach(id => widgetSent.add(id)); } catch {}
}
// a reason to open the book: how close the end of the chapter is (EPUB), or the page (PDF, DjVu)
function widgetNudge(b) {
  const p = LS.get('reflow:pos:' + b.id, null);
  if (!p) return '';
  if (p.fixed) return `Page ${fmt(p.page + 1)} of ${fmt(p.total)}`;
  if (typeof p.left !== 'number') return ''; // saved before this was recorded: the widget shows the place instead
  if (p.left > 0 && p.left <= 3) return `Chapter ends in ${p.left} min`;
  if (p.left > 0) return p.left === 1 ? '1 min left in chapter' : `${p.left} min left in chapter`;
  return p.idx + 1 < p.total ? 'Next chapter is waiting' : '';
}
async function widgetCover(b) {
  const H = 420, c = document.createElement('canvas'), x = c.getContext('2d');
  if (b.cover) {
    const bmp = await createImageBitmap(b.cover);
    c.height = H; c.width = Math.min(600, Math.round(bmp.width * H / bmp.height));
    x.fillStyle = '#FFFFFF'; x.fillRect(0, 0, c.width, H); x.drawImage(bmp, 0, 0, c.width, H); bmp.close();
  } else { // the same cloth-and-title cover the library draws for books without one
    c.width = 240; c.height = H;
    x.fillStyle = CLOTH[hash(b.title) % CLOTH.length]; x.fillRect(0, 0, 240, H);
    x.fillStyle = '#FFFFFF'; x.font = '600 25px Literata, Georgia, serif';
    const words = b.title.split(/\s+/), lines = []; let line = '';
    for (const w of words) { const t = line ? line + ' ' + w : w; if (x.measureText(t).width > 196 && line) { lines.push(line); line = w; } else line = t; }
    if (line) lines.push(line);
    lines.slice(0, 7).forEach((l, i) => x.fillText(l, 22, 64 + i * 32));
    x.globalAlpha = 0.8; x.font = '600 13px sans-serif'; x.fillText((b.author || FMT_LABEL[fmtOf(b)]).toUpperCase().slice(0, 26), 22, H - 26);
  }
  return c.toDataURL('image/jpeg', 0.85).split(',')[1];
}
$('#widget-btn').addEventListener('click', async () => {
  closeLSheets();
  let r = null; try { r = await NATIVE().pinWidget(); } catch {}
  if (!r || !r.ok) toast('Long-press an empty spot on the home screen, tap Widgets, and find Panna.', 6000);
});

/* ---------- reader: prefs ---------- */
const PREF_DEF = { fs: 19, face: 'read', lh: '1.7', paper: 'auto', measure: '38em', layout: 'pages', fxLayout: 'scroll', awake: true, vol: true, full: true, hyph: 'on', trim: true, dim: 0 };
let prefs = Object.assign({}, PREF_DEF, LS.get('reflow:prefs', {}));
if (!LS.get('reflow:v2', false)) { prefs.paper = 'auto'; LS.set('reflow:v2', true); LS.set('reflow:prefs', prefs); }
const FACE = { read: 'var(--read)', hyper: 'var(--hyper)', ui: 'var(--ui)' };
function applyPrefs() {
  const R = $('#reader');
  R.style.setProperty('--fs', prefs.fs + 'px'); R.style.setProperty('--lh', prefs.lh);
  R.style.setProperty('--face', FACE[prefs.face] || FACE.read); R.style.setProperty('--measure', prefs.measure);
  R.dataset.paper = paperNow(); R.dataset.hyph = prefs.hyph;
  R.classList.toggle('paged', !(state.reader && state.reader.fixed) && prefs.layout === 'pages');
  $('#fs-val').textContent = prefs.fs + ' px';
  $$('.pseg').forEach(g => g.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(String(prefs[g.dataset.pref]) === b.dataset.v))));
  $('#pref-trim').checked = !!prefs.trim; applyDim();
  $('#pref-awake').checked = !!prefs.awake; $('#pref-vol').checked = !!prefs.vol; $('#pref-full').checked = !!prefs.full;
  $('#vol-row').hidden = !isNative; $('#full-row').hidden = !isNative;
  if (state.reader) keepAwake(prefs.awake);
  syncVolume();
  setStatusBar();
}
/* volume keys turn pages only while reading: not during read-aloud (they should change its volume) or with a sheet open */
function syncVolume() { volumePaging(!!(state.reader && prefs.vol && !TTS.playing && !anySheetOpen())); }
function changePref(fn) {
  const R = state.reader; const f = R ? R.frac : 0;
  fn(); LS.set('reflow:prefs', prefs); applyPrefs();
  if (R) { relayout(f); }
}
$('#fs-down').addEventListener('click', () => changePref(() => prefs.fs = Math.max(13, prefs.fs - 1)));
$('#fs-up').addEventListener('click', () => changePref(() => prefs.fs = Math.min(32, prefs.fs + 1)));
$$('.pseg').forEach(g => g.addEventListener('click', e => { const b = e.target.closest('button'); if (b) changePref(() => prefs[g.dataset.pref] = b.dataset.v); }));
$('#pref-awake').addEventListener('change', e => changePref(() => prefs.awake = e.target.checked));
$('#pref-vol').addEventListener('change', e => changePref(() => prefs.vol = e.target.checked));
$('#pref-full').addEventListener('change', e => changePref(() => prefs.full = e.target.checked));

/* ---------- reader: sheets ---------- */
function closeSheets() { ['#drawer', '#prefs', '#notebox', '#fnbox', '#dictbox'].forEach(s => $(s).hidden = true); $('#scrim').hidden = true; }
function anySheetOpen() { return !$('#drawer').hidden || !$('#prefs').hidden || !$('#notebox').hidden || !$('#fnbox').hidden || !$('#dictbox').hidden; }
{ const mo = new MutationObserver(() => syncVolume()); ['#drawer', '#prefs', '#notebox', '#fnbox', '#dictbox'].forEach(s => mo.observe($(s), { attributes: true, attributeFilter: ['hidden'] })); }
$('#scrim').addEventListener('click', closeSheets);
$('#drawer-close').addEventListener('click', closeSheets);
$('#r-prefs-btn').addEventListener('click', () => { const open = $('#prefs').hidden; closeSheets(); $('#prefs').hidden = !open; });
$('#r-toc-btn').addEventListener('click', () => openDrawer('toc'));
$('#r-back').addEventListener('click', closeReader);
$('#r-bm-btn').addEventListener('click', toggleBookmark);
function openDrawer(tab) {
  closeSheets(); hideSel();
  $('#drawer').hidden = false; $('#scrim').hidden = false; showTab(tab);
}
function showTab(tab) {
  $$('.tabs button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  $('#pane-toc').hidden = tab !== 'toc'; $('#pane-search').hidden = tab !== 'search'; $('#pane-marks').hidden = tab !== 'marks';
  if (tab === 'toc') { const on = $('#toc-list .on'); if (on) on.scrollIntoView({ block: 'center' }); }
  if (tab === 'search') setTimeout(() => $('#search-q').focus(), 50);
  if (tab === 'marks') renderMarks();
}
$('.tabs').addEventListener('click', e => { const b = e.target.closest('button[data-tab]'); if (b) showTab(b.dataset.tab); });

/* ---------- reader: open / close ---------- */
async function openBook(id) {
  const b = state.books.find(x => x.id === id); if (!b) return;
  if (state.reader) closeReader();
  closeLSheets();
  b.opened = Date.now();
  if (b.id !== 'sample') DB.put(b);
  if (fmtOf(b) !== 'epub') return openFixed(b);
  $('#reader').classList.remove('fixed'); $('#scroller').hidden = false; fxBox().hidden = true; $('#layout-seg').dataset.pref = 'layout';
  let bk;
  try { bk = await parseEpub(b.blob); } catch (e) { toast(e.message || 'This book could not be opened.'); return; }
  if (!bk.spine.length) { toast('This EPUB has no readable sections.'); return; }
  const marks = await DB.marksFor(b.id);
  state.reader = { book: bk, rec: b, idx: 0, frac: 0, page: 0, pages: 1, W: 0, words: 0, assets: new Map(), texts: new Map(), path: '', marks, immersive: false, seq: 0, overall: 0, wpb: WPB, sheets: new Map() };
  state.reader.immersive = true; // open with the menu hidden: the bars float over the text, so a visible menu would cover lines
  $('#reader').classList.toggle('immersive', state.reader.immersive);
  $('#content').lang = bk.lang || 'en';
  applyPrefs(); closeSheets(); hideSel();
  if (state.reader.immersive && !LS.get('reflow:tipChrome', false)) { LS.set('reflow:tipChrome', true); toast('Tap the middle of the page for the menu.', 4000); }
  $('#reader').hidden = false; document.body.style.overflow = 'hidden';
  $('#r-t1').textContent = b.title;
  $('#search-results').replaceChildren(); $('#search-status').textContent = 'Type a word or phrase.'; $('#search-q').value = '';
  buildToc();
  const pos = LS.get('reflow:pos:' + id, null);
  await showChapter(pos ? pos.idx : 0, pos ? pos.frac : 0);
  $('#scroller').focus({ preventScroll: true });
}

function closeReader() {
  const R = state.reader; if (!R) return;
  ttsStop();
  savePos(true);
  if (R.fixed) {
    clearTimeout(fxT); R.queue = [];
    try { if (R.doc) R.doc.destroy(); } catch {}
    fxList().querySelectorAll('canvas').forEach(c => { c.width = c.height = 0; });
    fxList().replaceChildren(); fxBox().hidden = true; $('#fx-loading').hidden = true;
    $('#scroller').hidden = false; $('#reader').classList.remove('fixed'); $('#layout-seg').dataset.pref = 'layout';
  } else for (const u of R.assets.values()) URL.revokeObjectURL(u);
  state.reader = null; closeSheets(); hideSel(); document.adoptedStyleSheets = [];
  keepAwake(false); volumePaging(false);
  $('#content').replaceChildren(); $('#content').style.cssText = ''; $('#reader').hidden = true; document.body.style.overflow = '';
  setStatusBar();
  renderShelf();
}

function tocTitleFor(idx) {
  const R = state.reader; const p = R.book.spine[idx];
  const t = R.book.toc.find(x => x.path === p);
  return t ? t.title : `Section ${idx + 1}`;
}

function buildToc() {
  if (state.reader && state.reader.fixed) return fxBuildToc();
  const R = state.reader; const ol = $('#toc-list'); ol.replaceChildren();
  const entries = R.book.toc.length ? R.book.toc : R.book.spine.map((p, i) => ({ title: `Section ${i + 1}`, path: p, frag: '', depth: 0 }));
  for (const t of entries) {
    const li = document.createElement('li'); const b = document.createElement('button'); b.type = 'button'; b.className = 'toc-item';
    b.textContent = t.title || 'Untitled'; b.style.paddingLeft = (16 + (t.depth || 0) * 16) + 'px'; b.dataset.path = t.path;
    b.addEventListener('click', () => { const i = R.book.spine.indexOf(t.path); closeSheets(); if (i >= 0) showChapter(i, 0, t.frag ? { frag: t.frag } : null); });
    li.append(b); ol.append(li);
  }
}

async function assetUrl(path) {
  const R = state.reader; if (R.assets.has(path)) return R.assets.get(path);
  const f = zipFile(R.book.zip, path); if (!f) return '';
  const ext = path.split('.').pop().toLowerCase();
  const u = URL.createObjectURL(new Blob([await f.async('arraybuffer')], { type: MIME[ext] || 'application/octet-stream' }));
  R.assets.set(path, u); return u;
}

/* Book content goes into the app's own page. The Content-Security-Policy in index.html is the main guard; this
   cleanup is the second. Only elements without text are added to STRIP, so saved highlight offsets stay valid. */
const STRIP = 'script,style,link,meta,iframe,object,embed,base,form,title,frame,frameset,animate,set,animateMotion,animateTransform,discard,source,track';
const XLINK = 'http://www.w3.org/1999/xlink';
const DROP_ATTR = /^(target|srcset|sizes|ping|action|formaction|background|lowsrc|dynsrc|codebase|manifest)$/i;
const URL_ATTR = /^(href|src|poster|data|cite|longdesc|icon)$/i;
const BAD_CSS = /url\s*\((?!\s*['"]?#)|expression\s*\(|@import|binding|behavior/i; // url(#id) points inside the SVG itself
/* Book styling that is kept (from stylesheets and style attributes). Colours, typefaces, line height and absolute
   text sizes are left to the reader's own settings, so Night mode and the text size work in every book. */
const CSS_OK = new Set(['text-align', 'text-align-last', 'text-indent', 'font-style', 'font-weight', 'font-variant', 'font-variant-caps', 'text-transform',
  'text-decoration-line', 'text-decoration-style', 'vertical-align', 'white-space', 'letter-spacing', 'word-spacing', 'font-size', 'display',
  'margin-top', 'margin-bottom', 'margin-left', 'margin-right', 'padding-top', 'padding-bottom', 'padding-left', 'padding-right',
  'list-style-type', 'list-style-position', 'float', 'clear', 'break-before', 'break-after', 'break-inside', 'page-break-before', 'page-break-after',
  'page-break-inside', 'border-collapse', 'direction', 'unicode-bidi', 'hyphens']);
const DISPLAY_OK = /^(none|block|inline|inline-block|list-item|table|table-row|table-cell|table-caption|table-header-group|table-row-group|table-footer-group|table-column|table-column-group)$/;
function cssValueOk(prop, v) {
  if (!v || BAD_CSS.test(v) || /var\(|attr\(|env\(/i.test(v)) return false;
  if (prop === 'display') return DISPLAY_OK.test(v);
  if (prop === 'font-size') return /^(smaller|larger|inherit|[\d.]+(em|%|ex))$/.test(v); // relative sizes only: the reader picks the text size
  if (/^(margin|padding)/.test(prop)) return v.split(/\s+/).every(x => /^(auto|0|-?[\d.]+(em|ex|%|rem|ch))$/.test(x) || (/^-?[\d.]+(px|pt)$/.test(x) && Math.abs(parseFloat(x)) <= 40));
  return true;
}
const HTML_NS = 'http://www.w3.org/1999/xhtml';
function safeUrl(v, isLink) {
  const s = v.replace(/[\u0000- \u007F]+/g, ''); // browsers ignore these inside a URL, so "java\tscript:" still runs
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(s);
  if (!m) return true; // relative path or #fragment
  if (/^(https?|mailto)$/i.test(m[1])) return true;
  return !isLink && (/^data:image\//i.test(s) || /^blob:/i.test(s));
}
function sanitize(root) {
  root.querySelectorAll(STRIP).forEach(el => el.remove());
  for (const el of root.querySelectorAll('*')) {
    const isLink = el.localName === 'a' || el.localName === 'area';
    for (const a of [...el.attributes]) {
      const n = a.localName;
      if (/^on/i.test(n) || DROP_ATTR.test(n) || (URL_ATTR.test(n) && !safeUrl(a.value, isLink))) el.removeAttributeNode(a);
      else if (n === 'class') a.value = a.value.split(/\s+/).filter(Boolean).map(c => 'b-' + c).join(' '); // never matches the app's own classes
      else if (n === 'style') {
        const st = el.style, html = !el.namespaceURI || el.namespaceURI === HTML_NS;
        // HTML: only the allowed properties; SVG drawings keep their styling except outside references
        if (st) for (const p of [...st]) { const v = st.getPropertyValue(p); if (html ? !(CSS_OK.has(p) && cssValueOk(p, v)) : BAD_CSS.test(v)) st.removeProperty(p); }
        if (!st || !el.getAttribute('style') || BAD_CSS.test(el.getAttribute('style'))) el.removeAttribute('style');
      }
    }
  }
  return root;
}
const linkHref = a => a.getAttribute('href') || a.getAttributeNS(XLINK, 'href') || '';
function parseChapter(src) {
  let doc = new DOMParser().parseFromString(src, 'application/xhtml+xml');
  if (doc.getElementsByTagName('parsererror').length) doc = new DOMParser().parseFromString(src, 'text/html');
  const body = doc.body || doc.getElementsByTagName('body')[0] || doc.documentElement, html = doc.documentElement;
  const at = n => (body.getAttribute(n) || html.getAttribute(n) || '').trim();
  const info = {
    links: [...doc.querySelectorAll('link')].filter(l => /stylesheet/i.test(l.getAttribute('rel') || '')).map(l => l.getAttribute('href')).filter(Boolean),
    inline: [...doc.querySelectorAll('style')].map(x => x.textContent),
    dir: /^(rtl|ltr)$/i.test(at('dir')) ? at('dir').toLowerCase() : '',
    lang: [at('xml:lang'), at('lang')].find(l => /^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$/.test(l)) || '',
    cls: (body.getAttribute('class') || '').split(/\s+/).filter(c => /^[\w-]+$/.test(c)).map(c => 'b-' + c).join(' ')
  };
  return { body: sanitize(body), info };
}
const parseChapterBody = src => parseChapter(src).body;

/* The book's own CSS, reduced to CSS_OK and scoped to the chapter: html/body rules apply to the chapter wrapper, class
   names get the same b- prefix as the content. Built as a constructed stylesheet, rule by rule, so a broken rule is dropped. */
function splitSelectors(t) { const out = []; let depth = 0, cur = ''; for (const ch of t) { if (ch === '(' || ch === '[') depth++; else if (ch === ')' || ch === ']') depth--; if (ch === ',' && !depth) { out.push(cur); cur = ''; } else cur += ch; } out.push(cur); return out.map(x => x.trim()).filter(Boolean); }
function scopeSelector(sel) {
  if (/:root|::?(-webkit-|-moz-)?(scrollbar|selection)/i.test(sel)) return null;
  sel = sel.replace(/\.(-?[_a-zA-Z][\w-]*)/g, '.b-$1').replace(/^html\b\s*/i, '');
  if (/^body\b/i.test(sel)) return { sel: '#content .bk' + sel.slice(4), top: true };
  return { sel: sel ? '#content .bk ' + sel : '#content .bk', top: !sel };
}
function bookSheet(cssText) {
  const sheet = new CSSStyleSheet();
  let src; try { src = new CSSStyleSheet(); src.replaceSync(cssText.replace(/@import[^;]*;/gi, '')); } catch { return sheet; }
  const walk = rules => {
    for (const r of rules) {
      if (r.type === CSSRule.MEDIA_RULE) { if (matchMedia(r.media.mediaText || 'all').matches) walk(r.cssRules); continue; }
      if (r.type === CSSRule.SUPPORTS_RULE) { walk(r.cssRules); continue; }
      if (r.type !== CSSRule.STYLE_RULE) continue;
      for (const one of splitSelectors(r.selectorText)) {
        const sc = scopeSelector(one); if (!sc) continue;
        const decl = [];
        for (const p of r.style) {
          if (!CSS_OK.has(p) || (sc.top && /^(margin|padding|display|float)/.test(p))) continue; // body margins would add to the reader's own
          const v = r.style.getPropertyValue(p).trim();
          if (cssValueOk(p, v)) decl.push(`${p}:${v}`);
        }
        if (decl.length) try { sheet.insertRule(`${sc.sel}{${decl.join(';')}}`, sheet.cssRules.length); } catch {}
      }
    }
  };
  try { walk(src.cssRules); } catch {}
  return sheet;
}
async function chapterSheet(info, chDir) {
  const R = state.reader;
  const key = info.links.map(h => resolvePath(chDir, h)).join('|') + '\n' + info.inline.join('\n');
  if (!R.sheets.has(key)) {
    let text = '';
    for (const h of info.links) { const f = zipFile(R.book.zip, resolvePath(chDir, h)); if (f) text += await f.async('string') + '\n'; }
    R.sheets.set(key, bookSheet(text + info.inline.join('\n')));
  }
  return R.sheets.get(key);
}
async function chapterSource(idx) {
  const R = state.reader; const f = zipFile(R.book.zip, R.book.spine[idx]);
  return f ? f.async('string') : '<html xmlns="http://www.w3.org/1999/xhtml"><body><p>This section is missing from the file.</p></body></html>';
}
async function chapterText(idx) {
  const R = state.reader;
  if (!R.texts.has(idx)) R.texts.set(idx, parseChapterBody(await chapterSource(idx)).textContent);
  return R.texts.get(idx);
}

/* text-offset helpers (offsets count characters of the section's text) */
function textNodes(root) { const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); const out = []; let n; while ((n = w.nextNode())) out.push(n); return out; }
function offsetOf(root, container, offset) { const r = document.createRange(); r.setStart(root, 0); r.setEnd(container, offset); return r.toString().length; }
function wrapRange(root, start, end, make) {
  const created = []; let pos = 0;
  for (const n of textNodes(root)) {
    const len = n.data.length; const s = Math.max(start, pos), e = Math.min(end, pos + len);
    if (s < e && n.parentNode && !(n.parentNode.namespaceURI && n.parentNode.namespaceURI.includes('svg'))) {
      let node = n; const a = s - pos, b = e - pos;
      if (b < len) node.splitText(b);
      if (a > 0) node = node.splitText(a);
      const el = make(); node.parentNode.insertBefore(el, node); el.appendChild(node); created.push(el);
    }
    pos += len; if (pos >= end) break;
  }
  return created;
}
function unwrapMarks(root, sel) { root.querySelectorAll(sel).forEach(m => { const p = m.parentNode; while (m.firstChild) p.insertBefore(m.firstChild, m); p.removeChild(m); }); root.normalize(); }
const hlMark = h => () => { const m = document.createElement('mark'); m.className = `hl c-${h.color || 'yellow'}${h.note ? ' has-note' : ''}`; m.dataset.id = h.id; return m; };
function paintHighlights() {
  const R = state.reader; if (!R) return;
  if (R.fixed) { for (const i of R.rendered.keys()) paintFx(i); return; }
  const c = $('#content');
  unwrapMarks(c, 'mark.hl'); R.nodes = null;
  const hls = R.marks.filter(m => m.kind === 'hl' && m.idx === R.idx).sort((a, b) => a.start - b.start);
  for (const h of hls) wrapRange(c, h.start, h.end, hlMark(h));
}
/* PDF highlights: offsets count characters of the page's text layer, which pdf.js builds the same way every time */
function paintFx(i) {
  const R = state.reader; const pg = fxList().children[i] && fxList().children[i].firstChild;
  const tl = pg && pg.querySelector('.textLayer'); if (!tl) return;
  unwrapMarks(tl, 'mark.hl');
  for (const h of R.marks.filter(m => m.kind === 'hl' && m.page === i).sort((a, b) => a.start - b.start)) wrapRange(tl, h.start, h.end, hlMark(h));
}

async function showChapter(idx, frac = 0, target = null) {
  const R = state.reader; if (!R) return;
  idx = Math.max(0, Math.min(R.book.spine.length - 1, idx));
  const seq = ++R.seq;
  R.idx = idx; R.path = R.book.spine[idx];
  const { body, info } = parseChapter(await chapterSource(idx));
  const chDir = dirOf(R.path);
  const sheet = await chapterSheet(info, chDir);
  if (seq !== R.seq || state.reader !== R) return;
  const content = $('#content'); content.replaceChildren(); content.style.cssText = ''; R.nodes = null;
  // a wrapper keeps the chapter's direction, language and body classes; #content itself stays left-to-right so the page columns still run in order
  const wrap = document.createElement('div'); wrap.className = 'bk' + (info.cls ? ' ' + info.cls : '');
  if (info.dir || R.book.rtl) wrap.dir = info.dir || 'rtl';
  if (info.lang) wrap.lang = info.lang;
  for (const node of [...body.childNodes]) wrap.appendChild(document.importNode(node, true));
  content.appendChild(wrap);
  document.adoptedStyleSheets = [sheet];
  for (const img of content.querySelectorAll('img')) { const s = img.getAttribute('src'); if (s && !/^(data|blob):/i.test(s)) img.src = await assetUrl(resolvePath(chDir, s)); }
  for (const im of content.querySelectorAll('image')) {
    const h = im.getAttribute('href') || im.getAttributeNS('http://www.w3.org/1999/xlink', 'href');
    if (h && !/^(data|blob):/i.test(h)) { const u = await assetUrl(resolvePath(chDir, h)); im.setAttribute('href', u); im.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', u); }
  }
  if (!R.texts.has(idx)) R.texts.set(idx, content.textContent);
  paintHighlights();
  let hitEl = null;
  if (target && target.search) {
    const els = wrapRange(content, target.search.start, target.search.start + target.search.len, () => { const m = document.createElement('mark'); m.className = 'hit'; return m; }); R.nodes = null;
    hitEl = els[0] || null;
  }
  const n = R.book.spine.length;
  $('#r-t2').textContent = tocTitleFor(idx);
  $('#r-prev').hidden = idx === 0; $('#r-next').hidden = idx === n - 1;
  if (idx > 0) $('#r-prev-t').textContent = tocTitleFor(idx - 1);
  if (idx < n - 1) $('#r-next-t').textContent = tocTitleFor(idx + 1);
  $$('#toc-list .toc-item').forEach(b => b.classList.toggle('on', b.dataset.path === R.path));
  computeWords();
  const place = () => {
    layout();
    let el = hitEl;
    if (!el && target && target.hl) el = content.querySelector(`mark.hl[data-id="${CSS.escape(target.hl)}"]`);
    if (!el && target && target.frag) { try { el = content.querySelector('#' + CSS.escape(target.frag)) || content.querySelector(`[name="${CSS.escape(target.frag)}"]`); } catch {} }
    if (el) goToElement(el); else if (!(target && target.off != null && goToOffset(target.off))) setFrac(target && target.last ? 1 : frac);
  };
  place();
  await Promise.all([...content.querySelectorAll('img')].map(i => i.decode ? i.decode().catch(() => {}) : null));
  if (state.reader === R && seq === R.seq) { place(); updateStatus(); }
}

function computeWords() {
  const R = state.reader; if (!R) return; const t = $('#content').textContent.trim(); R.words = t ? t.split(/\s+/).length : 0;
  if (R.words > 300) R.wpb = R.wpb === WPB ? R.words / R.book.sizes[R.idx] : R.wpb * 0.7 + 0.3 * R.words / R.book.sizes[R.idx];
}
const WPB = 0.14; // words per byte of XHTML until a real section has been measured

/* ---------- reader: layout and position ---------- */
function layout() {
  const R = state.reader; if (!R) return;
  const sc = $('#scroller'), c = $('#content');
  const old = document.getElementById('endmark'); if (old) old.remove();
  if (prefs.layout !== 'pages') { c.style.cssText = ''; R.pages = 1; return; }
  const W = sc.clientWidth, H = sc.clientHeight;
  const measurePx = parseFloat(prefs.measure) * prefs.fs;
  const p = Math.max(18, Math.round((W - measurePx) / 2));
  c.style.width = W + 'px'; c.style.height = H + 'px';
  c.style.padding = `26px ${p}px 30px`;
  c.style.columnWidth = (W - 2 * p) + 'px'; c.style.columnGap = (2 * p) + 'px';
  c.style.setProperty('--ph', Math.max(120, H - 70) + 'px');
  const end = document.createElement('span'); end.id = 'endmark'; c.appendChild(end);
  R.W = W;
  R.pages = Math.max(1, Math.floor((end.getBoundingClientRect().left - c.getBoundingClientRect().left) / W) + 1);
}
function relayout(f) { const R = state.reader; if (!R) return; if (R.fixed) { if (R.doc) fxLayout({ page: R.fpage, frac: R.ffrac }); return; } layout(); setFrac(f == null ? R.frac : f); }
function getFrac() {
  const R = state.reader; const sc = $('#scroller');
  if (prefs.layout === 'pages') return R.pages > 1 ? R.page / (R.pages - 1) : 1;
  const max = sc.scrollHeight - sc.clientHeight; return max > 4 ? Math.min(1, Math.max(0, sc.scrollTop / max)) : 1;
}
function setFrac(f) {
  const R = state.reader; const sc = $('#scroller');
  if (prefs.layout === 'pages') { goPage(Math.round(Math.min(1, Math.max(0, f)) * (R.pages - 1))); return; }
  sc.scrollLeft = 0; sc.scrollTop = f * Math.max(0, sc.scrollHeight - sc.clientHeight); updateStatus();
}
function goPage(p) {
  const R = state.reader; const sc = $('#scroller');
  R.page = Math.max(0, Math.min(R.pages - 1, p));
  sc.scrollTop = 0; sc.scrollLeft = R.page * R.W;
  updateStatus();
}
function goToElement(el) {
  const R = state.reader; const sc = $('#scroller'), c = $('#content');
  if (prefs.layout === 'pages') { const x = el.getBoundingClientRect().left - c.getBoundingClientRect().left; goPage(Math.floor(x / R.W)); }
  else { sc.scrollTop += el.getBoundingClientRect().top - sc.getBoundingClientRect().top - 24; updateStatus(); }
}
function turn(dir) {
  const R = state.reader; if (!R) return;
  if (R.fixed) return fxTurn(dir);
  hideSel();
  const n = R.book.spine.length;
  if (prefs.layout === 'pages') {
    const p = R.page + dir;
    if (p < 0) { if (R.idx > 0) showChapter(R.idx - 1, 1, { last: true }); }
    else if (p >= R.pages) { if (R.idx < n - 1) showChapter(R.idx + 1, 0); }
    else goPage(p);
  } else {
    const sc = $('#scroller'), max = sc.scrollHeight - sc.clientHeight;
    if (dir > 0 && sc.scrollTop >= max - 2) { if (R.idx < n - 1) showChapter(R.idx + 1, 0); }
    else if (dir < 0 && sc.scrollTop <= 2) { if (R.idx > 0) showChapter(R.idx - 1, 1, { last: true }); }
    else sc.scrollBy({ top: dir * (sc.clientHeight - 48) });
  }
}
function toggleChrome() {
  const R = state.reader; if (!R) return;
  R.immersive = !R.immersive; $('#reader').classList.toggle('immersive', R.immersive);
  setStatusBar();
}

let saveT = 0;
function savePos(now) {
  const R = state.reader; if (!R) return;
  if (R.fixed && !R.doc) return;
  const write = () => LS.set('reflow:pos:' + R.rec.id, R.fixed ? { fixed: true, page: R.fpage, frac: +(R.ffrac || 0).toFixed(4), total: R.doc.n, p: +(R.overall || 0).toFixed(4) } : { idx: R.idx, frac: +R.frac.toFixed(4), total: R.book.spine.length, p: +(R.overall || 0).toFixed(4), left: R.left || 0 });
  clearTimeout(saveT); if (now) write(); else saveT = setTimeout(write, 600);
}
function updateStatus() {
  const R = state.reader; if (!R) return;
  if (R.fixed) return fxStatus();
  R.frac = getFrac();
  const n = R.book.spine.length, sz = R.book.sizes, total = sz.reduce((a, b) => a + b, 0);
  const before = sz.slice(0, R.idx).reduce((a, b) => a + b, 0);
  const overall = R.idx === n - 1 && R.frac >= 0.999 ? 1 : (before + sz[R.idx] * R.frac) / total; R.overall = overall;
  $('#r-track').style.width = (overall * 100).toFixed(2) + '%';
  const left = Math.ceil((R.words * (1 - R.frac)) / 230); R.left = Math.max(0, left);
  const mins = left <= 0 ? 'end of section' : left === 1 ? 'about 1 min left' : `about ${left} min left`;
  const where = prefs.layout === 'pages' ? `Page ${R.page + 1} of ${R.pages} · Section ${R.idx + 1} of ${n}` : `Section ${R.idx + 1} of ${n}`;
  $('#r-where').textContent = `${where} · ${mins}`;
  // the rest of the book: bytes left × words per byte (learned from sections read so far), at 230 words a minute
  const bookMin = Math.round(total * (1 - overall) * R.wpb / 230);
  $('#r-pct').textContent = Math.round(overall * 100) + '%' + (bookMin >= 2 ? ` · ${fmtDur(bookMin * 60000)} left` : '');
  $('#r-mini').textContent = (prefs.layout === 'pages' ? `${R.page + 1} / ${R.pages} · ` : '') + Math.round(overall * 100) + '%';
  $('#r-bm-btn').setAttribute('aria-pressed', String(!!currentBookmark()));
  savePos(false);
}
$('#scroller').addEventListener('scroll', () => { if (prefs.layout !== 'pages') requestAnimationFrame(updateStatus); }, { passive: true });
$('#r-prev').addEventListener('click', () => { const R = state.reader; if (R) showChapter(R.idx - 1, 0); });
$('#r-next').addEventListener('click', () => { const R = state.reader; if (R) showChapter(R.idx + 1, 0); });
let rzT = 0;
window.addEventListener('resize', () => { clearTimeout(rzT); rzT = setTimeout(() => { if (state.reader) relayout(); }, 150); });

/* gestures */
// +1 when the right side of the screen means "forward"; -1 in right-to-left books
const side = () => (state.reader && state.reader.book && state.reader.book.rtl ? -1 : 1);
const hasSelection = () => { const s = getSelection(); return !!(s && !s.isCollapsed && s.toString().trim()); };
let touch = null, swiped = false;
const sc0 = $('#scroller');
sc0.addEventListener('touchstart', e => { if (e.touches.length !== 1) { touch = null; return; } const t = e.touches[0]; touch = { x: t.clientX, y: t.clientY }; }, { passive: true });
sc0.addEventListener('touchend', e => {
  if (!touch || prefs.layout !== 'pages' || !state.reader) { touch = null; return; }
  const t = e.changedTouches[0]; const dx = t.clientX - touch.x, dy = t.clientY - touch.y; touch = null;
  if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.4 && !hasSelection()) { swiped = true; turn((dx < 0 ? 1 : -1) * side()); setTimeout(() => swiped = false, 400); }
});
sc0.addEventListener('click', e => {
  if (swiped || !state.reader || hasSelection()) return;
  const m = e.target.closest('mark.hl'); if (m) { openNote(m.dataset.id); return; }
  const lk = e.target.closest('a, area'); if (lk && linkHref(lk)) return;
  const r = sc0.getBoundingClientRect(); const fx = (e.clientX - r.left) / r.width;
  if (prefs.layout === 'pages' && fx < 0.28) turn(-side());
  else if (prefs.layout === 'pages' && fx > 0.72) turn(side());
  else if (fx >= 0.28 && fx <= 0.72) toggleChrome();
});
// one trackpad swipe sends dozens of wheel events: turn at most one page per gesture
let wheelT = 0;
const wheelTurn = (e, fn) => { if (Math.abs(e.deltaY) + Math.abs(e.deltaX) <= 20) return; const now = Date.now(), quiet = now - wheelT > 350; wheelT = now; if (quiet) fn((e.deltaY || e.deltaX) > 0 ? 1 : -1); };
sc0.addEventListener('wheel', e => { if (prefs.layout !== 'pages' || !state.reader) return; e.preventDefault(); wheelTurn(e, turn); }, { passive: false });

const OPS_NS = 'http://www.idpf.org/2007/ops';
function epubType(el) {
  if (!el || !el.getAttribute) return '';
  return `${el.getAttribute('epub:type') || (el.getAttributeNS && el.getAttributeNS(OPS_NS, 'type')) || ''} ${el.getAttribute('role') || ''} ${typeof el.className === 'string' ? el.className : ''}`;
}
function looksLikeNoteRef(a) {
  if (/noteref/i.test(epubType(a))) return true;
  const t = a.textContent.trim();
  return t.length > 0 && t.length <= 5 && (!!a.closest('sup') || /^\[?\(?\d{1,3}\)?\]?$|^[*†‡§]+$/.test(t));
}
const noteBox = el => (el.closest && el.closest('aside, li, [role~="doc-footnote"], [role~="doc-endnote"], p, div')) || el;
function isNoteTarget(el) { const c = noteBox(el); return c.localName === 'aside' || /footnote|endnote|rearnote|\bnote\b/i.test(epubType(c) + ' ' + epubType(c.parentElement)); }
async function findTarget(path, frag) {
  const R = state.reader; if (!R || !frag) return null;
  const q = root => { try { return root.querySelector('#' + CSS.escape(frag)) || root.querySelector(`[name="${CSS.escape(frag)}"]`); } catch { return null; } };
  if (path === R.path) return q($('#content'));
  const i = R.book.spine.indexOf(path);
  let src = null;
  if (i >= 0) src = await chapterSource(i);
  else { const f = zipFile(R.book.zip, path); if (f) src = await f.async('string'); }
  return src ? q(parseChapterBody(src)) : null;
}
let fnJump = null;
function showNote(target, path, frag) {
  const box = sanitize(noteBox(target).cloneNode(true));
  box.querySelectorAll('[role~="doc-backlink"]').forEach(x => x.remove());
  box.querySelectorAll('[id]').forEach(x => x.removeAttribute('id'));
  box.querySelectorAll('a, area').forEach(x => { x.removeAttribute('href'); x.removeAttributeNS(XLINK, 'href'); });
  const body = $('#fn-body'); body.replaceChildren(document.importNode(box, true));
  closeSheets(); hideSel();
  fnJump = { path, frag };
  $('#fnbox').hidden = false; $('#scrim').hidden = false;
}
$('#fn-close').addEventListener('click', closeSheets);
$('#fn-go').addEventListener('click', () => {
  const R = state.reader; const j = fnJump; closeSheets(); if (!R || !j) return;
  if (j.path === R.path) { const el = $('#content').querySelector('#' + CSS.escape(j.frag)); if (el) goToElement(el); }
  else { const i = R.book.spine.indexOf(j.path); if (i >= 0) showChapter(i, 0, { frag: j.frag }); }
});

$('#content').addEventListener('click', async e => {
  // SVG links use xlink:href and image maps use <area>: without handling them here, a tap would navigate the app away
  const a = e.target.closest('a, area'); const R = state.reader; if (!a || !R) return;
  const h = linkHref(a); if (!h) return;
  if (/^https?:/i.test(h)) { a.setAttribute('target', '_blank'); a.setAttribute('rel', 'noopener'); return; }
  e.preventDefault();
  const [p0, frag = ''] = h.split('#');
  const path = p0 ? resolvePath(dirOf(R.path), p0) : R.path;
  if (frag) {
    const t = await findTarget(path, frag);
    if (t && (looksLikeNoteRef(a) || /noteref/i.test(epubType(a))) && isNoteTarget(t)) { showNote(t, path, decode(frag)); return; }
    if (path === R.path) { if (t) goToElement(t); return; }
  }
  const i = R.book.spine.indexOf(path);
  if (i >= 0) showChapter(i, 0, { frag: decode(frag) });
});

document.addEventListener('keydown', e => {
  const R = state.reader; if (!R) return;
  if (e.key === 'Escape') { if (anySheetOpen()) closeSheets(); else closeReader(); return; }
  if (e.target.closest && e.target.closest('input,select,textarea')) return;
  if (anySheetOpen()) return;
  if (e.key === 'ArrowRight') { e.preventDefault(); turn(side()); }
  if (e.key === 'ArrowLeft') { e.preventDefault(); turn(-side()); }
  if (e.key === 'PageDown' || (e.key === ' ' && !e.shiftKey)) { e.preventDefault(); turn(1); }
  if (e.key === 'PageUp' || (e.key === ' ' && e.shiftKey)) { e.preventDefault(); turn(-1); }
});
window.addEventListener('pagehide', () => savePos(true));

/* ---------- highlights and notes ---------- */
let selT = 0;
document.addEventListener('selectionchange', () => { clearTimeout(selT); selT = setTimeout(checkSel, 180); });
function checkSel() {
  const R = state.reader; if (!R || anySheetOpen()) { hideSel(); return; }
  const s = getSelection();
  if (s && s.rangeCount && !s.isCollapsed && s.toString().trim() && (R.fixed ? fxBox() : $('#content')).contains(s.getRangeAt(0).commonAncestorContainer)) { $('#selbar').hidden = false; $('#sel-define').hidden = s.toString().trim().split(/\s+/).length > 3; }
  else hideSel();
}
function hideSel() { $('#selbar').hidden = true; }
async function addHighlight(color) {
  const R = state.reader; const s = getSelection(); if (!R || !s || !s.rangeCount) return null;
  const r = s.getRangeAt(0);
  let c, where, end;
  if (R.fixed) {
    // a selection across two pages is kept to the page where it starts
    const n0 = r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentElement;
    c = n0 && n0.closest('.textLayer'); if (!c || !fxBox().contains(c)) return null;
    where = { page: +c.parentElement.dataset.i };
    end = c.contains(r.endContainer) ? offsetOf(c, r.endContainer, r.endOffset) : c.textContent.length;
  } else {
    c = $('#content'); if (!c.contains(r.commonAncestorContainer)) return null;
    where = { idx: R.idx };
    end = offsetOf(c, r.endContainer, r.endOffset);
  }
  const start = offsetOf(c, r.startContainer, r.startOffset);
  const text = (c.contains(r.endContainer) ? r.toString() : c.textContent.slice(start, end)).replace(/\s+/g, ' ').trim();
  if (end - start < 1 || !text) return null;
  const m = { id: uuid(), bookId: R.rec.id, kind: 'hl', ...where, start, end, text, note: '', color, created: Date.now() };
  await DB.putMark(m); R.marks.push(m);
  s.removeAllRanges(); hideSel(); paintHighlights();
  return m;
}
$('#selbar').addEventListener('mousedown', e => e.preventDefault());
$('#selbar').addEventListener('click', async e => {
  const d = e.target.closest('.dot'); if (d) { const m = await addHighlight(d.dataset.c); if (m) toast('Highlighted.'); return; }
  if (e.target.closest('#sel-note')) { const m = await addHighlight('yellow'); if (m) openNote(m.id); }
});
let noteId = null, noteColor = 'yellow';
function openNote(id) {
  const R = state.reader; const m = R && R.marks.find(x => x.id === id); if (!m) return;
  closeSheets(); hideSel();
  noteId = id; noteColor = m.color || 'yellow';
  $('#nb-quote').textContent = m.text; $('#nb-text').value = m.note || '';
  $$('#nb-colors .dot').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.c === noteColor)));
  $('#notebox').hidden = false; $('#scrim').hidden = false;
}
$('#nb-colors').addEventListener('click', e => { const d = e.target.closest('.dot'); if (!d) return; noteColor = d.dataset.c; $$('#nb-colors .dot').forEach(b => b.setAttribute('aria-pressed', String(b === d))); });
$('#nb-cancel').addEventListener('click', closeSheets);
$('#nb-save').addEventListener('click', async () => {
  const R = state.reader; const m = R && R.marks.find(x => x.id === noteId); if (!m) { closeSheets(); return; }
  m.note = $('#nb-text').value.trim(); m.color = noteColor; await DB.putMark(m);
  closeSheets(); paintHighlights(); toast(m.note ? 'Note saved.' : 'Highlight saved.');
});
$('#nb-del').addEventListener('click', async () => {
  const R = state.reader; if (!R) return;
  await DB.delMark(noteId); R.marks = R.marks.filter(x => x.id !== noteId);
  closeSheets(); paintHighlights(); updateStatus(); toast('Highlight deleted.');
});

/* ---------- dictionary (WordNet 3.1, offline) ---------- */
const Dict = {
  shards: new Map(), exc: null,
  key(w) { const a = /[a-z]/.test(w[0]) ? w[0] : '_'; const b = w.length > 1 && /[a-z]/.test(w[1]) ? w[1] : '_'; return a + b; },
  shard(k) { if (!this.shards.has(k)) this.shards.set(k, fetch(`vendor/dict/${k}.json`).then(r => (r.ok ? r.json() : {})).catch(() => ({}))); return this.shards.get(k); },
  async get(w) { const sh = await this.shard(this.key(w)); return Object.prototype.hasOwnProperty.call(sh, w) ? sh[w] : null; },
  excs() { if (!this.exc) this.exc = fetch('vendor/dict/exc.json').then(r => r.json()).catch(() => ({})); return this.exc; },
  async lookup(raw) {
    const w = raw.normalize('NFKC').toLowerCase().replace(/[’‘`]/g, "'").replace(/'s$/, '').replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '').replace(/\s+/g, ' ');
    if (!w) return { query: raw, results: [] };
    const cands = [w];
    const ex = (await this.excs())[w]; if (ex) cands.push(...ex);
    const rules = [['ies', 'y'], ['ches', 'ch'], ['shes', 'sh'], ['ses', 's'], ['xes', 'x'], ['zes', 'z'], ['men', 'man'], ['es', 'e'], ['es', ''], ['s', ''],
      ['ied', 'y'], ['ed', 'e'], ['ed', ''], ['ing', 'e'], ['ing', ''], ['ier', 'y'], ['iest', 'y'], ['er', 'e'], ['er', ''], ['est', 'e'], ['est', ''], ['ily', 'y'], ['ly', '']];
    for (const [suf, rp] of rules) {
      if (!w.endsWith(suf) || w.length <= suf.length + 1) continue;
      const b = w.slice(0, -suf.length) + rp; cands.push(b);
      if (!rp && /(ed|ing|er|est)$/.test(suf) && /([bdfgklmnprtvz])\1$/.test(b)) cands.push(b.slice(0, -1)); // running → run
    }
    if (w.includes('-')) cands.push(w.replace(/-/g, ' '), w.replace(/-/g, ''));
    const seen = new Set(), results = [];
    for (const c of cands) {
      if (!c || seen.has(c)) continue; seen.add(c);
      const e = await this.get(c);
      if (e) results.push({ lemma: c, e });
      if (results.length >= 2) break;
    }
    const size = e => Object.values(e).reduce((n, x) => n + x.length, 0);
    results.sort((x, y) => size(y.e) - size(x.e));
    return { query: w, results };
  }
};
const POS_NAME = { n: 'noun', v: 'verb', a: 'adjective', r: 'adverb' };
function selectedWord() {
  const s = getSelection(); if (!s || s.isCollapsed) return '';
  return s.toString().replace(/\s+/g, ' ').trim();
}
async function define(word) {
  closeSheets(); hideSel();
  const body = $('#dict-body'); body.replaceChildren();
  const h = document.createElement('h3'); h.textContent = word; body.append(h);
  $('#dictbox').hidden = false; $('#scrim').hidden = false;
  if (word.split(' ').length > 3) { const p = document.createElement('p'); p.className = 'from'; p.textContent = 'Select a single word or a short phrase to look it up.'; body.append(p); return; }
  const note = document.createElement('p'); note.className = 'from'; note.textContent = 'Looking up…'; body.append(note);
  const { query, results } = await Dict.lookup(word);
  note.remove();
  if (!results.length) { const p = document.createElement('p'); p.className = 'from'; p.textContent = `No entry for “${query}” in the offline dictionary. Names, rare words and very new words are often missing.`; body.append(p); return; }
  results.forEach((r, ri) => {
    if (ri === 0) { h.textContent = r.lemma; if (r.lemma !== query) { const f = document.createElement('p'); f.className = 'from'; f.textContent = `from “${query}”`; body.append(f); } }
    else { const h2 = document.createElement('h3'); h2.textContent = r.lemma; h2.style.marginTop = '18px'; h2.style.fontSize = '1.2rem'; body.append(h2); }
    for (const pos of ['n', 'v', 'a', 'r']) {
      const senses = r.e[pos]; if (!senses) continue;
      const lab = document.createElement('p'); lab.className = 'pos'; lab.textContent = POS_NAME[pos]; body.append(lab);
      const ol = document.createElement('ol'); body.append(ol);
      const addSense = sn => {
        const li = document.createElement('li'); li.append(document.createTextNode(sn[0]));
        for (const ex of sn[1] || []) { const x = document.createElement('span'); x.className = 'ex'; x.textContent = `“${ex}”`; li.append(x); }
        if (sn[2] && sn[2].length) { const y = document.createElement('span'); y.className = 'syn'; y.textContent = 'Also: ' + sn[2].join(', '); li.append(y); }
        ol.append(li);
      };
      senses.slice(0, 4).forEach(addSense);
      if (senses.length > 4) {
        const more = document.createElement('button'); more.type = 'button'; more.className = 'more'; more.textContent = `Show ${senses.length - 4} more`;
        more.addEventListener('click', () => { senses.slice(4).forEach(addSense); more.remove(); });
        body.append(more);
      }
    }
  });
}
$('#dict-close').addEventListener('click', closeSheets);
$('#sel-define').addEventListener('click', () => { const w = selectedWord(); getSelection().removeAllRanges(); if (w) define(w); });
$('#sel-copy').addEventListener('click', async () => {
  const w = selectedWord(); if (!w) return;
  let ok = false; try { await navigator.clipboard.writeText(w); ok = true; } catch { try { ok = document.execCommand('copy'); } catch {} }
  getSelection().removeAllRanges(); hideSel(); toast(ok ? 'Copied.' : 'Could not copy.');
});

/* ---------- bookmarks ---------- */
/* EPUB bookmarks remember the first character on screen (a text offset, like highlights), so they still point at
   the same words after the text size or line width changes. Bookmarks from older versions only have frac. */
function textIndex() { // text nodes of the chapter with their start offsets; rebuilt after highlights split nodes
  const R = state.reader;
  if (!R.nodes) { let pos = 0; R.nodes = textNodes($('#content')).map(n => { const e = { n, at: pos }; pos += n.data.length; return e; }); }
  return R.nodes;
}
function rectAt(off) {
  const idx = textIndex(); let lo = 0, hi = idx.length - 1;
  if (hi < 0) return null;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (idx[m].at <= off) lo = m; else hi = m - 1; }
  const { n, at } = idx[lo]; const k = Math.max(0, Math.min(n.data.length - 1, off - at));
  const r = document.createRange(); r.setStart(n, k); r.setEnd(n, Math.min(n.data.length, k + 1));
  const rc = r.getClientRects()[0] || r.getBoundingClientRect(); return rc && (rc.width || rc.height) ? rc : null;
}
function pageOfRect(rc) { const R = state.reader; return Math.floor((rc.left + 1 - $('#content').getBoundingClientRect().left) / R.W); }
function firstVisibleOffset() {
  const R = state.reader, sc = $('#scroller').getBoundingClientRect();
  const after = rc => prefs.layout === 'pages' ? pageOfRect(rc) >= R.page : rc.bottom > sc.top + 2; // true from the first visible character on
  const idx = textIndex().filter(e => /\S/.test(e.n.data));
  const first = e => { const r = document.createRange(); r.selectNodeContents(e.n); const rs = [...r.getClientRects()]; return rs.length ? rs[rs.length - 1] : null; };
  let lo = 0, hi = idx.length - 1, hit = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; const rc = first(idx[m]); if (rc && after(rc)) { hit = m; hi = m - 1; } else lo = m + 1; } // first node that reaches the screen
  if (hit < 0) return null;
  const { n, at } = idx[hit]; let a = 0, b = n.data.length - 1;
  while (a < b) { const m = (a + b) >> 1; const r = document.createRange(); r.setStart(n, m); r.setEnd(n, m + 1); const rc = r.getClientRects()[0]; if (rc && after(rc)) b = m; else a = m + 1; }
  return at + a;
}
function bmOnScreen(m) {
  const R = state.reader;
  if (m.off == null) return prefs.layout === 'pages' ? Math.round(m.frac * (R.pages - 1)) === R.page : Math.abs(m.frac - R.frac) < 0.02;
  const rc = rectAt(m.off); if (!rc) return false;
  if (prefs.layout === 'pages') return pageOfRect(rc) === R.page;
  const sc = $('#scroller').getBoundingClientRect(); return rc.top >= sc.top - 2 && rc.top < sc.bottom - 2;
}
function goToOffset(off) {
  const R = state.reader, sc = $('#scroller'); const rc = rectAt(off); if (!rc) return false;
  if (prefs.layout === 'pages') goPage(pageOfRect(rc)); else { sc.scrollTop += rc.top - sc.getBoundingClientRect().top - 24; updateStatus(); }
  return true;
}
function currentBookmark() {
  const R = state.reader; if (!R) return null;
  if (R.fixed) return R.marks.find(m => m.kind === 'bm' && m.page === R.fpage) || null;
  return R.marks.find(m => m.kind === 'bm' && m.idx === R.idx && bmOnScreen(m)) || null;
}
function visibleSnippet() {
  const sc = $('#scroller').getBoundingClientRect();
  for (const el of $('#content').querySelectorAll('p,h1,h2,h3,h4,li,blockquote,td')) {
    for (const r of el.getClientRects()) {
      if (r.bottom > sc.top + 8 && r.top < sc.bottom - 8 && r.right > sc.left + 4 && r.left < sc.right - 4) return el.textContent.replace(/\s+/g, ' ').trim().slice(0, 140);
    }
  }
  return '';
}
async function toggleBookmark() {
  const R = state.reader; if (!R) return;
  const ex = currentBookmark();
  if (ex) { await DB.delMark(ex.id); R.marks = R.marks.filter(m => m !== ex); toast('Bookmark removed.'); }
  else {
    const m = R.fixed
      ? { id: uuid(), bookId: R.rec.id, kind: 'bm', page: R.fpage, frac: R.ffrac, text: fxOutlineAt(R.fpage), created: Date.now() }
      : { id: uuid(), bookId: R.rec.id, kind: 'bm', idx: R.idx, frac: R.frac, off: firstVisibleOffset(), text: visibleSnippet(), created: Date.now() };
    await DB.putMark(m); R.marks.push(m); toast('Bookmarked.');
  }
  updateStatus();
}

/* ---------- marks list and export ---------- */
function sortedMarks() {
  const R = state.reader;
  if (R.fixed) return [...R.marks].filter(m => m.page != null).sort((a, b) => (a.page - b.page) || ((a.kind === 'hl' ? a.start / 1e7 : a.frac || 0) - (b.kind === 'hl' ? b.start / 1e7 : b.frac || 0)));
  return [...R.marks].sort((a, b) => (a.idx - b.idx) || ((a.kind === 'hl' ? a.start / 1e7 : a.frac) - (b.kind === 'hl' ? b.start / 1e7 : b.frac)));
}
function renderMarks() {
  const R = state.reader; if (!R) return;
  const list = $('#marks-list'); list.replaceChildren();
  const ms = sortedMarks();
  const nh = ms.filter(m => m.kind === 'hl').length, nb = ms.length - nh;
  $('#marks-count').textContent = `${nh} highlight${nh === 1 ? '' : 's'} · ${nb} bookmark${nb === 1 ? '' : 's'}`;
  $('#marks-share').hidden = !ms.length;
  if (!ms.length) { const p = document.createElement('p'); p.className = 'pane-note'; p.textContent = R.fixed ? (R.kind === 'pdf' ? 'Select text to highlight it, or tap the bookmark button at the top to mark a page.' : 'Tap the bookmark button at the top to mark a page.') : 'Select text to highlight it, or tap the bookmark button at the top to mark a page.'; list.append(p); return; }
  for (const m of ms) {
    const b = document.createElement('button'); b.type = 'button';
    b.className = 'mark-item ' + (m.kind === 'hl' ? 'c-' + (m.color || 'yellow') : 'bm');
    const s = document.createElement('small'); s.textContent = `${m.kind === 'hl' ? 'Highlight' : 'Bookmark'} · ${R.fixed ? 'Page ' + (m.page + 1) : tocTitleFor(m.idx)}`;
    const q = document.createElement('span'); q.className = 'q'; q.textContent = m.text || (R.fixed ? `Page ${m.page + 1}` : '(page)');
    b.append(s, q);
    if (m.note) { const nt = document.createElement('span'); nt.className = 'n'; nt.textContent = m.note; b.append(nt); }
    b.addEventListener('click', () => {
      closeSheets();
      if (R.fixed) {
        if (m.kind === 'hl') { R.hlGo = m.id; fxGo(m.page, 0); const mk = fxList().querySelector(`mark.hl[data-id="${CSS.escape(m.id)}"]`); if (mk) { R.hlGo = null; fxReveal(mk); } }
        else fxGo(m.page, fxPaged() ? 0 : m.frac);
      } else if (m.kind === 'hl') showChapter(m.idx, 0, { hl: m.id }); else showChapter(m.idx, m.frac, m.off != null ? { off: m.off } : null);
    });
    list.append(b);
  }
}
$('#marks-share').addEventListener('click', () => {
  const R = state.reader; if (!R) return;
  let md = `# ${R.rec.title}\n\n`; let last = -1;
  for (const m of sortedMarks()) {
    if (R.fixed) {
      if (m.kind === 'hl') { md += `> ${m.text}\n\n— page ${m.page + 1}\n\n`; if (m.note) md += `Note: ${m.note}\n\n`; }
      else md += `Bookmark: page ${m.page + 1}${m.text ? ' · ' + m.text : ''}\n\n`;
      continue;
    }
    if (m.idx !== last) { md += `## ${tocTitleFor(m.idx)}\n\n`; last = m.idx; }
    if (m.kind === 'hl') { md += `> ${m.text}\n\n`; if (m.note) md += `Note: ${m.note}\n\n`; }
    else md += `Bookmark: ${m.text || 'page'}\n\n`;
  }
  saveBlob(safeName(R.rec.title) + ' notes.md', new Blob([md], { type: 'text/markdown' }), 'Share your notes');
});

/* ---------- search ---------- */
let searchSeq = 0;
$('#search-form').addEventListener('submit', async e => {
  e.preventDefault();
  const R = state.reader; if (!R) return;
  const q = $('#search-q').value.replace(/\s+/g, ' ').trim();
  const list = $('#search-results'); list.replaceChildren();
  if (q.length < 2) { $('#search-status').textContent = 'Type at least two letters.'; return; }
  const seq = ++searchSeq;
  $('#search-status').textContent = 'Searching…';
  if (R.fixed) {
    if (!R.doc) return;
    const res = await fxSearch(q, list, seq); if (!res) return;
    $('#search-status').textContent = res.noText ? 'This file has no searchable text. It is probably a scan: pictures of pages without a text layer.'
      : res.count ? `${res.count}${res.count >= res.LIMIT ? '+' : ''} result${res.count === 1 ? '' : 's'} for “${q}”` : `No results for “${q}”.`;
    return;
  }
  const ql = q.toLowerCase(); let count = 0; const LIMIT = 300;
  for (let i = 0; i < R.book.spine.length && count < LIMIT; i++) {
    const t = await chapterText(i); if (seq !== searchSeq || state.reader !== R) return;
    const tl = t.toLowerCase(); let from = 0;
    while (count < LIMIT) {
      const k = tl.indexOf(ql, from); if (k < 0) break;
      count++; from = k + ql.length;
      const b = document.createElement('button'); b.type = 'button'; b.className = 'res';
      const s = document.createElement('small'); s.textContent = tocTitleFor(i);
      const before = t.slice(Math.max(0, k - 50), k).replace(/\s+/g, ' '), hit = t.slice(k, k + q.length), after = t.slice(k + q.length, k + q.length + 80).replace(/\s+/g, ' ');
      const mk = document.createElement('mark'); mk.textContent = hit;
      b.append(s, document.createTextNode((k > 50 ? '…' : '') + before), mk, document.createTextNode(after + '…'));
      b.addEventListener('click', () => { closeSheets(); showChapter(i, 0, { search: { start: k, len: q.length } }); });
      list.append(b);
    }
  }
  $('#search-status').textContent = count ? `${count}${count >= LIMIT ? '+' : ''} result${count === 1 ? '' : 's'} for “${q}”` : `No results for “${q}”.`;
});

/* ---------- PDF / DjVu viewer ---------- */
const FX_GAP = 10;
const fxBox = () => $('#fx');
const fxList = () => $('#fx-pages');
const fxPaged = () => prefs.fxLayout === 'pages';

class BlobRange {
  // Lets pdf.js read a big PDF straight from storage in pieces instead of loading it all into memory.
  static async open(blob) {
    const opts = { isEvalSupported: false, cMapUrl: 'vendor/cmaps/', cMapPacked: true, standardFontDataUrl: 'vendor/standard_fonts/' };
    if (blob.size < 6 * 1024 * 1024) return pdfjsLib.getDocument({ data: new Uint8Array(await blob.arrayBuffer()), ...opts }).promise;
    const init = new Uint8Array(await blob.slice(0, 1 << 16).arrayBuffer());
    const tr = new pdfjsLib.PDFDataRangeTransport(blob.size, init);
    tr.requestDataRange = (begin, end) => { blob.slice(begin, end).arrayBuffer().then(b => tr.onDataRange(begin, new Uint8Array(b))).catch(() => {}); };
    return pdfjsLib.getDocument({ range: tr, length: blob.size, rangeChunkSize: 1 << 18, disableAutoFetch: true, disableStream: true, ...opts }).promise;
  }
}

async function pdfAdapter(blob) {
  let pdf;
  try { pdf = await BlobRange.open(blob); }
  catch (e) {
    if (e && e.name === 'PasswordException') throw new Error('This PDF is password-protected. Remove the password in another app, then add it again.');
    throw new Error('This PDF could not be opened. The file may be damaged.');
  }
  const n = pdf.numPages;
  const p1 = await pdf.getPage(1); const v1 = p1.getViewport({ scale: 1 });
  const sizes = Array.from({ length: n }, () => ({ w: v1.width, h: v1.height }));
  const tasks = new Map();
  const A = {
    kind: 'pdf', n, sizes, text: true,
    async realSizes(onChange) { // pages can differ in size; fix them up quietly in the background
      let changed = false;
      for (let i = 1; i < n; i++) {
        if (!state.reader || state.reader.doc !== A) return false;
        try { const p = await pdf.getPage(i + 1); const v = p.getViewport({ scale: 1 }); if (Math.abs(v.width - sizes[i].w) > 1 || Math.abs(v.height - sizes[i].h) > 1) { sizes[i] = { w: v.width, h: v.height }; changed = true; } } catch {}
        if (changed && (i % 25 === 0 || i === n - 1)) { onChange(); changed = false; }
        if (i % 10 === 0) await tick();
      }
      return true;
    },
    async render(i, el, cssW, cssH) {
      const page = await pdf.getPage(i + 1);
      const v = page.getViewport({ scale: 1 });
      const scale = cssW / v.width;
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      let rs = scale * dpr; const maxPx = 14e6;
      if (v.width * rs * v.height * rs > maxPx) rs = Math.sqrt(maxPx / (v.width * v.height));
      const vp = page.getViewport({ scale: rs });
      const c = document.createElement('canvas'); c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
      const ctx = c.getContext('2d', { alpha: false }); ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, c.width, c.height);
      const old = tasks.get(i); if (old) try { old.cancel(); } catch {}
      const t = page.render({ canvasContext: ctx, viewport: vp }); tasks.set(i, t);
      try { await t.promise; } finally { if (tasks.get(i) === t) tasks.delete(i); }
      const tl = document.createElement('div'); tl.className = 'textLayer'; tl.style.setProperty('--scale-factor', scale);
      el.querySelectorAll('canvas,.textLayer,img.pg').forEach(x => { if (x.localName === 'canvas') { x.width = x.height = 0; } x.remove(); });
      el.append(c, tl);
      try { await pdfjsLib.renderTextLayer({ textContentSource: page.streamTextContent(), container: tl, viewport: page.getViewport({ scale }), textDivs: [] }).promise; } catch {}
      page.cleanup();
    },
    async sample(i, W) {
      const page = await pdf.getPage(i + 1); const v = page.getViewport({ scale: 1 }); const vp = page.getViewport({ scale: W / v.width });
      const c = document.createElement('canvas'); c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
      const ctx = c.getContext('2d', { willReadFrequently: true }); ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise; return c;
    },
    release(i, el) { const t = tasks.get(i); if (t) try { t.cancel(); } catch {} el.querySelectorAll('canvas').forEach(c => { c.width = c.height = 0; }); el.querySelectorAll('canvas,.textLayer').forEach(x => x.remove()); },
    async pageText(i) {
      const page = await pdf.getPage(i + 1); const tc = await page.getTextContent();
      return tc.items.map(it => (it.str || '') + (it.hasEOL ? '\n' : '')).join('');
    },
    async toc() {
      let ol; try { ol = await pdf.getOutline(); } catch { return []; }
      const out = []; let count = 0;
      const walk = async (items, depth) => {
        for (const it of items || []) {
          if (++count > 3000) return;
          let page = null;
          try { let d = it.dest; if (typeof d === 'string') d = await pdf.getDestination(d); if (Array.isArray(d)) page = typeof d[0] === 'number' ? d[0] : await pdf.getPageIndex(d[0]); } catch {}
          out.push({ title: clean(it.title || '').replace(/\s+/g, ' ').trim() || 'Untitled', page, depth });
          if (it.items && it.items.length) await walk(it.items, depth + 1);
        }
      };
      await walk(ol, 0);
      return out;
    },
    destroy() { for (const t of tasks.values()) try { t.cancel(); } catch {} try { pdf.destroy(); } catch {} }
  };
  return A;
}

async function djvuAdapter(blob) {
  if (!window.DjVu) throw new Error('The DjVu engine did not load. Reinstall the app.');
  const w = new DjVu.Worker();
  try { await w.createDocument(await blob.arrayBuffer()); }
  catch { w.terminate(); throw new Error('This DjVu file could not be opened. It may be damaged, or be one page of a multi-file book.'); }
  const raw = await w.doc.getPagesSizes().run();
  const sizes = raw.map(s => ({ w: s.width || 1, h: s.height || 1 }));
  const urls = new Map();
  const A = {
    kind: 'djvu', n: sizes.length, sizes, text: false,
    // The worker hands over the decoded page as raw pixels (transferred, not copied); it is scaled once to the size on
    // screen. Encoding a scan of several megapixels as PNG and decoding it again took most of the time before.
    async draw(i, W, opts) {
      const id = await w.doc.getPage(i + 1).getImageData().run();
      const tw = Math.max(1, Math.min(id.width, Math.round(W))), th = Math.max(1, Math.round(id.height * tw / id.width));
      const c = document.createElement('canvas'); c.width = tw; c.height = th;
      const ctx = c.getContext('2d', opts); ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, tw, th);
      const bmp = await createImageBitmap(id, { resizeWidth: tw, resizeHeight: th, resizeQuality: 'high' });
      ctx.drawImage(bmp, 0, 0); bmp.close();
      return c;
    },
    async render(i, el, cssW) {
      const c = await A.draw(i, cssW * Math.min(window.devicePixelRatio || 1, 3), { alpha: false });
      el.querySelectorAll('canvas,img.pg').forEach(x => { if (x.localName === 'canvas') x.width = x.height = 0; x.remove(); });
      el.append(c);
    },
    sample(i, W) { return A.draw(i, W, { willReadFrequently: true }); },
    release(i, el) { el.querySelectorAll('canvas').forEach(c => { c.width = c.height = 0; }); el.querySelectorAll('canvas,img.pg').forEach(x => x.remove()); },
    async pageText(i) { try { return (await w.doc.getPage(i + 1).getText().run()) || ''; } catch { return ''; } },
    async toc() {
      let c; try { c = await w.doc.getContents().run(); } catch { return []; }
      const out = [];
      const walk = async (items, depth) => {
        for (const it of items || []) {
          let page = null; try { const k = await w.doc.getPageNumberByUrl(it.url).run(); if (k) page = k - 1; } catch {}
          out.push({ title: clean(it.description || '').trim() || 'Untitled', page, depth });
          if (it.children && it.children.length) await walk(it.children, depth + 1);
        }
      };
      await walk(c, 0);
      return out;
    },
    destroy() { for (const u of urls.values()) try { w.revokeObjectURL(u); } catch {} urls.clear(); try { w.cancelAllTasks(); } catch {} setTimeout(() => { try { w.terminate(); } catch {} }, 300); }
  };
  return A;
}

async function openFixed(b) {
  const marks = await DB.marksFor(b.id);
  const R = { rec: b, fixed: true, kind: b.format, doc: null, marks, z: 1, zPage: -1, fpage: 0, ffrac: 0, frac: 0, immersive: true, seq: 0, texts: new Map(), toc: [], rendered: new Map(), queue: [], busy: false, hit: null, tops: [], ph: [], pw: [], fw: [], fh: [], crop: null, words: 0 };
  state.reader = R;
  const rd = $('#reader');
  rd.classList.add('fixed'); rd.classList.toggle('immersive', R.immersive);
  $('#scroller').hidden = true; fxBox().hidden = false; fxList().replaceChildren();
  $('#layout-seg').dataset.pref = 'fxLayout';
  applyPrefs(); closeSheets(); hideSel();
  rd.hidden = false; document.body.style.overflow = 'hidden';
  $('#r-t1').textContent = b.title; $('#r-t2').textContent = '';
  $('#search-results').replaceChildren(); $('#search-status').textContent = 'Type a word or phrase.'; $('#search-q').value = '';
  $('#toc-list').replaceChildren();
  $('#fx-loading').hidden = false;
  try { R.doc = b.format === 'pdf' ? await pdfAdapter(b.blob) : await djvuAdapter(b.blob); }
  catch (e) { $('#fx-loading').hidden = true; if (state.reader === R) closeReader(); toast(e.message || 'This file could not be opened.', 5000); return; }
  if (state.reader !== R) { R.doc.destroy(); return; }
  $('#fx-loading').hidden = true;
  if (b.pages !== R.doc.n) { b.pages = R.doc.n; if (b.id !== 'sample') DB.put(b); }
  const list = fxList();
  for (let i = 0; i < R.doc.n; i++) {
    const slot = document.createElement('div'); slot.className = 'fx-slot';
    const pg = document.createElement('div'); pg.className = 'fx-page'; pg.dataset.i = i;
    const num = document.createElement('span'); num.className = 'pnum'; num.textContent = i + 1;
    pg.append(num); slot.append(pg); list.append(slot);
  }
  const pos = LS.get('reflow:pos:' + b.id, null);
  const start = pos && pos.fixed ? { page: Math.min(pos.page, R.doc.n - 1), frac: pos.frac || 0 } : { page: 0, frac: 0 };
  // page sizes and trim margins found on an earlier open: applied before the first layout, so the page doesn't jump
  const fc = b.fx && b.fx.n === R.doc.n ? b.fx : null;
  if (fc) { for (const [i, w, h] of fc.sizes || []) if (R.doc.sizes[i]) R.doc.sizes[i] = { w, h }; if (fc.cropDone) R.crop = fc.crop; }
  fxLayout(start);
  if (R.immersive && !LS.get('reflow:tipChrome', false)) { LS.set('reflow:tipChrome', true); toast('Tap the middle of the page for the menu. Pinch or double-tap to zoom.', 4500); }
  fxBox().focus({ preventScroll: true });
  R.doc.toc().then(t => { if (state.reader === R) { R.toc = t; buildToc(); fxStatus(); } }).catch(() => {});
  if (!(fc && fc.cropDone)) setTimeout(() => { if (state.reader === R) fxDetectCrop(R); }, 700);
  if (R.doc.realSizes && !(fc && fc.sized)) R.doc.realSizes(() => { if (state.reader === R) fxLayout({ page: R.fpage, frac: R.ffrac }); }).then(done => {
    if (!done || state.reader !== R) return;
    const s0 = R.doc.sizes[0];
    saveFx(R, { sized: true, sizes: R.doc.sizes.map((z, i) => [i, z.w, z.h]).filter(([, w, h]) => Math.abs(w - s0.w) > 1 || Math.abs(h - s0.h) > 1) });
  }).catch(() => {});
}
function saveFx(R, patch) {
  const b = R.rec; if (b.id === 'sample') return;
  b.fx = Object.assign({ n: R.doc.n }, b.fx && b.fx.n === R.doc.n ? b.fx : {}, patch);
  DB.put(b); // details only, so this is cheap
}

function fxLayout(anchor) {
  const R = state.reader; if (!R || !R.fixed) return;
  const fx = fxBox(), list = fxList();
  const paged = fxPaged();
  fx.classList.toggle('paged', paged);
  const W = fx.clientWidth, H = fx.clientHeight;
  R.W = W; R.H = H;
  const slots = list.children;
  let y = FX_GAP;
  for (let i = 0; i < R.doc.n; i++) {
    const s0 = R.doc.sizes[i], slot = slots[i], pg = slot.firstChild;
    const cr = fxCropFor(i), fx0 = cr ? cr[2] - cr[0] : 1, fy0 = cr ? cr[3] - cr[1] : 1;
    const s = { w: s0.w * fx0, h: s0.h * fy0 };
    let w, h;
    if (paged) {
      const fit = Math.min((W - 8) / s.w, (H - 8) / s.h);
      const z = i === R.zPage ? R.z : 1;
      w = s.w * fit * z; h = s.h * fit * z;
      slot.style.width = W + 'px'; slot.style.height = H + 'px';
      slot.classList.toggle('zoomed', z > 1.01);
    } else {
      w = Math.max(80, (Math.min(W, 1400) - 16) * R.z); h = w * s.h / s.w;
      slot.style.width = ''; slot.style.height = ''; slot.classList.remove('zoomed');
      R.tops[i] = y; y += h + FX_GAP;
    }
    R.pw[i] = w; R.ph[i] = h;
    const fw = w / fx0, fh = h / fy0; R.fw[i] = fw; R.fh[i] = fh;
    pg.style.width = w + 'px'; pg.style.height = h + 'px';
    pg.style.setProperty('--cw', fw + 'px'); pg.style.setProperty('--ch', fh + 'px');
    pg.style.setProperty('--cl', (cr ? -cr[0] * fw : 0) + 'px'); pg.style.setProperty('--ct', (cr ? -cr[1] * fh : 0) + 'px');
  }
  slotDisplay(paged);
  if (anchor) fxGo(anchor.page, anchor.frac, true);
  fxSchedule(true);
}
function slotDisplay(paged) { for (const s of fxList().children) s.style.display = paged ? '' : 'contents'; }

function fxCurrent() {
  const R = state.reader, fx = fxBox();
  if (fxPaged()) { const p = Math.max(0, Math.min(R.doc.n - 1, Math.round(fx.scrollLeft / (R.W || 1)))); return { page: p, frac: 0 }; }
  const y = fx.scrollTop + 1; const t = R.tops;
  let lo = 0, hi = R.doc.n - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (t[m] - FX_GAP / 2 <= y) lo = m; else hi = m - 1; }
  return { page: lo, frac: Math.max(0, Math.min(1, (y - t[lo]) / (R.ph[lo] || 1))) };
}
function fxGo(page, frac = 0, quiet) {
  const R = state.reader; if (!R || !R.fixed) return;
  page = Math.max(0, Math.min(R.doc.n - 1, page));
  const fx = fxBox();
  if (fxPaged()) {
    if (R.zPage >= 0 && R.zPage !== page) fxResetPageZoom();
    fx.scrollTo({ left: page * R.W, top: 0, behavior: 'instant' });
  } else fx.scrollTo({ top: Math.max(0, R.tops[page] + frac * R.ph[page] - 1), behavior: 'instant' });
  R.fpage = page; R.ffrac = frac;
  fxSchedule(true);
  if (!quiet) hideSel();
  fxStatus();
}
function fxTurn(dir) {
  const R = state.reader; if (!R) return;
  hideSel();
  if (fxPaged()) { fxGo(R.fpage + dir); return; }
  const fx = fxBox(); fx.scrollBy({ top: dir * (fx.clientHeight - 60), behavior: 'instant' });
}
function fxResetPageZoom() {
  const R = state.reader; if (!R || R.zPage < 0) return;
  const i = R.zPage; R.zPage = -1; R.z = 1;
  const slot = fxList().children[i]; if (slot) { slot.scrollLeft = 0; slot.scrollTop = 0; }
  fxLayout(null);
}

/* trim margins: find where the ink is on a few sample pages (odd and even pages separately) */
function fxCropFor(i) { const R = state.reader; return prefs.trim && R.crop ? R.crop[i % 2] : null; }
function inkBox(c) {
  const w = c.width, h = c.height; if (!w || !h) return null;
  const d = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  const rows = new Uint32Array(h), cols = new Uint32Array(w);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const k = (y * w + x) * 4; if (d[k] * 0.3 + d[k + 1] * 0.59 + d[k + 2] * 0.11 < 228) { rows[y]++; cols[x]++; } }
  const edge = Math.ceil(Math.min(w, h) * 0.012);
  const rowOK = y => y >= edge && y < h - edge && rows[y] > Math.max(2, w * 0.005) && rows[y] < w * 0.6;
  const colOK = x => x >= edge && x < w - edge && cols[x] > Math.max(2, h * 0.005) && cols[x] < h * 0.6;
  let y0 = 0; while (y0 < h && !rowOK(y0)) y0++;
  let y1 = h - 1; while (y1 > y0 && !rowOK(y1)) y1--;
  let x0 = 0; while (x0 < w && !colOK(x0)) x0++;
  let x1 = w - 1; while (x1 > x0 && !colOK(x1)) x1--;
  if (y0 >= y1 || x0 >= x1) return null;
  return [x0 / w, y0 / h, (x1 + 1) / w, (y1 + 1) / h];
}
async function fxDetectCrop(R) {
  const n = R.doc.n, count = Math.min(n, R.kind === 'djvu' ? 4 : 8), start = n > 6 ? 2 : 0;
  const picks = [];
  for (let k = 0; k < count; k++) { const i = start + Math.round((n - 1 - start) * k / Math.max(1, count - 1)); if (!picks.includes(i)) picks.push(i); }
  const boxes = [[], []];
  for (const i of picks) {
    if (state.reader !== R) return;
    try { const c = await R.doc.sample(i, 400); const b = inkBox(c); c.width = c.height = 0; if (b) boxes[i % 2].push(b); } catch {}
    await tick();
  }
  const merge = a => a.length ? [Math.min(...a.map(b => b[0])), Math.min(...a.map(b => b[1])), Math.max(...a.map(b => b[2])), Math.max(...a.map(b => b[3]))] : null;
  const fix = b => {
    if (!b) return null;
    const p = [Math.max(0, b[0] - 0.035), Math.max(0, b[1] - 0.025), Math.min(1, b[2] + 0.035), Math.min(1, b[3] + 0.025)];
    if (p[2] - p[0] < 0.45 || p[3] - p[1] < 0.45) return null;
    if ((p[2] - p[0]) * (p[3] - p[1]) > 0.93) return null; // margins already small
    return p;
  };
  const a = fix(merge(boxes[0]) || merge(boxes[1])), b = fix(merge(boxes[1]) || merge(boxes[0]));
  if (state.reader !== R) return;
  R.crop = a || b ? [a || b, b || a] : null;
  saveFx(R, { crop: R.crop, cropDone: true });
  if (R.crop && prefs.trim) fxLayout({ page: R.fpage, frac: R.ffrac });
}

/* rendering: visible pages first, then neighbours; far pages are released */
let fxT = 0;
function fxSchedule(now) { clearTimeout(fxT); fxT = setTimeout(fxRenderPass, now ? 0 : 90); }
function fxWanted() {
  const R = state.reader, fx = fxBox();
  const n = R.doc.n;
  if (fxPaged()) { const p = fxCurrent().page; return { vis: [p], near: [p + 1, p - 1, p + 2].filter(i => i >= 0 && i < n) }; }
  const top = fx.scrollTop, bot = top + fx.clientHeight;
  const vis = [], near = [];
  let i = fxCurrent().page; while (i > 0 && R.tops[i] > top) i--;
  for (let k = i; k < n && R.tops[k] < bot; k++) if (R.tops[k] + R.ph[k] > top) vis.push(k);
  const last = vis.length ? vis[vis.length - 1] : i;
  for (const k of [last + 1, vis[0] - 1, last + 2]) if (k >= 0 && k < n) near.push(k);
  return { vis, near };
}
async function fxRenderPass() {
  const R = state.reader; if (!R || !R.fixed || !R.doc) return;
  const { vis, near } = fxWanted();
  const keep = new Set([...vis, ...near]);
  const slots = fxList().children;
  fxEvict(keep);
  R.queue = [...vis, ...near];
  if (!R.busy) fxDrain().then(() => { if (state.reader === R) fxEvict(new Set([...fxWanted().vis, ...fxWanted().near])); });
}
function fxEvict(keep) {
  const R = state.reader; const slots = fxList().children; const maxKeep = R.kind === 'djvu' ? 7 : 6;
  for (const i of [...R.rendered.keys()]) {
    if (R.rendered.size <= maxKeep) break;
    if (!keep.has(i)) { R.doc.release(i, slots[i].firstChild); R.rendered.delete(i); }
  }
}
async function fxDrain() {
  const R = state.reader; if (!R || R.busy) return;
  R.busy = true;
  try {
    while (state.reader === R && R.queue.length) {
      const i = R.queue.shift();
      const key = Math.round(R.fw[i]);
      if (R.rendered.get(i) === key) continue;
      const el = fxList().children[i].firstChild;
      try {
        await R.doc.render(i, el, R.fw[i], R.fh[i]); R.rendered.set(i, key); paintFx(i);
        if (R.hit && R.hit.page === i) markHits(el);
        if (R.hlGo) { const mk = el.querySelector(`mark.hl[data-id="${CSS.escape(R.hlGo)}"]`); if (mk) { R.hlGo = null; fxReveal(mk); } }
      } catch (e) { if (!/cancel/i.test(String(e && (e.name || e.message)))) R.rendered.set(i, key); }
    }
  } finally { R.busy = false; }
}
function fxReveal(node) { // scroll so a search hit or highlight on the current page is in view
  if (fxPaged()) return;
  const fx = fxBox(); const r = node.getBoundingClientRect(), b = fx.getBoundingClientRect();
  if (r.top < b.top + 40 || r.bottom > b.bottom - 40) fx.scrollBy({ top: r.top - b.top - fx.clientHeight * 0.3, behavior: 'instant' });
}
function markHits(el) {
  const R = state.reader; if (!R || !R.hit) return;
  const q = R.hit.q.toLowerCase(); let first = null;
  for (const s of el.querySelectorAll('.textLayer span')) {
    const t = s.textContent.toLowerCase(); if (!t.trim()) continue;
    if (t.includes(q) || (t.trim().length >= 3 && q.includes(t.trim()))) { s.classList.add('hit'); if (!first) first = s; }
  }
  if (first) fxReveal(first);
}

function fxOutlineAt(p) { const R = state.reader; let t = null; for (const e of R.toc) if (e.page != null && e.page <= p && e.depth === 0) t = e; return t ? t.title : ''; }
function fxStatus() {
  const R = state.reader; if (!R || !R.fixed) return;
  const c = fxCurrent(); R.fpage = c.page; R.ffrac = c.frac; R.frac = c.frac;
  const n = R.doc.n, overall = Math.min(1, (c.page + (fxPaged() ? 1 : c.frac)) / n); R.overall = overall;
  $('#r-track').style.width = (overall * 100).toFixed(2) + '%';
  const sec = fxOutlineAt(c.page);
  $('#r-t2').textContent = sec || `${R.kind === 'pdf' ? 'PDF' : 'DjVu'} · ${fmt(n)} pages`;
  $('#r-where').textContent = `Page ${fmt(c.page + 1)} of ${fmt(n)}` + (R.z > 1.01 ? ` · ${Math.round(R.z * 100)}%` : '');
  $('#r-pct').textContent = Math.round(overall * 100) + '%';
  $('#r-mini').textContent = `${c.page + 1} / ${n}`;
  $('#r-bm-btn').setAttribute('aria-pressed', String(!!currentBookmark()));
  $('#zoom-val').textContent = Math.round(R.z * 100) + '%';
  savePos(false);
}
let fxScrollT = 0;
fxBox().addEventListener('scroll', () => {
  const R = state.reader; if (!R || !R.fixed || !R.doc) return;
  requestAnimationFrame(fxStatus);
  clearTimeout(fxScrollT);
  fxScrollT = setTimeout(() => {
    if (fxPaged() && R.zPage >= 0 && fxCurrent().page !== R.zPage) fxResetPageZoom();
    fxSchedule(true);
  }, 90);
}, { passive: true });

/* zoom */
const ZMIN = 1, ZMAX = 5;
let chipT = 0;
function zoomChip() { const c = $('#zoomchip'); c.textContent = Math.round(state.reader.z * 100) + '%'; c.hidden = false; clearTimeout(chipT); chipT = setTimeout(() => c.hidden = true, 900); }
function setZoom(z, ax, ay) {
  const R = state.reader; if (!R || !R.fixed) return;
  z = Math.max(ZMIN, Math.min(ZMAX, z));
  const fx = fxBox(); const br = fx.getBoundingClientRect();
  if (ax == null) { ax = br.left + fx.clientWidth / 2; ay = br.top + fx.clientHeight / 2; }
  const mx = ax - br.left, my = ay - br.top;
  if (fxPaged()) {
    const p = fxCurrent().page; const slot = fxList().children[p];
    const old = R.zPage === p ? R.z : 1; const k = z / old;
    const cx = slot.scrollLeft + mx, cy = slot.scrollTop + my;
    R.zPage = z > 1.01 ? p : -1; R.z = z > 1.01 ? z : 1;
    fxLayout(null); fx.scrollTo({ left: p * R.W, behavior: 'instant' });
    if (R.zPage >= 0) { slot.scrollLeft = cx * k - mx; slot.scrollTop = cy * k - my; }
  } else {
    const k = z / R.z; const cx = fx.scrollLeft + mx, cy = fx.scrollTop + my;
    R.z = z; fxLayout(null);
    fx.scrollLeft = cx * k - mx; fx.scrollTop = cy * k - my;
  }
  zoomChip(); fxStatus(); fxSchedule(true);
}
$('#zoom-out').addEventListener('click', () => { const R = state.reader; if (R && R.fixed) setZoom(R.z / 1.25); });
$('#zoom-in').addEventListener('click', () => { const R = state.reader; if (R && R.fixed) setZoom(R.z * 1.25); });
$('#zoom-fit').addEventListener('click', () => { const R = state.reader; if (R && R.fixed) setZoom(1); });
$('#fx-goto').addEventListener('submit', e => {
  e.preventDefault(); const R = state.reader; if (!R || !R.fixed) return;
  const v = parseInt($('#fx-goto-n').value, 10);
  if (v >= 1 && v <= R.doc.n) { closeSheets(); fxGo(v - 1, 0); } else toast(`Enter a page from 1 to ${R.doc.n}.`);
});

/* gestures on pages: tap zones, double-tap zoom, pinch zoom */
(() => {
  const fx = fxBox();
  let pinch = null, lastTap = null, tapT = 0, moved = false, t0 = null;
  const dist = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  fx.addEventListener('touchstart', e => {
    const R = state.reader; if (!R || !R.fixed) return;
    if (e.touches.length === 2) {
      const [a, b] = e.touches;
      const target = fxPaged() ? fxList().children[fxCurrent().page].firstChild : fxList();
      const tr = target.getBoundingClientRect();
      const mx = (a.clientX + b.clientX) / 2, my = (a.clientY + b.clientY) / 2;
      pinch = { d: dist(a, b), z: R.z, mx, my, target, s: 1 };
      target.style.transformOrigin = `${mx - tr.left}px ${my - tr.top}px`;
      hideSel();
    } else if (e.touches.length === 1) { moved = false; t0 = { x: e.touches[0].clientX, y: e.touches[0].clientY }; }
  }, { passive: true });
  fx.addEventListener('touchmove', e => {
    if (pinch && e.touches.length === 2) {
      e.preventDefault();
      const base = fxPaged() && state.reader.zPage !== fxCurrent().page ? 1 : pinch.z;
      pinch.s = Math.max(ZMIN / base, Math.min(ZMAX / base, dist(e.touches[0], e.touches[1]) / pinch.d));
      pinch.target.style.transform = `scale(${pinch.s})`;
    } else if (t0 && e.touches.length === 1 && Math.hypot(e.touches[0].clientX - t0.x, e.touches[0].clientY - t0.y) > 10) moved = true;
  }, { passive: false });
  const endPinch = () => {
    if (!pinch) return;
    const p = pinch; pinch = null;
    p.target.style.transform = ''; p.target.style.transformOrigin = '';
    const R = state.reader; const base = fxPaged() && R.zPage !== fxCurrent().page ? 1 : p.z;
    if (Math.abs(p.s - 1) > 0.03) setZoom(base * p.s, p.mx, p.my);
    moved = true;
  };
  fx.addEventListener('touchend', e => { if (e.touches.length < 2) endPinch(); }, { passive: true });
  fx.addEventListener('touchcancel', endPinch, { passive: true });
  fx.addEventListener('click', e => {
    const R = state.reader; if (!R || !R.fixed || hasSelection()) return;
    if (moved) { moved = false; return; }
    const mk = e.target.closest('mark.hl'); if (mk) { lastTap = null; clearTimeout(tapT); openNote(mk.dataset.id); return; }
    const r = fx.getBoundingClientRect(); const fxX = (e.clientX - r.left) / r.width;
    const edge = fxPaged() && (fxX < 0.28 || fxX > 0.72);
    if (edge && !(R.zPage >= 0)) { lastTap = null; fxTurn(fxX < 0.28 ? -1 : 1); return; }
    const now = Date.now();
    if (lastTap && now - lastTap.t < 320 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 40) {
      clearTimeout(tapT); lastTap = null;
      const z = fxPaged() ? (R.zPage >= 0 ? R.z : 1) : R.z;
      setZoom(z > 1.05 ? 1 : 2.5, e.clientX, e.clientY);
      return;
    }
    lastTap = { t: now, x: e.clientX, y: e.clientY };
    clearTimeout(tapT);
    tapT = setTimeout(() => { lastTap = null; if (edge) fxTurn(fxX < 0.28 ? -1 : 1); else toggleChrome(); }, 300);
  });
  fx.addEventListener('wheel', e => {
    const R = state.reader; if (!R || !R.fixed) return;
    if (e.ctrlKey) { e.preventDefault(); setZoom(R.z * (e.deltaY < 0 ? 1.12 : 1 / 1.12), e.clientX, e.clientY); return; }
    if (fxPaged() && !(R.zPage >= 0)) { e.preventDefault(); wheelTurn(e, fxTurn); }
  }, { passive: false });
})();

async function fxSearch(q, list, seq) {
  const R = state.reader; const ql = q.toLowerCase(); let count = 0, chars = 0; const LIMIT = 300;
  for (let i = 0; i < R.doc.n && count < LIMIT; i++) {
    if (!R.texts.has(i)) R.texts.set(i, await R.doc.pageText(i));
    if (seq !== searchSeq || state.reader !== R) return null;
    const t = R.texts.get(i); chars += t.trim().length;
    const tl = t.toLowerCase(); let from = 0, onPage = 0;
    while (count < LIMIT && onPage < 20) {
      const k = tl.indexOf(ql, from); if (k < 0) break;
      count++; onPage++; from = k + ql.length;
      const b = document.createElement('button'); b.type = 'button'; b.className = 'res';
      const s = document.createElement('small'); s.textContent = `Page ${i + 1}` + (fxOutlineAt(i) ? ` · ${fxOutlineAt(i)}` : '');
      const before = t.slice(Math.max(0, k - 50), k).replace(/\s+/g, ' '), hit = t.slice(k, k + q.length), after = t.slice(k + q.length, k + q.length + 80).replace(/\s+/g, ' ');
      const mk = document.createElement('mark'); mk.textContent = hit;
      b.append(s, document.createTextNode((k > 50 ? '…' : '') + before), mk, document.createTextNode(after + '…'));
      b.addEventListener('click', () => {
        closeSheets(); fxList().querySelectorAll('.textLayer span.hit').forEach(x => x.classList.remove('hit'));
        R.hit = { page: i, q }; fxGo(i, 0);
        const el = fxList().children[i].firstChild; if (R.rendered.has(i)) markHits(el);
      });
      list.append(b);
    }
    if (i % 20 === 19) $('#search-status').textContent = `Searching… page ${i + 1} of ${R.doc.n}`;
  }
  return { count, LIMIT, noText: chars === 0 };
}

function fxBuildToc() {
  const R = state.reader; const ol = $('#toc-list'); ol.replaceChildren();
  $('#fx-goto-n').max = R.doc ? R.doc.n : 1; $('#fx-goto-n').placeholder = R.doc ? `1 – ${R.doc.n}` : '';
  if (!R.toc.length) { const li = document.createElement('li'); li.className = 'pane-note'; li.textContent = 'This file has no table of contents. Use Go to page above.'; ol.append(li); return; }
  const cur = fxOutlineAt(R.fpage);
  for (const t of R.toc) {
    const li = document.createElement('li'); const b = document.createElement('button'); b.type = 'button'; b.className = 'toc-item';
    b.style.paddingLeft = (16 + Math.min(t.depth, 4) * 16) + 'px';
    b.append(document.createTextNode(t.title));
    if (t.page != null) { const sm = document.createElement('small'); sm.textContent = t.page + 1; b.append(sm); }
    else b.disabled = true;
    if (t.depth === 0 && t.title === cur) b.classList.add('on');
    b.addEventListener('click', () => { closeSheets(); if (t.page != null) fxGo(t.page, 0); });
    li.append(b); ol.append(li);
  }
}
/* ---------- read aloud (phone's own text-to-speech, offline voices) ---------- */
const TTS = { on: false, playing: false, items: [], i: 0, token: 0, rate: LS.get('reflow:ttsRate', 1), src: null };
const RATES = [0.8, 1, 1.25, 1.5, 1.75, 2];
const ttsEngine = () => plug('TextToSpeech');
function ttsLang(text) {
  if (/[਀-੿]/.test(text)) return 'pa-IN';
  if (/[ऀ-ॿ]/.test(text)) return 'hi-IN';
  const R = state.reader; const bl = R && R.book && R.book.lang;
  if (bl && /^[a-z]{2}/i.test(bl) && !/^en$/i.test(bl)) return bl;
  return /^en-/i.test(navigator.language || '') ? navigator.language : 'en-US';
}
function sentences(text) {
  text = text.replace(/\s+/g, ' ').trim(); if (!text) return [];
  let parts;
  try { parts = [...new Intl.Segmenter(undefined, { granularity: 'sentence' }).segment(text)].map(s => s.segment.trim()).filter(Boolean); }
  catch { parts = text.match(/[^.!?।॥]+[.!?।॥]+["”’)\]]*|[^.!?।॥]+$/g) || [text]; }
  const out = []; let cur = '';
  for (const p of parts) { if ((cur + ' ' + p).length > 420 && cur) { out.push(cur); cur = p; } else cur = cur ? cur + ' ' + p : p; }
  if (cur) out.push(cur);
  return out.flatMap(x => x.length > 3000 ? x.match(/.{1,3000}(\s|$)/g) : [x]);
}
function speak(text, lang) {
  const E = ttsEngine();
  if (E) return E.speak({ text, lang, rate: TTS.rate, pitch: 1, volume: 1, category: 'playback' });
  if (!window.speechSynthesis) return Promise.reject(new Error('Read aloud is not available on this device.'));
  return new Promise((res, rej) => {
    const u = new SpeechSynthesisUtterance(text); u.lang = lang; u.rate = TTS.rate;
    u.onend = () => res(); u.onerror = e => (e.error === 'interrupted' || e.error === 'canceled' ? res() : rej(new Error(e.error)));
    speechSynthesis.speak(u);
  });
}
function hush() { const E = ttsEngine(); if (E) { try { E.stop().catch(() => {}); } catch {} } else if (window.speechSynthesis) speechSynthesis.cancel(); }
const BLOCKS = 'p,h1,h2,h3,h4,h5,h6,li,blockquote,dd,dt,figcaption,td,th,pre';
function epubItems(fromVisible) {
  const c = $('#content'); const sc = $('#scroller').getBoundingClientRect();
  const els = [...c.querySelectorAll(BLOCKS)].filter(el => !el.querySelector(BLOCKS) && !el.closest('section.b-footnotes, aside, nav'));
  let start = 0;
  if (fromVisible) {
    start = els.findIndex(el => { for (const r of el.getClientRects()) if (r.bottom > sc.top + 4 && r.top < sc.bottom - 4 && r.right > sc.left + 2 && r.left < sc.right - 2) return true; return false; });
    if (start < 0) start = 0;
  }
  const items = [];
  for (const el of els.slice(start)) {
    const cl = el.cloneNode(true); cl.querySelectorAll('sup, rt, [role~="doc-noteref"], [aria-hidden="true"]').forEach(x => x.remove());
    for (const t of sentences(cl.textContent)) items.push({ el, text: t });
  }
  return items;
}
async function fixedItems(page) {
  const R = state.reader;
  for (let p = page; p < R.doc.n && p < page + 6; p++) {
    if (!R.texts.has(p)) R.texts.set(p, await R.doc.pageText(p));
    const t = R.texts.get(p).replace(/-\n(?=\p{Ll})/gu, '').replace(/\s+/g, ' ');
    const s = sentences(t);
    if (s.length) return s.map(text => ({ page: p, text }));
  }
  return null;
}
function ttsMark(it) {
  $$('.tts-now').forEach(x => x.classList.remove('tts-now'));
  const R = state.reader; if (!R || !it) return;
  if (R.fixed) { if (it.page !== R.fpage) fxGo(it.page, 0, true); return; }
  it.el.classList.add('tts-now');
  const sc = $('#scroller').getBoundingClientRect(); const r = it.el.getBoundingClientRect();
  const visible = r.bottom > sc.top + 20 && r.top < sc.bottom - 40 && r.left >= sc.left - 2 && r.right <= sc.right + 2;
  if (!visible) goToElement(it.el);
}
function ttsUi() {
  syncVolume();
  $('#ttsbar').hidden = !TTS.on;
  $('#r-tts-btn').setAttribute('aria-pressed', String(TTS.on));
  $('#tts-play').innerHTML = TTS.playing ? '<svg viewBox="0 0 24 24"><path d="M8 5v14M16 5v14"/></svg>' : '<svg viewBox="0 0 24 24"><path d="M7 4.5v15l12-7.5z" fill="currentColor"/></svg>';
  $('#tts-play').setAttribute('aria-label', TTS.playing ? 'Pause' : 'Play');
  $('#tts-rate').textContent = TTS.rate.toFixed(TTS.rate % 1 ? 2 : 1).replace(/0$/, '') + '×';
}
async function ttsLoop() {
  const tok = ++TTS.token; const R = state.reader;
  TTS.playing = true; ttsUi(); keepAwake(true);
  try {
    while (TTS.playing && tok === TTS.token && state.reader === R) {
      if (TTS.i >= TTS.items.length) {
        // move on to the next section or page
        if (R.fixed) {
          const last = TTS.items.length ? TTS.items[TTS.items.length - 1].page : R.fpage - 1;
          if (last + 1 >= R.doc.n) break;
          const next = await fixedItems(last + 1); if (!next || tok !== TTS.token) break;
          TTS.items = next; TTS.i = 0;
        } else {
          if (R.idx + 1 >= R.book.spine.length) break;
          await showChapter(R.idx + 1, 0); if (tok !== TTS.token) return;
          TTS.items = epubItems(false); TTS.i = 0;
          if (!TTS.items.length) continue;
        }
      }
      const it = TTS.items[TTS.i];
      ttsMark(it);
      await speak(it.text, ttsLang(it.text));
      if (tok !== TTS.token) return;
      TTS.i++;
    }
    if (tok === TTS.token) { TTS.playing = false; if (TTS.i >= TTS.items.length) { toast('Finished reading aloud.'); TTS.on = false; TTS.items = []; $$('.tts-now').forEach(x => x.classList.remove('tts-now')); } }
  } catch (e) {
    if (tok === TTS.token) { TTS.playing = false; toast((e && e.message) || 'Read aloud stopped.', 4000); }
  }
  if (tok === TTS.token) { ttsUi(); keepAwake(prefs.awake); }
}
async function ttsStart() {
  const R = state.reader; if (!R) return;
  closeSheets(); hideSel();
  if (!ttsEngine() && !window.speechSynthesis) { toast('Read aloud is not available on this device.'); return; }
  if (R.fixed) {
    if (!R.doc) return;
    const it = await fixedItems(R.fpage);
    if (!it) { toast(R.kind === 'djvu' ? 'This book has no text layer to read aloud. It is pictures of pages.' : 'No readable text on these pages. Scanned PDFs cannot be read aloud.', 4500); return; }
    TTS.items = it;
  } else TTS.items = epubItems(true);
  TTS.i = 0; TTS.on = true; ttsLoop();
}
function ttsPause() { TTS.playing = false; TTS.token++; hush(); ttsUi(); keepAwake(prefs.awake); }
function ttsStop() { if (!TTS.on) return; ttsPause(); TTS.on = false; TTS.items = []; $$('.tts-now').forEach(x => x.classList.remove('tts-now')); ttsUi(); }
function ttsSkip(d) {
  if (!TTS.on || !TTS.items.length) return;
  const cur = TTS.items[TTS.i] || TTS.items[TTS.items.length - 1];
  const key = it => (it.el || it.page);
  let j = TTS.i;
  if (d > 0) { while (j < TTS.items.length && key(TTS.items[j]) === key(cur)) j++; }
  else { while (j > 0 && key(TTS.items[j - 1]) === key(cur)) j--; if (j > 0) { const k = key(TTS.items[j - 1]); j--; while (j > 0 && key(TTS.items[j - 1]) === k) j--; } }
  TTS.i = Math.max(0, j); hush();
  if (TTS.playing) ttsLoop(); else ttsMark(TTS.items[TTS.i]);
}
$('#r-tts-btn').addEventListener('click', () => { if (TTS.on) ttsStop(); else ttsStart(); });
$('#tts-play').addEventListener('click', () => { if (TTS.playing) ttsPause(); else ttsLoop(); });
$('#tts-prev').addEventListener('click', () => ttsSkip(-1));
$('#tts-next').addEventListener('click', () => ttsSkip(1));
$('#tts-close').addEventListener('click', ttsStop);
$('#tts-rate').addEventListener('click', () => {
  TTS.rate = RATES[(RATES.indexOf(TTS.rate) + 1) % RATES.length] || 1; LS.set('reflow:ttsRate', TTS.rate); ttsUi();
  if (TTS.playing) { hush(); ttsLoop(); }
});

/* ---------- dimmer ---------- */
function applyDim() { const v = Math.max(0, Math.min(0.7, prefs.dim || 0)); $('#dimmer').style.opacity = v; $('#pref-dim').value = Math.round((1 - v) * 100); }
$('#pref-dim').addEventListener('input', e => { prefs.dim = 1 - (+e.target.value) / 100; LS.set('reflow:prefs', prefs); applyDim(); });
$('#pref-trim').addEventListener('change', e => changePref(() => prefs.trim = e.target.checked));
/* ---------- boot ---------- */
async function boot() {
  applyTheme();
  applyPrefs();
  await DB.open();
  try { state.books = await DB.all(); } catch { state.books = []; }
  for (const b of state.books) if (!b.format) b.format = 'epub';
  if (!LS.get('reflow:hideSample', false) && window.JSZip) {
    try {
      const blob = await buildEpub({ title: 'Welcome to Panna', author: 'Panna', chapters: SAMPLE });
      state.books.push({ id: 'sample', title: 'Welcome to Panna', author: '', format: 'epub', blob, cover: null, added: 0, pages: SAMPLE.length });
    } catch {}
  }
  renderShelf();
  if (!window.pdfjsLib) toast('The PDF engine did not load. EPUB reading still works.');
  if (isNative) {
    $('#widget-btn').hidden = !NATIVE();
    const APP = plug('App'), N = NATIVE();
    try {
      APP.addListener('backButton', () => {
        if (state.reader) {
          if (anySheetOpen()) closeSheets();
          else if (!$('#selbar').hidden) { getSelection().removeAllRanges(); hideSel(); }
          else if (state.reader.fixed && state.reader.z > 1.01) setZoom(1);
          else if (!state.reader.immersive) toggleChrome();
          else closeReader();
        } else if (lsheetOpen()) closeLSheets();
        else if (lib.q) { lib.q = ''; $('#lib-q').value = ''; renderGrid(); }
        else APP.exitApp();
      });
      APP.addListener('pause', () => { savePos(true); widgetSync(true); });
      APP.addListener('resume', () => { setStatusBar(); if (state.reader) keepAwake(prefs.awake); });
    } catch {}
    try {
      if (N) {
        N.addListener('incoming', pullIncoming);
        N.addListener('receiving', () => toast('Receiving the file…', 60000));
        N.addListener('volume', ev => { if (state.reader && !anySheetOpen()) turn(ev && ev.dir < 0 ? -1 : 1); });
        pullIncoming();
      }
    } catch {}
  }
  setStatusBar();
}
boot();
})();
