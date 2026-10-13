'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('lumen', {
  openDialog: (opts) => ipcRenderer.invoke('dialog:open', opts),
  saveDialog: (opts) => ipcRenderer.invoke('dialog:save', opts),
  messageBox: (opts) => ipcRenderer.invoke('dialog:message', opts),
  readFile: (p) => ipcRenderer.invoke('fs:read', p),
  writeFile: (p, data) => ipcRenderer.invoke('fs:write', p, data),
  stat: (p) => ipcRenderer.invoke('fs:stat', p),
  listImages: (dir) => ipcRenderer.invoke('fs:listImages', dir),
  storeLoad: (name) => ipcRenderer.invoke('store:load', name),
  storeSave: (name, text) => ipcRenderer.invoke('store:save', name, text),
  thumbRead: (id) => ipcRenderer.invoke('thumbs:read', id),
  thumbWrite: (id, data) => ipcRenderer.invoke('thumbs:write', id, data),
  osDecode: (data, ext) => ipcRenderer.invoke('image:osDecode', data, ext),
  clipboardWriteImage: (png) => ipcRenderer.invoke('clipboard:writeImage', png),
  clipboardReadImage: () => ipcRenderer.invoke('clipboard:readImage'),
  launchFiles: () => ipcRenderer.invoke('app:launchFiles'),
  info: () => ipcRenderer.invoke('app:info'),
  setTitle: (t) => ipcRenderer.send('app:set-title', t),
  confirmClose: () => ipcRenderer.send('app:close-confirmed'),
  toggleFullscreen: () => ipcRenderer.send('app:toggle-fullscreen'),
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file); } catch { return ''; }
  },
  onOpenFiles: (cb) => ipcRenderer.on('app:open-files', (_e, files) => cb(files)),
  onCloseRequested: (cb) => ipcRenderer.on('app:close-requested', () => cb()),
});
