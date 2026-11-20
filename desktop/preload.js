// The little the desktop app adds to the web page: books opened from the system, keeping the screen on, and the
// optional Wiktionary download.
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('PannaDesktop', {
  platform: process.platform,
  /** Books opened from the system (file manager, "Open with", File > Add books…): [{ name, data } | { name, error }]. */
  take: () => ipcRenderer.invoke('panna:take'),
  /** cb() runs when more books are waiting to be taken. */
  onIncoming: cb => { ipcRenderer.on('incoming', () => cb()); },
  keepAwake: on => ipcRenderer.send('panna:keepAwake', !!on),
  /** Downloads one of Panna's own release files (the Wiktionary pack): resolves to an ArrayBuffer. */
  download: (url, onProgress) => {
    const h = (_e, p) => { try { onProgress(p); } catch {} };
    ipcRenderer.on('panna:progress', h);
    return ipcRenderer.invoke('panna:download', url).finally(() => ipcRenderer.removeListener('panna:progress', h));
  },
});
