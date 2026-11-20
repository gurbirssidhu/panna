// Panna for Windows, macOS and Linux: the same web app as the Android version (../www), in an Electron window.
// The page doesn't see Capacitor here, so it uses its browser fallbacks (downloads for backups, the system's
// speech voices for read-aloud); window.PannaDesktop (preload.js) adds opening files from the system.
'use strict';
const { app, BrowserWindow, Menu, protocol, net, shell, ipcMain, powerSaveBlocker, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const WWW = app.isPackaged ? path.join(process.resourcesPath, 'www') : path.join(__dirname, '..', 'www');
const ORIGIN = 'app://panna';
const BOOK_EXT = /\.(epub|pdf|djvu|djv)$/i;
const MAX_OPEN = 2 * 1024 * 1024 * 1024; // larger than this can't be handed to the page in one piece

// The page is served from app://panna/ (a fixed, secure origin), so its library in IndexedDB stays put across
// updates and its Content-Security-Policy ('self') works as it does on Android.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true } },
]);
app.setAppUserModelId('app.panna.reader');
if (process.platform === 'linux') app.commandLine.appendSwitch('enable-speech-dispatcher'); // read-aloud voices

let win = null;
const pending = []; // books opened from the system that the page hasn't taken yet
let awake = null;

function queue(paths) {
  let added = false;
  for (const p of paths) {
    if (typeof p !== 'string' || !BOOK_EXT.test(p)) continue;
    try { if (!fs.statSync(p).isFile()) continue; } catch { continue; }
    pending.push(path.resolve(p));
    added = true;
  }
  if (added && win) {
    if (win.isMinimized()) win.restore();
    win.focus();
    win.webContents.send('incoming');
  }
}
const argvBooks = argv => argv.slice(app.isPackaged ? 1 : 2).filter(a => !a.startsWith('-'));

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    queue(argvBooks(argv));
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
  app.on('open-file', (e, p) => { e.preventDefault(); queue([p]); }); // macOS: Finder "Open with", dock drops
  queue(argvBooks(process.argv));
  app.whenReady().then(start);
}

function serve() {
  const root = path.resolve(WWW) + path.sep;
  protocol.handle('app', req => {
    const u = new URL(req.url);
    if (u.host !== 'panna') return new Response('Not found', { status: 404 });
    let rel = decodeURIComponent(u.pathname);
    if (rel === '/' || rel === '') rel = '/index.html';
    const file = path.resolve(root, '.' + rel);
    if (!file.startsWith(root)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });
}

// ---- window size and place, kept between runs ----
const stateFile = () => path.join(app.getPath('userData'), 'window.json');
function loadBounds() {
  try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch { return {}; }
}
function saveBounds() {
  if (!win || win.isDestroyed()) return;
  const s = { ...win.getNormalBounds(), maximized: win.isMaximized() };
  try { fs.writeFileSync(stateFile(), JSON.stringify(s)); } catch {}
}

function start() {
  serve();
  const st = loadBounds();
  win = new BrowserWindow({
    width: st.width || 1180, height: st.height || 820, x: st.x, y: st.y,
    minWidth: 360, minHeight: 480,
    title: 'Panna',
    backgroundColor: '#F2F3F7',
    show: false,
    autoHideMenuBar: true,
    icon: process.platform === 'linux' ? path.join(__dirname, 'build', 'icons', '256x256.png') : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  if (st.maximized) win.maximize();
  win.once('ready-to-show', () => win.show());
  win.on('close', saveBounds);
  win.on('closed', () => { win = null; });

  // Links in books open in the system browser; the app window never navigates away from the app.
  win.webContents.setWindowOpenHandler(({ url }) => { openOutside(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(ORIGIN + '/')) { e.preventDefault(); openOutside(url); } });
  // Backups and exported files: ask where to save them.
  win.webContents.session.on('will-download', item => {
    item.setSaveDialogOptions({ title: 'Save', defaultPath: path.join(app.getPath('downloads'), item.getFilename()) });
  });

  Menu.setApplicationMenu(menu());
  win.loadURL(ORIGIN + '/index.html');
}

function openOutside(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'https:' || u.protocol === 'http:' || u.protocol === 'mailto:') shell.openExternal(url);
  } catch {}
}

function menu() {
  const mac = process.platform === 'darwin';
  return Menu.buildFromTemplate([
    ...(mac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Add books…', accelerator: 'CmdOrCtrl+O', click: addBooks },
        { type: 'separator' },
        mac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'togglefullscreen' },
        { type: 'separator' },
        { role: 'resetZoom', label: 'Actual size' },
        { role: 'zoomIn', label: 'Larger interface' },
        { role: 'zoomOut', label: 'Smaller interface' },
        ...(app.isPackaged ? [] : [{ type: 'separator' }, { role: 'reload' }, { role: 'toggleDevTools' }]),
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'Panna on GitHub', click: () => shell.openExternal('https://github.com/gurbirssidhu/panna') },
        { label: 'Report a problem', click: () => shell.openExternal('https://github.com/gurbirssidhu/panna/issues') },
      ],
    },
  ]);
}

async function addBooks() {
  if (!win) return;
  const r = await dialog.showOpenDialog(win, {
    title: 'Add books',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Books', extensions: ['epub', 'pdf', 'djvu', 'djv'] }],
  });
  if (!r.canceled) queue(r.filePaths);
}

// ---- the page's side of opening files (preload.js) ----
ipcMain.handle('panna:take', async () => {
  const out = [];
  while (pending.length) {
    const p = pending.shift();
    const name = path.basename(p);
    try {
      const size = (await fs.promises.stat(p)).size;
      if (size > MAX_OPEN) { out.push({ name, error: 'It is too large to open (over 2 GB).' }); continue; }
      const buf = await fs.promises.readFile(p);
      out.push({ name, data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) });
    } catch (e) {
      out.push({ name, error: e.code === 'EACCES' ? 'Panna is not allowed to read it.' : 'It could not be read.' });
    }
  }
  return out;
});

ipcMain.on('panna:keepAwake', (_e, on) => {
  if (on && awake === null) awake = powerSaveBlocker.start('prevent-display-sleep');
  else if (!on && awake !== null) { powerSaveBlocker.stop(awake); awake = null; }
});

app.on('window-all-closed', () => app.quit());
