'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// 設定視窗能用的函式。沒有 Node 權限，只能透過這幾個 IPC 跟主程序講話。
contextBridge.exposeInMainWorld('settings', {
  get: () => ipcRenderer.invoke('settings:get'),
  set: (patch) => ipcRenderer.invoke('settings:set', patch),
  onChange: (cb) => { ipcRenderer.on('settings', (_e, s) => cb(s)); },
  onGo: (cb) => { ipcRenderer.on('go', (_e, section) => cb(String(section))); },
  focus: (cmd, arg) => ipcRenderer.invoke('settings:focus', String(cmd), arg),
  hapticTest: () => ipcRenderer.send('settings:haptic-test'),
  requestMic: () => ipcRenderer.invoke('settings:mic-request'),
  openMicSettings: () => ipcRenderer.send('settings:open-mic-settings'),
  openAutomationSettings: () => ipcRenderer.send('settings:open-automation-settings'),
  resetPosition: () => ipcRenderer.send('settings:reset-position'),
  showOrb: () => ipcRenderer.send('settings:show-orb'),
  openUrl: (url) => ipcRenderer.send('settings:open-url', String(url)),
  close: () => ipcRenderer.send('settings:close'),
});
