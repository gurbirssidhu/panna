// The little the desktop app adds to the web page: books opened from the system, and keeping the screen on.
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('PannaDesktop', {
  platform: process.platform,
  /** Books opened from the system (file manager, "Open with", File > Add books…): [{ name, data } | { name, error }]. */
  take: () => ipcRenderer.invoke('panna:take'),
  /** cb() runs when more books are waiting to be taken. */
  onIncoming: cb => { ipcRenderer.on('incoming', () => cb()); },
  keepAwake: on => ipcRenderer.send('panna:keepAwake', !!on),
});
