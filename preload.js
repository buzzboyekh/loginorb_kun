'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// 小球畫面只拿得到這幾個函式，沒有 Node 權限
contextBridge.exposeInMainWorld('orb', {
  getState: () => ipcRenderer.invoke('get-state'),
  onState: (cb) => { ipcRenderer.on('state', (_e, s) => cb(s)); },
  onEvent: (cb) => { ipcRenderer.on('event', (_e, ev) => cb(ev)); },   // 專注結束、休息結束
  nextPalette: () => ipcRenderer.send('next-palette'),
  dragStart: () => ipcRenderer.send('drag-start'),
  dragMove: (dx, dy) => ipcRenderer.send('drag-move', { dx, dy }),
  setIgnore: (v) => ipcRenderer.send('set-ignore', !!v),
  contextMenu: () => ipcRenderer.send('context-menu'),
  haptic: (kind) => ipcRenderer.send('haptic', String(kind)),
  requestMic: () => ipcRenderer.invoke('mic-request'),
  log: (msg) => ipcRenderer.send('renderer-log', String(msg)),
});
