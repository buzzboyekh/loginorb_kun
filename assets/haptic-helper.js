// 觸控板震動小幫手（JavaScript for Automation，由 macOS 內建的 osascript 執行）
// Lock-in Orb 啟動時會開著它，透過 stdin 一次送一個字元：
//   g = generic（輕點）  a = alignment（對齊感）  l = levelChange（較重的一下）
// 系統限制：手指要碰著 Force Touch 觸控板才會震；用外接滑鼠時不會有感覺。
ObjC.import('AppKit');

function run() {
  try {
    // 不要在 Dock 出現圖示
    $.NSApplication.sharedApplication.setActivationPolicy(2);
  } catch (e) { /* 忽略 */ }

  const performer = $.NSHapticFeedbackManager.defaultPerformer;
  const input = $.NSFileHandle.fileHandleWithStandardInput;
  const PATTERN = { g: 0, a: 1, l: 2 };
  const NOW = 1; // NSHapticFeedbackPerformanceTimeNow

  while (true) {
    const data = input.availableData;
    if (data.length === 0) break; // Lock-in Orb 關閉 → stdin 結束 → 跟著結束
    const text = $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding).js;
    for (const ch of text) {
      if (Object.prototype.hasOwnProperty.call(PATTERN, ch)) {
        performer.performFeedbackPatternPerformanceTime(PATTERN[ch], NOW);
      }
    }
  }
}
