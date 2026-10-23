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

const defaults = {
  paletteIndex: 0, auto: true, size: 'M', opacity: 1, x: null, y: null, haptics: true, listen: true, sensitivity: 'M',
};
const SENSITIVITIES = [['L', '低（只對很明顯的聲音反應）'], ['M', '中'], ['H', '高（小聲也會動）']];
let state = { ...defaults };
let win = null;
let tray = null;
let autoTimer = null;
let saveTimer = null;
let dragOrigin = null;

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

const publicState = () => ({
  paletteIndex: state.paletteIndex, auto: state.auto, size: state.size, opacity: state.opacity,
  listen: state.listen, sensitivity: state.sensitivity,
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
}

function restartAuto() {
  clearInterval(autoTimer);
  autoTimer = null;
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

// ---------- 選單 ----------
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
    if (haptics) haptics.stop();
  });
  app.on('window-all-closed', () => { /* 常駐程式：不因視窗關閉而結束，用選單「結束」 */ });
}
