// 測試觸控板震動：在 lockin-orb 資料夾執行 npm run test-haptic
ObjC.import('AppKit');

function run() {
  const p = $.NSHapticFeedbackManager.defaultPerformer;
  console.log('請把一根手指輕放在觸控板上（不用按下去），2 秒後開始震動…');
  delay(2);
  for (let i = 0; i < 10; i++) {
    p.performFeedbackPatternPerformanceTime(0, 1);
    delay(0.15);
  }
  delay(0.3);
  p.performFeedbackPatternPerformanceTime(2, 1);
  return '結束。剛剛有感覺到一連串輕輕的震動嗎？';
}
