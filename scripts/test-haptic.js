'use strict';
// npm run test-haptic：依序播放各段強度，確認觸控板震動
// 先試分段強度版（python + MultitouchSupport）；不能用就改測系統內建震動
// 所有輸出同時寫進專案資料夾的 last-test-haptic.log，出問題時方便查
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { findPython } = require('../lib/python');

const root = path.join(__dirname, '..');
const LOG = path.join(root, 'last-test-haptic.log');
try { fs.writeFileSync(LOG, ''); } catch (_) { /* 忽略 */ }

function say(text) {
  process.stdout.write(text);
  try { fs.appendFileSync(LOG, text); } catch (_) { /* 忽略 */ }
}

function run(cmd, args) {
  return new Promise((resolve) => {
    let p;
    try {
      p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      say(`無法執行 ${cmd}：${e.message}\n`);
      resolve(-1);
      return;
    }
    p.stdout.on('data', (d) => say(String(d)));
    p.stderr.on('data', (d) => say(String(d)));
    p.on('error', (e) => { say(`無法執行 ${cmd}：${e.message}\n`); resolve(-1); });
    p.on('close', (code, signal) => {
      if (signal) say(`（${path.basename(cmd)} 被系統中止：${signal}）\n`);
      resolve(code === null ? -1 : code);
    });
  });
}

(async () => {
  say(`${new Date().toLocaleString('zh-TW')}  node ${process.version} ${process.arch}\n`);
  const py = findPython();
  if (py) {
    say(`用 ${py} 測試分段震動…\n\n`);
    const code = await run(py, ['-u', path.join(root, 'assets', 'haptic_mt.py'), '--ladder']);
    if (code === 0) return;
    say(`\n（分段震動結束代碼 ${code}）分段震動在這台 Mac 上不能用，改測系統內建震動（只有輕／重兩種，手指要碰著觸控板）…\n\n`);
  } else {
    say('找不到 python3，改測系統內建震動（只有輕／重兩種，手指要碰著觸控板）…\n\n');
  }
  const code2 = await run('/usr/bin/osascript', ['-l', 'JavaScript', path.join(root, 'scripts', 'haptic-test.js')]);
  say(`\n（系統內建震動測試結束代碼 ${code2}）\n`);
  process.exitCode = code2 === 0 ? 0 : 1;
})();
