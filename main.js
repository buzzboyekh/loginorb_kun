'use strict';
// Lock-in Orb — 主程序
// 一個透明、無邊框、永遠浮在最上層（含全螢幕 App 上方）的小球。

const {
  app, BrowserWindow, Menu, Tray, nativeImage, globalShortcut, ipcMain, screen, systemPreferences, session, shell,
} = require('electron');
const path = require('path');
const fs = require('fs');

// ---------- 執行紀錄：寫到專案資料夾的 last-run.log，出問題時方便查 ----------
const LOG_FILE = path.join(__dirname, 'last-run.log');
function log(...parts) {
  const text = parts
    .map((p) => (p instanceof Error ? p.stack : p && typeof p === 'object' ? JSON.stringify(p) : String(p)))
    .join(' ');
  const line = `[${new Date().toLocaleTimeString('zh-TW', { hour12: false })}] ${text}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (_) { /* 打包後資料夾可能不能寫，忽略 */ }
}
try { fs.writeFileSync(LOG_FILE, ''); } catch (_) { /* 忽略 */ }
process.on('uncaughtException', (e) => log('錯誤 uncaughtException', e));
process.on('unhandledRejection', (e) => log('錯誤 unhandledRejection', e));
log('啟動', `Electron ${process.versions.electron}`, process.platform,
  typeof process.getSystemVersion === 'function' ? process.getSystemVersion() : '', process.arch);

// 聽聲音用的 AudioContext 不用等使用者點一下才能開始
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const { PALETTES, SEASONS, TIMES } = require('./renderer/palettes.js');
let Haptics = null;
try {
  ({ Haptics } = require('./lib/haptics'));
} catch (e) {
  log('震動模組載入失敗（小球照常運作，只是不會震）', e);
}

const SIZES = { S: 200, M: 300, L: 400 };           // 視窗邊長（球約佔 60%，其餘是光暈）
const SIZE_LABELS = { S: '小', M: '中', L: '大' };
const OPACITIES = [1, 0.8, 0.6, 0.4];
const AUTO_INTERVAL_MS = 12000;                      // 自動變色間隔
const SHORTCUT = 'CommandOrControl+Alt+O';           // 顯示 / 隱藏
const FOCUS_SHORTCUT = 'CommandOrControl+Alt+L';     // 開始 / 結束專注
const FOCUS_CHOICES = [15, 25, 45, 90];              // 選單裡的專注長度（分鐘）
const DRIFT_POLL_MS = 4000;                          // 專注中多久看一次前景 App
// 預設會算「分心」的 App（前景切到這些就把小球調暗）。使用者可以在設定裡改。
const DEFAULT_DRIFT_APPS = ['LINE', 'Discord', 'Messages', '訊息', 'Telegram', 'Instagram', 'Threads', 'WhatsApp', 'TikTok'];

const defaults = {
  paletteIndex: 0, auto: true, size: 'M', opacity: 1, x: null, y: null, haptics: true, listen: true, sensitivity: 'M',
  // 專注（lock-in）
  focusMin: 25, breakMin: 5, driftWatch: true, driftApps: DEFAULT_DRIFT_APPS, autoBreak: true,
  // 第一次打開才會跑設定精靈
  onboarded: false,
};
const SENSITIVITIES = [['L', '低（只對很明顯的聲音反應）'], ['M', '中'], ['H', '高（小聲也會動）']];
let state = { ...defaults };
let win = null;
let tray = null;
let autoTimer = null;
let saveTimer = null;
let dragOrigin = null;
let settingsWin = null;

// ---------- 設定存取 ----------
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

function loadState() {
  try {
    state = { ...defaults, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) };
  } catch (_) { /* 第一次執行：沒有設定檔 */ }
  if (!SIZES[state.size]) state.size = defaults.size;
  if (!(state.paletteIndex >= 0 && state.paletteIndex < PALETTES.length)) state.paletteIndex = 0;
  if (!(state.opacity >= 0.2 && state.opacity <= 1)) state.opacity = 1;
  state.auto = state.auto !== false;
  state.haptics = state.haptics !== false;
  state.listen = state.listen !== false;
  if (!SENSITIVITIES.some(([k]) => k === state.sensitivity)) state.sensitivity = 'M';
  state.focusMin = clampInt(state.focusMin, 1, 240, defaults.focusMin);
  state.breakMin = clampInt(state.breakMin, 0, 60, defaults.breakMin);
  state.driftWatch = state.driftWatch !== false;
  state.autoBreak = state.autoBreak !== false;
  state.onboarded = state.onboarded === true;
  if (!Array.isArray(state.driftApps)) state.driftApps = DEFAULT_DRIFT_APPS.slice();
  state.driftApps = state.driftApps.map((s) => String(s).trim()).filter(Boolean).slice(0, 50);
}

function clampInt(v, lo, hi, fallback) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : fallback;
}

function saveStateSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
      fs.writeFileSync(settingsFile(), JSON.stringify(state));
    } catch (e) { log('設定存檔失敗', e); }
  }, 400);
}

// 小球畫面拿到的狀態（含專注進度）
const publicState = () => ({
  paletteIndex: state.paletteIndex, auto: state.auto, size: state.size, opacity: state.opacity,
  listen: state.listen, sensitivity: state.sensitivity,
  focus: focusSnapshot(),
});

// 設定視窗拿到的完整設定（不含座標）
const settingsSnapshot = () => ({
  paletteIndex: state.paletteIndex, auto: state.auto, size: state.size, opacity: state.opacity,
  haptics: state.haptics, hapticBackend: haptics && haptics.backend ? haptics.backend : (state.haptics ? 'unknown' : 'off'),
  listen: state.listen, sensitivity: state.sensitivity, micStatus,
  focusMin: state.focusMin, breakMin: state.breakMin, driftWatch: state.driftWatch, driftApps: state.driftApps,
  autoBreak: state.autoBreak, onboarded: state.onboarded,
  launchAtLogin: getLaunchAtLogin(), driftSupported: process.platform === 'darwin',
  focus: focusSnapshot(), palettes: PALETTES, sizes: SIZE_LABELS, opacities: OPACITIES,
  focusChoices: FOCUS_CHOICES, shortcuts: { toggle: '⌥⌘O', focus: '⌥⌘L' }, version: app.getVersion(),
});

// ---------- 位置 ----------
// 視窗座標要是整數；Math.round 可能算出「負零」(-0)，Electron 不接受，所以轉成 0
const px = (v) => Math.round(v) || 0;

function defaultPosition(size) {
  const wa = screen.getPrimaryDisplay().workArea;
  return { x: px(wa.x + wa.width - size - 40), y: px(wa.y + wa.height - size - 40) };
}

function isOnScreen(x, y, size) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  const cx = x + size / 2, cy = y + size / 2;
  return screen.getAllDisplays().some(({ workArea: b }) =>
    cx >= b.x && cx <= b.x + b.width && cy >= b.y && cy <= b.y + b.height);
}

function resetPosition() {
  if (!win) return;
  const size = SIZES[state.size];
  const p = defaultPosition(size);
  win.setPosition(p.x, p.y);
}

// ---------- 視窗 ----------
function createWindow() {
  const size = SIZES[state.size];
  const pos = isOnScreen(state.x, state.y, size) ? { x: state.x, y: state.y } : defaultPosition(size);

  win = new BrowserWindow({
    width: size,
    height: size,
    x: pos.x,
    y: pos.y,
    show: false,
    transparent: true,
    backgroundColor: '#00000000',
    frame: false,
    hasShadow: false,
    resizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    // macOS 的 panel：點擊小球不會把你正在用的 App 切走焦點，而且能浮在全螢幕 App 上
    type: process.platform === 'darwin' ? 'panel' : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setOpacity(state.opacity);
  win.setIgnoreMouseEvents(true, { forward: true }); // 預設穿透，滑鼠移到球上才接收

  log('建立視窗', { x: pos.x, y: pos.y, size }, '螢幕', screen.getAllDisplays().map((d) => d.workArea));
  const wc = win.webContents;
  wc.on('did-fail-load', (_e, code, desc, url) => log('畫面載入失敗', code, desc, url));
  wc.on('preload-error', (_e, p, err) => log('preload 錯誤', p, err));
  wc.on('render-process-gone', (_e, d) => log('畫面程序結束', d));
  wc.on('console-message', (e) => {
    if (e && (e.level === 'error' || e.level === 'warning')) log('畫面', e.level, e.message, `${e.sourceId || ''}:${e.lineNumber || ''}`);
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => {
    win.showInactive();
    refreshTray();
    log('小球已顯示', win.getBounds(), '可見', win.isVisible());
  });

  win.on('move', () => {
    const [x, y] = win.getPosition();
    state.x = x; state.y = y;
    saveStateSoon();
  });
  win.on('closed', () => { win = null; });
}

function applySize(key) {
  if (!win || !SIZES[key]) return;
  state.size = key;
  const b = win.getBounds();
  const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
  const s = SIZES[key];
  win.setResizable(true);
  win.setBounds({ x: px(cx - s / 2), y: px(cy - s / 2), width: s, height: s });
  win.setResizable(false);
  saveStateSoon();
  refreshTray();
}

function applyOpacity(v) {
  state.opacity = v;
  if (win) win.setOpacity(v);
  saveStateSoon();
  refreshTray();
}

function toggleVisible() {
  if (!win) return;
  if (win.isVisible()) win.hide(); else win.showInactive();
  refreshTray();
}

// ---------- 顏色 ----------
function broadcast() {
  if (win && !win.isDestroyed()) win.webContents.send('state', publicState());
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('settings', settingsSnapshot());
}

// 一次性的事件（專注結束、休息結束），小球畫面拿去放動畫
function emitEvent(name, data) {
  if (win && !win.isDestroyed()) win.webContents.send('event', { name, ...(data || {}) });
}

function restartAuto() {
  clearInterval(autoTimer);
  autoTimer = null;
  if (focus.phase === 'focus' || focus.phase === 'paused') return; // 專注時不自動換色
  if (state.auto) autoTimer = setInterval(() => setPalette((state.paletteIndex + 1) % PALETTES.length, false), AUTO_INTERVAL_MS);
}

function setPalette(idx, manual) {
  state.paletteIndex = idx;
  broadcast();
  saveStateSoon();
  refreshTray();
  if (manual) restartAuto(); // 手動換色後，重新計時，不要馬上又被自動換掉
}

function setAuto(on) {
  state.auto = !!on;
  restartAuto();
  saveStateSoon();
  refreshTray();
}

// ---------- 觸控板震動 ----------
// 細節在 lib/haptics.js：優先用分段強度（python + MultitouchSupport），不行就退回系統內建震動
let haptics = null;

function haptic(kind) {
  if (state.haptics && haptics) haptics.play(kind);
}

// ---------- 聽周圍的聲音 ----------
// 畫面只拿音量和頻段來畫，聲音不錄、不存、不上傳。macOS 第一次會問麥克風權限。
let micStatus = 'unknown';
const micBlocked = () => micStatus === 'denied' || micStatus === 'restricted';

async function requestMic() {
  if (process.platform !== 'darwin') { micStatus = 'granted'; return { granted: true, status: micStatus }; }
  try {
    micStatus = systemPreferences.getMediaAccessStatus('microphone');
    if (micStatus === 'not-determined') {
      micStatus = (await systemPreferences.askForMediaAccess('microphone')) ? 'granted' : 'denied';
    }
  } catch (e) {
    log('查麥克風權限失敗', e);
  }
  log('麥克風權限', micStatus);
  refreshTray();
  return { granted: micStatus === 'granted', status: micStatus };
}

function openMicSettings() {
  shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone');
}

function setListen(on) {
  state.listen = !!on;
  log(state.listen ? '開啟：跟著聲音波動' : '關閉：跟著聲音波動');
  broadcast();
  saveStateSoon();
  refreshTray();
}

function setSensitivity(k) {
  state.sensitivity = k;
  broadcast();
  saveStateSoon();
  refreshTray();
}

// ---------- 專注（lock-in）----------
// 一段專注 = 從 startedAt 到 endsAt。小球畫面只拿這兩個時間自己算進度，主程序不用每秒推。
// phase：idle（沒在專注）｜focus｜paused｜break
const focus = { phase: 'idle', startedAt: 0, endsAt: 0, total: 0, remaining: 0, drift: false, driftApp: '', sessionsToday: 0, dayKey: '' };
let focusTimer = null;
let driftTimer = null;
let driftBusy = false;

function focusSnapshot() {
  return {
    phase: focus.phase, startedAt: focus.startedAt, endsAt: focus.endsAt, total: focus.total,
    remaining: focus.phase === 'paused' ? focus.remaining : Math.max(0, focus.endsAt - Date.now()),
    drift: focus.drift, driftApp: focus.driftApp, sessionsToday: focus.sessionsToday,
  };
}

function fmtRemaining(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

function refreshTrayTitle() {
  if (!tray || tray.isDestroyed() || typeof tray.setTitle !== 'function') return;
  if (focus.phase === 'focus') tray.setTitle(fmtRemaining(focus.endsAt - Date.now()), { fontType: 'monospacedDigit' });
  else if (focus.phase === 'paused') tray.setTitle(`⏸ ${fmtRemaining(focus.remaining)}`, { fontType: 'monospacedDigit' });
  else if (focus.phase === 'break') tray.setTitle(`☕ ${fmtRemaining(focus.endsAt - Date.now())}`, { fontType: 'monospacedDigit' });
  else tray.setTitle('');
}

function bumpSessionsToday() {
  const key = new Date().toDateString();
  if (focus.dayKey !== key) { focus.dayKey = key; focus.sessionsToday = 0; }
  focus.sessionsToday += 1;
}

function startFocus(minutes) {
  const min = clampInt(minutes, 1, 240, state.focusMin);
  const now = Date.now();
  Object.assign(focus, { phase: 'focus', startedAt: now, endsAt: now + min * 60000, total: min * 60000, remaining: 0, drift: false, driftApp: '' });
  log('開始專注', `${min} 分鐘`);
  if (state.auto) { clearInterval(autoTimer); autoTimer = null; } // 專注時顏色不自動換，畫面安靜一點
  haptic('step');
  startFocusTicker();
  startDriftWatch();
  afterFocusChange();
}

function pauseFocus() {
  if (focus.phase !== 'focus') return;
  focus.remaining = Math.max(0, focus.endsAt - Date.now());
  focus.phase = 'paused';
  focus.drift = false;
  stopDriftWatch();
  log('暫停專注', fmtRemaining(focus.remaining));
  afterFocusChange();
}

function resumeFocus() {
  if (focus.phase !== 'paused') return;
  const now = Date.now();
  focus.startedAt = now - (focus.total - focus.remaining);
  focus.endsAt = now + focus.remaining;
  focus.phase = 'focus';
  startDriftWatch();
  log('繼續專注');
  afterFocusChange();
}

function stopFocus(reason) {
  const was = focus.phase;
  Object.assign(focus, { phase: 'idle', startedAt: 0, endsAt: 0, total: 0, remaining: 0, drift: false, driftApp: '' });
  stopFocusTicker();
  stopDriftWatch();
  if (was !== 'idle') log('結束專注', reason || '');
  restartAuto();
  afterFocusChange();
}

function startBreak(minutes) {
  const min = clampInt(minutes, 1, 60, state.breakMin);
  const now = Date.now();
  Object.assign(focus, { phase: 'break', startedAt: now, endsAt: now + min * 60000, total: min * 60000, remaining: 0, drift: false, driftApp: '' });
  stopDriftWatch();
  startFocusTicker();
  log('開始休息', `${min} 分鐘`);
  afterFocusChange();
}

// 每秒看一次有沒有到時間；畫面上的進度由 renderer 自己插值
function startFocusTicker() {
  stopFocusTicker();
  focusTimer = setInterval(() => {
    if (focus.phase === 'focus' && Date.now() >= focus.endsAt) {
      bumpSessionsToday();
      log('專注完成', `第 ${focus.sessionsToday} 段`);
      emitEvent('focus-done', { sessionsToday: focus.sessionsToday });
      if (state.autoBreak && state.breakMin > 0) startBreak(state.breakMin);
      else stopFocus('完成');
    } else if (focus.phase === 'break' && Date.now() >= focus.endsAt) {
      emitEvent('break-done');
      haptic('h2');
      stopFocus('休息結束');
    } else {
      refreshTrayTitle();
    }
  }, 1000);
}

function stopFocusTicker() { clearInterval(focusTimer); focusTimer = null; }

function afterFocusChange() {
  broadcast();
  refreshTray();
  refreshTrayTitle();
}

function toggleFocus() {
  if (focus.phase === 'idle') startFocus(state.focusMin);
  else stopFocus('快捷鍵');
}

// 分心偵測：專注中每幾秒問一次 macOS 前景是哪個 App（System Events，第一次會跳「允許控制」的詢問）。
// 只拿 App 名稱，不看視窗內容；其他平台不支援，直接略過。
function startDriftWatch() {
  stopDriftWatch();
  if (process.platform !== 'darwin' || !state.driftWatch) return;
  driftTimer = setInterval(pollFrontmost, DRIFT_POLL_MS);
  pollFrontmost();
}

function stopDriftWatch() {
  clearInterval(driftTimer); driftTimer = null;
  if (focus.drift) { focus.drift = false; focus.driftApp = ''; }
}

function pollFrontmost() {
  if (driftBusy || focus.phase !== 'focus') return;
  driftBusy = true;
  const { execFile } = require('child_process');
  execFile('osascript', ['-e', 'tell application "System Events" to get name of first application process whose frontmost is true'],
    { timeout: 2500 }, (err, stdout) => {
      driftBusy = false;
      if (err) { if (!pollFrontmost.warned) { pollFrontmost.warned = true; log('分心偵測無法讀前景 App（可能沒給「自動化」權限）', err.message); } return; }
      const name = String(stdout || '').trim();
      const drift = !!name && state.driftApps.some((a) => a.toLowerCase() === name.toLowerCase());
      if (drift !== focus.drift) {
        focus.drift = drift;
        focus.driftApp = drift ? name : '';
        log(drift ? `分心：${name}` : '回到專注');
        if (drift) haptic('h1');
        broadcast();
      }
    });
}

function getLaunchAtLogin() {
  try { return !!app.getLoginItemSettings().openAtLogin; } catch (_) { return false; }
}

function setLaunchAtLogin(on) {
  try { app.setLoginItemSettings({ openAtLogin: !!on }); } catch (e) { log('設定開機啟動失敗', e); }
}

// ---------- 設定視窗（也是第一次打開的設定精靈） ----------
function openSettings(section) {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show(); settingsWin.focus();
    if (section) settingsWin.webContents.send('go', section);
    return;
  }
  settingsWin = new BrowserWindow({
    width: 560, height: 680, minWidth: 420, minHeight: 520,
    title: 'Lock-in Orb 設定', show: false, backgroundColor: '#0c0e22',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload-settings.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
    },
  });
  settingsWin.loadFile(path.join(__dirname, 'renderer', 'settings.html'), {
    query: { section: section || (state.onboarded ? 'focus' : 'setup') },
  });
  settingsWin.once('ready-to-show', () => { settingsWin.show(); if (app.dock) app.dock.show(); });
  settingsWin.on('closed', () => { settingsWin = null; if (app.dock) app.dock.hide(); });
  settingsWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

// ---------- 選單 ----------
function focusMenu() {
  const items = [];
  if (focus.phase === 'idle') {
    items.push(...FOCUS_CHOICES.map((m) => ({ label: `開始專注 ${m} 分鐘`, click: () => startFocus(m) })));
    items.push({ label: '自訂長度…', click: () => openSettings('focus') });
  } else {
    if (focus.phase === 'focus') items.push({ label: `專注中  剩 ${fmtRemaining(focus.endsAt - Date.now())}`, enabled: false });
    if (focus.phase === 'paused') items.push({ label: `已暫停  剩 ${fmtRemaining(focus.remaining)}`, enabled: false });
    if (focus.phase === 'break') items.push({ label: `休息中  剩 ${fmtRemaining(focus.endsAt - Date.now())}`, enabled: false });
    if (focus.phase === 'focus') items.push({ label: '暫停', click: pauseFocus });
    if (focus.phase === 'paused') items.push({ label: '繼續', click: resumeFocus });
    if (focus.phase === 'break') items.push({ label: '跳過休息，再來一段', click: () => startFocus(state.focusMin) });
    items.push({ label: '結束', click: () => stopFocus('選單') });
  }
  return items;
}

function buildMenu() {
  const paletteMenu = SEASONS.map((season) => ({
    label: season.label,
    submenu: TIMES.map((time) => {
      const idx = PALETTES.findIndex((p) => p.seasonId === season.id && p.timeId === time.id);
      return {
        label: time.label,
        type: 'radio',
        checked: idx === state.paletteIndex,
        click: () => setPalette(idx, true),
      };
    }),
  }));

  return Menu.buildFromTemplate([
    ...focusMenu(),
    { type: 'separator' },
    { label: '換下一個顏色', click: () => setPalette((state.paletteIndex + 1) % PALETTES.length, true) },
    { label: '自動變色', type: 'checkbox', checked: state.auto, click: (item) => setAuto(item.checked) },
    {
      label: '觸控板震動',
      type: 'checkbox',
      checked: state.haptics,
      click: (item) => { state.haptics = item.checked; saveStateSoon(); refreshTray(); },
    },
    { label: '色票', submenu: paletteMenu },
    { type: 'separator' },
    micBlocked()
      ? { label: '跟著聲音波動（麥克風權限被關掉了，點這裡打開）', click: openMicSettings }
      : { label: '跟著聲音波動', type: 'checkbox', checked: state.listen, click: (item) => setListen(item.checked) },
    {
      label: '聲音靈敏度',
      enabled: state.listen && !micBlocked(),
      submenu: SENSITIVITIES.map(([k, label]) => ({
        label, type: 'radio', checked: state.sensitivity === k, click: () => setSensitivity(k),
      })),
    },
    { type: 'separator' },
    {
      label: '大小',
      submenu: Object.keys(SIZES).map((k) => ({
        label: SIZE_LABELS[k], type: 'radio', checked: state.size === k, click: () => applySize(k),
      })),
    },
    {
      label: '透明度',
      submenu: OPACITIES.map((v) => ({
        label: `${Math.round(v * 100)}%`, type: 'radio', checked: Math.abs(state.opacity - v) < 0.01, click: () => applyOpacity(v),
      })),
    },
    { type: 'separator' },
    { label: `${win && win.isVisible() ? '隱藏' : '顯示'}小球    ⌥⌘O`, click: toggleVisible },
    { label: '移回右下角', click: resetPosition },
    { type: 'separator' },
    { label: '設定…', click: () => openSettings() },
    { type: 'separator' },
    { label: '結束 Lock-in Orb', role: 'quit' },
  ]);
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'trayTemplate.png'));
  tray = new Tray(icon);
  tray.setToolTip('Lock-in Orb');
  tray.setContextMenu(buildMenu());
}

function refreshTray() {
  if (tray && !tray.isDestroyed()) tray.setContextMenu(buildMenu());
}

// ---------- IPC（來自小球畫面） ----------
ipcMain.handle('get-state', () => publicState());
ipcMain.on('next-palette', () => setPalette((state.paletteIndex + 1) % PALETTES.length, true));
ipcMain.on('drag-start', () => { if (win) dragOrigin = win.getPosition(); });
ipcMain.on('drag-move', (_e, d) => {
  if (!win || !dragOrigin || !d || !Number.isFinite(d.dx) || !Number.isFinite(d.dy)) return;
  try {
    win.setPosition(px(dragOrigin[0] + d.dx), px(dragOrigin[1] + d.dy));
  } catch (e) {
    log('拖曳失敗', e.message);
  }
});
ipcMain.on('set-ignore', (_e, ignore) => { if (win) win.setIgnoreMouseEvents(!!ignore, { forward: true }); });
ipcMain.on('context-menu', () => { if (win) buildMenu().popup({ window: win }); });
ipcMain.on('haptic', (_e, kind) => haptic(String(kind)));
ipcMain.handle('mic-request', () => requestMic());
ipcMain.on('renderer-log', (_e, m) => log('[畫面]', String(m).slice(0, 500)));

// ---------- IPC（來自設定視窗） ----------
ipcMain.handle('settings:get', () => settingsSnapshot());
ipcMain.handle('settings:set', (_e, patch) => {
  if (!patch || typeof patch !== 'object') return settingsSnapshot();
  for (const [k, v] of Object.entries(patch)) {
    switch (k) {
      case 'paletteIndex': if (Number.isInteger(v) && v >= 0 && v < PALETTES.length) setPalette(v, true); break;
      case 'auto': setAuto(!!v); break;
      case 'size': applySize(String(v)); break;
      case 'opacity': if (OPACITIES.includes(Number(v))) applyOpacity(Number(v)); break;
      case 'haptics': state.haptics = !!v; break;
      case 'listen': setListen(!!v); break;
      case 'sensitivity': if (SENSITIVITIES.some(([key]) => key === v)) setSensitivity(v); break;
      case 'focusMin': state.focusMin = clampInt(v, 1, 240, state.focusMin); break;
      case 'breakMin': state.breakMin = clampInt(v, 0, 60, state.breakMin); break;
      case 'autoBreak': state.autoBreak = !!v; break;
      case 'driftWatch':
        state.driftWatch = !!v;
        if (focus.phase === 'focus') startDriftWatch();
        break;
      case 'driftApps':
        if (Array.isArray(v)) state.driftApps = v.map((s) => String(s).trim()).filter(Boolean).slice(0, 50);
        break;
      case 'launchAtLogin': setLaunchAtLogin(!!v); break;
      case 'onboarded': state.onboarded = !!v; break;
      default: log('設定視窗送來不認識的欄位', k);
    }
  }
  saveStateSoon();
  broadcast();
  refreshTray();
  return settingsSnapshot();
});
ipcMain.handle('settings:focus', (_e, cmd, arg) => {
  switch (cmd) {
    case 'start': startFocus(arg); break;
    case 'pause': pauseFocus(); break;
    case 'resume': resumeFocus(); break;
    case 'stop': stopFocus('設定視窗'); break;
    case 'break': startBreak(arg); break;
    default: break;
  }
  return focusSnapshot();
});
ipcMain.on('settings:haptic-test', () => { if (haptics) haptics.play('pop'); });
ipcMain.handle('settings:mic-request', () => requestMic());
ipcMain.on('settings:open-mic-settings', openMicSettings);
ipcMain.on('settings:open-automation-settings', () => {
  shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Automation');
});
ipcMain.on('settings:reset-position', resetPosition);
ipcMain.on('settings:show-orb', () => { if (win && !win.isVisible()) toggleVisible(); });
ipcMain.on('settings:open-url', (_e, url) => {
  const u = String(url || '');
  if (/^https:\/\/(github\.com|libraries\.dev)\//.test(u)) shell.openExternal(u);
});
ipcMain.on('settings:close', () => { if (settingsWin) settingsWin.close(); });

// ---------- 生命週期 ----------
if (!app.requestSingleInstanceLock()) {
  log('已經有一個 Lock-in Orb 在執行（可能在別的終端機視窗），這次不再開新的，改把原本那顆叫出來。');
  console.log('\n→ Lock-in Orb 已經在執行了。要重開：點選單列的圓圈圖示 →「結束 Lock-in Orb」，再 npm start。\n');
  app.quit();
} else {
  app.on('second-instance', () => {
    log('收到重複啟動 → 把小球叫出來');
    if (!win) createWindow();
    else if (!win.isVisible()) toggleVisible();
  });

  app.whenReady().then(() => {
    log('Electron 準備好了');
    if (app.dock) app.dock.hide(); // 只留在選單列，不佔 Dock
    loadState();
    // 只允許小球的頁面用麥克風（音訊），其他權限一律拒絕
    session.defaultSession.setPermissionRequestHandler((_wc, permission, cb, details) => {
      const audioOnly = permission === 'media' && (!details || !details.mediaTypes || details.mediaTypes.every((m) => m === 'audio'));
      cb(audioOnly);
    });
    session.defaultSession.setPermissionCheckHandler((_wc, permission, _origin, details) =>
      permission === 'media' && (!details || details.mediaType !== 'video'));
    createWindow();
    createTray();
    restartAuto();
    log('設定', state);
    if (Haptics) {
      try {
        haptics = new Haptics({
          assetsDir: path.join(__dirname, 'assets'),
          workDir: app.getPath('userData'),
          log: (...a) => log('[震動]', ...a),
        });
        haptics.start();
      } catch (e) {
        log('震動啟動失敗（小球照常運作）', e);
      }
    }
    globalShortcut.register(SHORTCUT, toggleVisible);
    globalShortcut.register(FOCUS_SHORTCUT, toggleFocus);
    // 第一次打開：跑一次設定精靈（權限、外觀、專注長度）
    if (!state.onboarded) setTimeout(() => openSettings('setup'), 800);

    // 外接螢幕被拔掉時，小球不要消失在看不到的地方
    const rescue = () => {
      if (win && !isOnScreen(win.getPosition()[0], win.getPosition()[1], SIZES[state.size])) resetPosition();
    };
    screen.on('display-removed', rescue);
    screen.on('display-metrics-changed', rescue);
    log('啟動完成');
  }).catch((e) => log('啟動失敗', e));

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    stopFocusTicker();
    stopDriftWatch();
    if (haptics) haptics.stop();
  });
  app.on('window-all-closed', () => { /* 常駐程式：不因視窗關閉而結束，用選單「結束」 */ });
}
