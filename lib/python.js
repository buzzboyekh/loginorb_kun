'use strict';
// 找一個可以用的 python3（conda、Homebrew、python.org、Xcode 工具）
const fs = require('fs');
const os = require('os');
const path = require('path');

// /usr/bin/python3 在沒裝 Xcode 指令列工具時只是個殼，一執行就跳出安裝視窗，所以只有確定裝了才用
const hasXcodeTools = () =>
  fs.existsSync('/Library/Developer/CommandLineTools/usr/bin/python3') ||
  fs.existsSync('/Applications/Xcode.app/Contents/Developer/usr/bin/python3');

function isExecutableFile(p) {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch (_) {
    return false;
  }
}

function findPython() {
  const home = os.homedir();
  const candidates = [];
  if (process.env.LOCKIN_PYTHON) candidates.push(process.env.LOCKIN_PYTHON);
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (dir) candidates.push(path.join(dir, 'python3'));
  }
  for (const d of ['miniconda3', 'anaconda3', 'miniforge3', 'mambaforge', 'opt/miniconda3', 'opt/anaconda3']) {
    candidates.push(path.join(home, d, 'bin', 'python3'));
  }
  candidates.push(
    '/opt/homebrew/bin/python3',
    '/usr/local/bin/python3',
    '/Library/Frameworks/Python.framework/Versions/Current/bin/python3',
    '/usr/bin/python3',
  );
  const xcode = hasXcodeTools();
  for (const c of candidates) {
    if (c === '/usr/bin/python3' && !xcode) continue;
    if (isExecutableFile(c)) return c;
  }
  return null;
}

module.exports = { findPython };
