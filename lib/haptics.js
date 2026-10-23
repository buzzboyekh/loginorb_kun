'use strict';
// 觸控板震動管理
//   優先：「分段強度」後端 —— python3 + 私有框架 MultitouchSupport（assets/haptic_mt.py），弱／中／強可選，手指沒碰也會震
//   備援：系統公開 API —— osascript + NSHapticFeedbackManager（assets/haptic-helper.js），只有輕／重，手指要碰著觸控板
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { findPython } = require('./python');

const MIN_GAP = 50;     // ms：兩次震動的最短間隔（HapticKey 也用 50ms）
const MAX_LAG = 250;    // ms：排隊超過這個就丟掉，避免越積越多、震動跟畫面脫節

// 強度等級 → 實際指令；陣列代表連打幾下（每下間隔 MIN_GAP）
// 最重的 BOOM（ID 6 連打三下）只留給爆破的那一瞬間，其他時候最多到「中」
const BOOM = 9;
const LEVELS = {
  mt: { 1: ['3'], 2: ['4'], 3: ['4', '4'], [BOOM]: ['6', '6', '6'] },  // MTActuator actuation ID：3 弱、4 中、6 強
  ns: { 1: ['g'], 2: ['g'], 3: ['g', 'g'], [BOOM]: ['l', 'l', 'l'] },  // NSHapticFeedbackManager：g 輕、l 重
};

// 畫面送來的事件 → [延遲 ms, 強度等級]
const KINDS = {
  h1: [[0, 1]],                       // 長按前段、連點提醒：輕
  h2: [[0, 2]],                       // 長按後段、快破前的連點：中
  h3: [[0, 2]],
  tick: [[0, 1]],
  heavy: [[0, 2]],
  step: [[0, 3]],                     // 長按升級到下一段：中連打兩下
  thunk: [[0, 2]],                    // 長按中途放開
  // 爆破分五段，段與段之間留空白，分段感才明顯（畫面在 330ms 炸開，和 BOOM 同步）：
  //   預兆（越來越重的連打）→ 屏息（不震）→ 爆（最重）→ 衝擊波（中）→ 碎片落地（輕、越來越疏）
  pop: [
    [0, 1], [55, 1], [110, 2], [165, 2],          // 預兆
    [330, BOOM],                                  // 爆
    [600, 2], [720, 2],                           // 衝擊波
    [900, 1], [1060, 1], [1250, 1],               // 碎片落地
  ],
  bigpop: [
    [0, 2], [50, 2], [100, 2], [150, 2], [200, 2], // 預兆（長按已經在中等強度，直接衝刺）
    [330, BOOM],                                  // 爆
    [600, 2], [730, 2], [860, 2],                 // 衝擊波
    [1050, 1], [1220, 1], [1420, 1], [1650, 1],   // 碎片落地
  ],
};

class Haptics {
  constructor(opts = {}) {
    this.assetsDir = opts.assetsDir;
    this.workDir = opts.workDir;
    this.log = opts.log || ((...a) => console.error('[haptic]', ...a));
    this.pythonPath = opts.pythonPath;            // 測試用
    this.osascriptPath = opts.osascriptPath || '/usr/bin/osascript';
    this.force = !!opts.force;                    // 測試用：非 macOS 也啟動
    this.backend = null;                          // 'mt' | 'ns' | null
    this.proc = null;
    this.nextFree = 0;
    this.restarts = 0;
    this.stopped = false;
  }

  start() {
    if (this.stopped || this.proc) return;
    if (process.platform !== 'darwin' && !this.force) return;
    this._startMT();
  }

  stop() {
    this.stopped = true;
    if (this.proc) {
      try { this.proc.stdin.end(); this.proc.kill(); } catch (_) { /* 忽略 */ }
    }
    this.proc = null;
    this.backend = null;
  }

  play(kind) {
    const seq = KINDS[kind];
    if (!seq || !this.backend) return;
    for (const [ms, level] of seq) {
      if (ms === 0) this._level(level);
      else setTimeout(() => this._level(level), ms);
    }
  }

  // ---------- 內部 ----------
  _level(level) {
    const cmds = this.backend && LEVELS[this.backend][level];
    if (!cmds) return;
    for (const c of cmds) this._queue(c);
  }

  _queue(cmd) {
    const now = Date.now();
    const at = Math.max(now, this.nextFree);
    if (at - now > MAX_LAG) return;
    this.nextFree = at + MIN_GAP;
    if (at === now) this._write(cmd);
    else setTimeout(() => this._write(cmd), at - now);
  }

  _write(cmd) {
    const p = this.proc;
    if (!p || !p.stdin.writable) return;
    try { p.stdin.write(this.backend === 'mt' ? cmd + '\n' : cmd); } catch (_) { /* 忽略 */ }
  }

  _copyAsset(name) {
    // 複製到 userData 再執行：打包成 .app 後 assets 可能在 asar 裡，外部程式讀不到
    const dst = path.join(this.workDir, name);
    fs.mkdirSync(this.workDir, { recursive: true });
    fs.writeFileSync(dst, fs.readFileSync(path.join(this.assetsDir, name)));
    return dst;
  }

  _startMT() {
    const py = this.pythonPath || findPython();
    if (!py) { this._startNS('找不到 python3'); return; }
    let script;
    try { script = this._copyAsset('haptic_mt.py'); } catch (e) { this._startNS(e.message); return; }

    this.log('試分段震動，用', py);
    const p = spawn(py, ['-u', script], { stdio: ['pipe', 'pipe', 'pipe'] });
    let decided = false;
    const decide = (ok, why) => {
      if (decided) return;
      decided = true;
      clearTimeout(timer);
      if (ok) {
        this.proc = p;
        this.backend = 'mt';
        this.log('分段震動已啟用', why);
      } else {
        try { p.kill(); } catch (_) { /* 忽略 */ }
        this._startNS(why);
      }
    };
    const timer = setTimeout(() => decide(false, '啟動逾時'), 4000);

    p.stdin.on('error', () => {});
    p.stderr.on('data', (d) => this.log(String(d).trim()));
    p.on('error', (e) => decide(false, e.message));
    readline.createInterface({ input: p.stdout }).on('line', (line) => {
      if (line.startsWith('READY')) decide(true, line.slice(6));
      else if (line.startsWith('NOMT')) decide(false, line.slice(5));
      else if (line.startsWith('LOST')) this.log('觸控板連線中斷');
    });
    p.on('exit', (code) => {
      if (!decided) { decide(false, `結束代碼 ${code}`); return; }
      if (this.proc !== p) return;
      this.proc = null;
      this.backend = null;
      if (!this.stopped && this.restarts++ < 3) setTimeout(() => this._startMT(), 1500);
    });
  }

  _startNS(why) {
    if (this.stopped) return;
    this.log('分段震動不能用（' + why + '），改用系統內建震動');
    let script;
    try { script = this._copyAsset('haptic-helper.js'); } catch (e) { this.log(e.message); return; }
    const p = spawn(this.osascriptPath, ['-l', 'JavaScript', script], { stdio: ['pipe', 'ignore', 'pipe'] });
    p.stdin.on('error', () => {});
    p.stderr.on('data', (d) => this.log(String(d).trim()));
    p.on('error', (e) => this.log('osascript 無法啟動：', e.message));
    p.on('exit', () => {
      if (this.proc !== p) return;
      this.proc = null;
      this.backend = null;
      if (!this.stopped && this.restarts++ < 3) setTimeout(() => this._startNS('重新啟動'), 1500);
    });
    this.proc = p;
    this.backend = 'ns';
  }
}

module.exports = { Haptics, KINDS, LEVELS, MIN_GAP, BOOM };
