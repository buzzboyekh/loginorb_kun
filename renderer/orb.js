// Lock-in 解壓小球：畫面與互動
// v2：柔邊光暈、若隱若現的光絲、果凍般的互動。全部用原生 Canvas 2D，不依賴 p5.js。
(() => {
  'use strict';

  const TAU = Math.PI * 2;
  const WHITE = [255, 255, 255];
  const INK = [12, 14, 34];
  const N_PARTICLES = 520;  // 光絲數量
  const FADE = 0.025;       // 光絲殘影每幀淡出比例（越小拖得越長）
  const N_SPARKS = 150;     // 會閃爍的細小光點
  const FRESH_HOLD = 6, FRESH_FADE = 14; // 破掉重生後：先當 6 秒淡色透明的新泡泡，再用 14 秒慢慢回到平常

  const cvs = document.getElementById('c');
  const ctx = cvs.getContext('2d');
  const layer = () => { const c = document.createElement('canvas'); return [c, c.getContext('2d')]; };
  const [body, bctx] = layer();   // 球體：畫完後用柔邊遮罩羽化
  const [trail, tctx] = layer();  // 光絲累積層
  const [bloom, gctx] = layer();  // 光絲的模糊光暈（半解析度）
  const [film, fctx] = layer();   // 快破時的泡泡膜虹彩

  // ---------- 與主程序溝通（在瀏覽器直接開 index.html 時用替身，方便預覽） ----------
  function makeStubApi() {
    const qs = new URLSearchParams(location.search);
    let idx = Number(qs.get('p')) || 0;
    const listen = qs.get('listen') === '1';      // ?listen=1 開麥克風
    const sensitivity = qs.get('sens') || 'M';
    const listeners = [];
    const eventListeners = [];
    // 預覽專注狀態：?focus=25（分鐘）&elapsed=10（已過幾分鐘）&drift=1（分心）&phase=break
    let fakeFocus = null;
    const fm = Number(qs.get('focus'));
    if (fm > 0) {
      const total = fm * 60000, elapsed = Math.min(total, (Number(qs.get('elapsed')) || 0) * 60000);
      const now = Date.now();
      fakeFocus = {
        phase: qs.get('phase') === 'break' ? 'break' : qs.get('phase') === 'paused' ? 'paused' : 'focus',
        startedAt: now - elapsed, endsAt: now + total - elapsed, total, remaining: total - elapsed,
        drift: qs.get('drift') === '1', driftApp: qs.get('drift') === '1' ? 'LINE' : '', sessionsToday: 0,
      };
    }
    const snapshot = () => ({ paletteIndex: idx, listen, sensitivity, focus: fakeFocus });
    const emit = () => listeners.forEach((f) => f(snapshot()));
    // 預覽用：window.__orbEvent('focus-done') 可以手動觸發結束動畫
    window.__orbEvent = (name) => eventListeners.forEach((f) => f({ name }));
    return {
      getState: () => Promise.resolve(snapshot()),
      onState: (f) => listeners.push(f),
      onEvent: (f) => eventListeners.push(f),
      nextPalette: () => { idx = (idx + 1) % PALETTES.length; emit(); },
      dragStart() {}, dragMove() {}, setIgnore() {}, contextMenu() {},
      // 瀏覽器預覽時記錄震動指令，方便檢查節奏
      haptic: (k) => { (window.__haptics = window.__haptics || []).push([Math.round(performance.now()), k]); },
      requestMic: () => Promise.resolve({ granted: true, status: 'granted' }),
      log: (m) => console.log('[orb]', m),
    };
  }
  const api = window.orb || makeStubApi();
  const haptic = (k) => { if (api.haptic) api.haptic(k); };
  const rlog = (m) => { try { if (api.log) api.log(String(m)); } catch (_) { /* 忽略 */ } };

  // ---------- Perlin noise ----------
  const noise3 = (() => {
    const perm = Array.from({ length: 256 }, (_, i) => i);
    let seed = 20261022;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [perm[i], perm[j]] = [perm[j], perm[i]];
    }
    const p = new Uint8Array(512);
    for (let i = 0; i < 512; i++) p[i] = perm[i & 255];
    const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
    const lerp = (a, b, t) => a + (b - a) * t;
    const grad = (h, x, y, z) => {
      h &= 15;
      const u = h < 8 ? x : y;
      const v = h < 4 ? y : h === 12 || h === 14 ? x : z;
      return ((h & 1) ? -u : u) + ((h & 2) ? -v : v);
    };
    return (x, y, z) => {
      const X = Math.floor(x) & 255, Y = Math.floor(y) & 255, Z = Math.floor(z) & 255;
      x -= Math.floor(x); y -= Math.floor(y); z -= Math.floor(z);
      const u = fade(x), v = fade(y), w = fade(z);
      const A = p[X] + Y, AA = p[A] + Z, AB = p[A + 1] + Z;
      const B = p[X + 1] + Y, BA = p[B] + Z, BB = p[B + 1] + Z;
      return lerp(
        lerp(lerp(grad(p[AA], x, y, z), grad(p[BA], x - 1, y, z), u),
             lerp(grad(p[AB], x, y - 1, z), grad(p[BB], x - 1, y - 1, z), u), v),
        lerp(lerp(grad(p[AA + 1], x, y, z - 1), grad(p[BA + 1], x - 1, y, z - 1), u),
             lerp(grad(p[AB + 1], x, y - 1, z - 1), grad(p[BB + 1], x - 1, y - 1, z - 1), u), v),
        w);
    };
  })();

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const smooth = (e0, e1, x) => { const q = clamp((x - e0) / (e1 - e0), 0, 1); return q * q * (3 - 2 * q); };
  const damp = (rate, dt) => 1 - Math.exp(-rate * dt);

  // ---------- 顏色 ----------
  const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  const rgba = (c, a) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a < 0 ? 0 : a > 1 ? 1 : a})`;
  const mixc = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

  function rgb2hsl([r, g, b]) {
    r /= 255; g /= 255; b /= 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
    if (d === 0) return [0, 0, l];
    const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    const h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [h / 6, s, l];
  }
  function hsl2rgb([h, s, l]) {
    const f = (p, q, t) => {
      if (t < 0) t += 1; if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    if (s === 0) return [l * 255, l * 255, l * 255];
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
    return [f(p, q, h + 1 / 3) * 255, f(p, q, h) * 255, f(p, q, h - 1 / 3) * 255];
  }
  // 同色系和諧：莫內色票很淡，直接疊加會洗成白色，所以要補一點飽和度；
  // 但 6 個顏色各自補飽和會變成彩虹、互相打架。所以先找出這組色票的主色調，
  // 把每個顏色的色相往主色調收攏到前後約 30 度內，飽和度也壓在柔和的範圍。灰白色維持中性當柔光。
  function paletteHue(cols) {
    let x = 0, y = 0, wsum = 0;
    for (const c of cols) {
      const [h, s] = rgb2hsl(c);
      const w = s > 0.05 ? Math.sqrt(s) : 0; // 多數決：不讓少數特別鮮豔的顏色把主色調拉走
      x += Math.cos(h * TAU) * w; y += Math.sin(h * TAU) * w; wsum += w;
    }
    return { hue: ((Math.atan2(y, x) / TAU) + 1) % 1, neutral: wsum < 0.15 };
  }
  function harmonize(cols) {
    const { hue: h0, neutral } = paletteHue(cols);
    return cols.map((c) => {
      const [h, s, l] = rgb2hsl(c);
      const k = clamp((s - 0.02) / 0.13, 0, 1);            // 近灰色不硬補飽和度
      let d = h - h0; d -= Math.round(d);                  // 和主色調的差（-0.5..0.5）
      const h2 = neutral ? h : (h0 + clamp(d * 0.45, -0.085, 0.085) + 1) % 1;
      const s2 = Math.min(0.52, s + (Math.max(s, 0.46) - s) * k);
      return hsl2rgb([h2, s2, clamp(l, 0.36, 0.68)]);
    });
  }
  const hueDiff = (a, b) => { let d = a - b; d -= Math.round(d); return d; };

  let cur = PALETTES[0].colors.map(hex);
  let tgt = cur.map((c) => c.slice());
  let curV = harmonize(cur);
  let tgtV = curV.map((c) => c.slice());
  let hueNow = paletteHue(cur).hue;                       // 主色調（給虹彩邊、光點用），會平滑過渡
  let hueTgt = hueNow;
  let firstState = true;
  let snapNext = false; // 泡泡重新長出來時，直接用新顏色（不慢慢過渡）

  function applyState(s) {
    if (!s) return;
    if (s.sensitivity) sensitivity = s.sensitivity;
    if (s.listen !== undefined) setListening(!!s.listen);
    if (s.focus !== undefined) applyFocus(s.focus);
    if (s.paletteIndex === undefined) return;
    const pal = PALETTES[((s.paletteIndex % PALETTES.length) + PALETTES.length) % PALETTES.length];
    tgt = pal.colors.map(hex);
    tgtV = harmonize(tgt);
    hueTgt = paletteHue(tgt).hue;
    if (firstState || snapNext) {
      cur = tgt.map((c) => c.slice());
      curV = tgtV.map((c) => c.slice());
      hueNow = hueTgt;
      firstState = false;
      snapNext = false;
    }
  }

  // 光暈色：以飽和度加權平均，比單純平均更有「顏色」
  function glowColor() {
    let r = 0, g = 0, b = 0, wsum = 0;
    for (const c of curV) {
      const sat = Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]);
      const w = (sat + 25) ** 2;
      r += c[0] * w; g += c[1] * w; b += c[2] * w; wsum += w;
    }
    return mixc([r / wsum, g / wsum, b / wsum], WHITE, 0.3 * fresh);
  }

  // ---------- 尺寸 ----------
  let W = 0, H = 0, DPR = 1, R = 100, U = 1; // U：以半徑 100px 為基準的縮放單位
  function resize() {
    DPR = window.devicePixelRatio || 1;
    W = window.innerWidth; H = window.innerHeight;
    for (const c of [cvs, body, trail, film]) { c.width = Math.round(W * DPR); c.height = Math.round(H * DPR); }
    bloom.width = Math.max(1, Math.round((W * DPR) / 2));
    bloom.height = Math.max(1, Math.round((H * DPR) / 2));
    R = Math.min(W, H) * 0.30; // 留空間給外圍光暈
    U = R / 100;
    initParticles();
    initSparks();
    prewarm(40);
  }

  // ---------- 互動狀態 ----------
  let t = 0, tw = 0;            // 總時間 / 色塊流動時間（隨能量加速）
  let energy = 0;               // 0..1：互動時升高
  let hover = 0, hoverTarget = false;
  let mx = 0, my = 0;           // 游標（相對視窗中心）
  let mvx = 0, mvy = 0;         // 游標速度 px/s（攪動用）
  let lastMoveT = 0;
  let down = null;              // 按下中的資訊
  let qx = 0, qy = 0;           // 按下的位置
  let pressAngle = 0;
  let sq = 0, sqv = 0;          // 擠壓彈簧
  let jx = 0, jy = 0, jvx = 0, jvy = 0; // 果凍：球心偏移彈簧
  let ignoring = null;
  const pulses = [];            // 點擊／放開時的光
  const blobs = Array.from({ length: 6 }, () => ({ x: 0, y: 0, ox: 0, oy: 0, vx: 0, vy: 0 }));

  // 連點張力 → 泡泡破掉
  const TAP_TENSION = 0.11;     // 每點一下增加的張力（越接近極限加得越少，連點約 13 下會破）
  let tension = 0;              // 0..1，停手 0.8 秒後會慢慢鬆回去
  let ts = 0, tsv = 0;          // 畫面上的張力（彈簧：每點一下抖一下）
  let freshT = -100;            // 重生的時間
  let fresh = 0;                // 0..1：新泡泡的程度（淡色、透明、虹彩邊）
  let lastTapT = -10;
  let popPhase = 0;             // 0 正常｜3 準備爆｜1 剛破掉（球不見）｜2 重新長出來
  let popT = -10;
  let bub = 1, bubv = 0;        // 泡泡本體縮放：破掉歸零，再「啵」地彈回來
  let flashT = -10;
  let kickT = -10;              // 爆的瞬間整個畫面震一下
  const ARM_TIME = 0.33;        // 從觸發到真正炸開：預兆 0.22 秒 + 屏息 0.11 秒（和震動的 BOOM 同步）
  let armT = -10, armPower = 1; // popPhase 3 = 準備爆（預兆、屏息）
  const waves = [];             // 衝擊波光環
  const drops = [];             // 破掉時噴出的水珠
  const shards = [];            // 破掉時飛出去的泡泡膜碎片
  // 長按震動與蓄力
  const HOLD_POP = 5.0;         // 長按幾秒會爆
  let holdCharge = 0;           // 0..1
  let nextBuzz = 0;
  let lastSeg = 0;
  // 長按分四段：輕慢 → 輕快 → 中 → 中快 [震動等級, 間隔秒]；最重的只留給爆破那一下
  const HOLD_SEGMENTS = [['h1', 0.22], ['h1', 0.15], ['h2', 0.13], ['h2', 0.085]];

  // ---------- 專注（lock-in）----------
  // 主程序告訴我們這段專注從幾點到幾點，進度自己算。專注時小球呼吸放慢、光暈收緊、
  // 外圈多一環點陣進度環（點陣球的語彙來自 thinking-orbs：Thinking / Searching / Solving）。
  // 玩具互動（點、按、甩、拖）在任何狀態都照常，專注只是改變小球的「情緒」。
  const RING_DOTS = 60;          // 進度環的點數（每點 = 1/60 段）
  const fo = { phase: 'idle', startedAt: 0, endsAt: 0, total: 0, remaining: 0, drift: false };
  let calm = 0;                  // 0..1：專注的平靜程度（專注中慢慢升到 1）
  let dim = 0;                   // 0..1：分心時變暗、變灰
  let ringA = 0;                 // 0..1：進度環的可見度
  let restA = 0;                 // 0..1：休息中的淡色呼吸
  let doneT = -100;              // 專注完成的時間（結束儀式：進度環收攏、金光一閃、再爆）
  let pauseBlink = 0;

  function applyFocus(f) {
    if (!f) { Object.assign(fo, { phase: 'idle', startedAt: 0, endsAt: 0, total: 0, remaining: 0, drift: false }); return; }
    Object.assign(fo, {
      phase: f.phase || 'idle', startedAt: f.startedAt || 0, endsAt: f.endsAt || 0,
      total: f.total || 0, remaining: f.remaining || 0, drift: !!f.drift,
    });
  }

  // 0..1 的進度（暫停時凍結）
  function focusProgress() {
    if (!fo.total) return 0;
    if (fo.phase === 'paused') return clamp(1 - fo.remaining / fo.total, 0, 1);
    return clamp((Date.now() - fo.startedAt) / fo.total, 0, 1);
  }

  function onEvent(ev) {
    if (!ev) return;
    if (ev.name === 'focus-done') {
      doneT = t;
      // 結束儀式：先讓點陣環「解出來」，1.1 秒後泡泡爆開、換新顏色（等於自己獎勵自己）
      setTimeout(() => { if (popPhase === 0) triggerPop(1); }, 1100);
    } else if (ev.name === 'break-done') {
      pulses.push({ t0: t, x: 0, y: 0, s: 0.6 });
      energy = Math.max(energy, 0.6);
    }
  }

  function stepFocus(dt) {
    const focusing = fo.phase === 'focus' || fo.phase === 'paused';
    calm += ((focusing ? 1 : 0) - calm) * damp(focusing ? 0.35 : 1.2, dt);   // 慢慢靜下來，結束時比較快回來
    dim += ((focusing && fo.drift ? 1 : 0) - dim) * damp(1.6, dt);
    ringA += ((focusing || fo.phase === 'break' ? 1 : 0) - ringA) * damp(2.2, dt);
    restA += ((fo.phase === 'break' ? 1 : 0) - restA) * damp(1.2, dt);
    pauseBlink = fo.phase === 'paused' ? 0.5 + 0.5 * Math.sin(t * 2.4) : 0;
  }

  // 點陣進度環：畫在光暈上、球體外。走過的點亮，領頭的點像掃描線一樣閃；休息時整圈淡淡呼吸。
  function drawFocusRing(c, glow) {
    if (ringA < 0.01) return;
    const prog = focusProgress();
    const done = t - doneT;                                       // 結束儀式進行到哪
    const solving = done >= 0 && done < 1.2 ? done / 1.2 : -1;
    const rr = R * (1.12 + 0.02 * Math.sin(t * 0.6) + 0.06 * restA + (solving >= 0 ? -0.08 * smooth(0, 1, solving) : 0));
    const ink = mixc(glow, WHITE, 0.72);
    const dr = 1.25 * U;
    c.globalCompositeOperation = 'lighter';
    for (let i = 0; i < RING_DOTS; i++) {
      const q = i / RING_DOTS;
      const a0 = -Math.PI / 2 + q * TAU;                           // 從 12 點鐘開始順時針
      // 每個點有一點點 z 深度感：前面大、後面小（像在看一顆斜斜的點陣球的赤道）
      const depth = 0.5 + 0.5 * Math.sin(a0 + t * 0.12);
      let alpha, rad = dr * (0.75 + 0.45 * depth);
      if (fo.phase === 'break') {
        alpha = (0.14 + 0.1 * Math.sin(t * 1.1 + q * TAU * 2)) * restA;
      } else if (solving >= 0) {
        // 解出來：全圈依序點亮，再一起亮到最白
        const wave = smooth(q - 0.08, q + 0.02, solving * 1.1);
        alpha = 0.18 + 0.6 * wave + 0.3 * smooth(0.8, 1, solving);
        rad *= 1 + 0.5 * wave;
      } else {
        const lit = q < prog ? 1 : 0;
        const lead = Math.exp(-(((q - prog) * RING_DOTS) ** 2) / 2.5);   // 領頭點附近的光
        const tw = 0.85 + 0.15 * Math.sin(t * 1.7 + i * 0.9);
        alpha = lit ? (0.62 * tw) : 0.13;
        alpha += 0.6 * lead * (0.6 + 0.4 * Math.sin(t * 5));
        if (fo.phase === 'paused') alpha *= 0.55 + 0.45 * pauseBlink;
        rad *= 1 + 0.6 * lead;
      }
      alpha *= ringA * (1 - 0.55 * dim);
      if (alpha < 0.01) continue;
      const x = Math.cos(a0) * rr, y = Math.sin(a0) * rr;
      c.fillStyle = rgba(ink, Math.min(1, alpha * 0.25));
      c.beginPath(); c.arc(x, y, rad * 2.6, 0, TAU); c.fill();
      c.fillStyle = rgba(ink, Math.min(1, alpha));
      c.beginPath(); c.arc(x, y, rad, 0, TAU); c.fill();
    }
    // 結束儀式的金光：一圈暖光從環往外散
    if (solving >= 0) {
      const e = 1 - Math.pow(1 - solving, 2);
      const r0 = rr * (1 + 0.5 * e), w = R * 0.25;
      const g = c.createRadialGradient(0, 0, Math.max(0, r0 - w), 0, 0, r0 + w);
      g.addColorStop(0, rgba(ink, 0));
      g.addColorStop(0.5, rgba(ink, 0.35 * (1 - solving)));
      g.addColorStop(1, rgba(ink, 0));
      c.fillStyle = g;
      c.fillRect(-(r0 + w), -(r0 + w), (r0 + w) * 2, (r0 + w) * 2);
    }
    c.globalCompositeOperation = 'source-over';
  }

  // ---------- 聽周圍的聲音（只在本機算音量，不錄音、不存檔、不上傳） ----------
  // 音量 → 亮度、光暈、光絲速度、外形顫動；頻段 → 6 個色塊；音節開頭 → 從邊緣送出一圈聲波
  // 會自動適應環境：背景噪音（冷氣、風扇）當基準，說話聲比它大多少才算數
  const SENS_MARGIN = { L: 9, M: 5, H: 2 };          // 靈敏度：要比背景大幾 dB 才開始反應
  const BAND_EDGES = [80, 200, 400, 800, 1600, 3200, 6400]; // 6 個頻段（Hz），對應 6 個色塊
  let sensitivity = 'M';
  let wantListen = false;
  const aud = {
    on: false, starting: false, stream: null, ctx: null, an: null, td: null, fd: null,
    floor: null, peak: -35, level: 0, slow: 0, lastRing: -10, startT: 0, denied: false,
    hist: [],                                         // 最近 3 秒的音量（找背景基準用）
    bands: [0, 0, 0, 0, 0, 0], bandFloor: [0, 0, 0, 0, 0, 0],
  };
  window.__aud = aud; // 測試用
  const soundWaves = [];

  function setListening(on) {
    if (on && !wantListen) aud.denied = false; // 從選單重新打開 → 再試一次權限
    wantListen = on;
    if (on) startMic(); else stopMic();
  }

  async function startMic() {
    if (aud.on || aud.starting || aud.denied) return; // 被拒絕過就不自動重試（避免每次同步設定都重問）
    aud.starting = true;
    try {
      if (api.requestMic) {
        const r = await api.requestMic();
        if (!r || !r.granted) { aud.denied = true; rlog('沒有麥克風權限：' + (r && r.status)); return; }
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        video: false,
      });
      if (!wantListen) { stream.getTracks().forEach((tr) => tr.stop()); return; } // 等權限時被關掉了
      const ac = new AudioContext();
      const an = ac.createAnalyser();
      an.fftSize = 2048;
      an.smoothingTimeConstant = 0.6;
      an.minDecibels = -90;
      an.maxDecibels = -20;
      ac.createMediaStreamSource(stream).connect(an); // 只接到分析器，不會從喇叭放出來
      if (ac.state === 'suspended') ac.resume().catch(() => {});
      Object.assign(aud, {
        on: true, stream, ctx: ac, an,
        td: new Float32Array(an.fftSize), fd: new Uint8Array(an.frequencyBinCount),
        floor: null, peak: -35, hist: [], startT: t,
      });
      const tr = stream.getAudioTracks()[0];
      rlog('開始聽周圍的聲音：' + (tr ? tr.label : '') + '，取樣率 ' + ac.sampleRate);
    } catch (e) {
      aud.denied = true;
      rlog('麥克風無法啟動：' + e.name + ' ' + e.message);
    } finally {
      aud.starting = false;
    }
  }

  function stopMic() {
    if (aud.stream) aud.stream.getTracks().forEach((tr) => tr.stop());
    if (aud.ctx) aud.ctx.close().catch(() => {});
    if (aud.on) rlog('停止聽聲音');
    Object.assign(aud, { on: false, stream: null, ctx: null, an: null });
  }

  function stepAudio(dt) {
    if (!aud.on || !aud.an) {
      aud.level += (0 - aud.level) * damp(3, dt);
      aud.slow += (0 - aud.slow) * damp(3, dt);
      for (let i = 0; i < 6; i++) aud.bands[i] += (0 - aud.bands[i]) * damp(3, dt);
      return;
    }
    aud.an.getFloatTimeDomainData(aud.td);
    let sum = 0;
    for (let i = 0; i < aud.td.length; i++) sum += aud.td[i] * aud.td[i];
    const db = 20 * Math.log10(Math.sqrt(sum / aud.td.length) + 1e-9);
    // 純數位靜音、麥克風剛打開的 0.3 秒（常有異常值）都不算
    if (db < -100 || t - aud.startT < 0.3) return;
    // 背景基準 = 最近 3 秒音量的第 10 百分位（說話時字和字之間的空隙會落回背景；單一異常值拉不動它）
    aud.hist.push([t, db]);
    while (aud.hist.length && t - aud.hist[0][0] > 3) aud.hist.shift();
    const sorted = aud.hist.map((h) => h[1]).sort((a, b) => a - b);
    const quiet = sorted[Math.floor(sorted.length * 0.1)];
    if (aud.floor === null) aud.floor = quiet;
    aud.floor += (quiet - aud.floor) * damp(quiet < aud.floor ? 4 : 1.2, dt);
    // peak 很快往上、慢慢回落 → 跟著最近說話的音量
    aud.peak += (db - aud.peak) * damp(db > aud.peak ? 20 : 0.15, dt);
    aud.peak = Math.max(aud.peak, aud.floor + 18);
    const m = SENS_MARGIN[sensitivity] || 5;
    const warm = smooth(0.6, 1.2, t - aud.startT); // 剛開始的 1 秒先校準背景，不反應
    const raw = warm * clamp((db - aud.floor - m) / (aud.peak - aud.floor - m), 0, 1);
    aud.level += (raw - aud.level) * damp(raw > aud.level ? 18 : 3.5, dt);
    aud.slow += (aud.level - aud.slow) * damp(1.5, dt);
    // 音節開頭（突然變大聲）→ 從球的邊緣送出一圈聲波
    if (aud.level - aud.slow > 0.22 && t - aud.lastRing > 0.22 && popPhase !== 1) {
      soundWaves.push({ t0: t, s: Math.min(1, 0.4 + aud.level) });
      aud.lastRing = t;
    }
    // 頻段 → 6 個色塊（各自也扣掉背景）
    aud.an.getByteFrequencyData(aud.fd);
    const binHz = aud.ctx.sampleRate / aud.an.fftSize;
    for (let i = 0; i < 6; i++) {
      const a = Math.max(1, Math.floor(BAND_EDGES[i] / binHz));
      const b = Math.min(aud.fd.length, Math.max(a + 1, Math.floor(BAND_EDGES[i + 1] / binHz)));
      let s = 0;
      for (let k = a; k < b; k++) s += aud.fd[k];
      const v = s / ((b - a) * 255);
      aud.bandFloor[i] += (v - aud.bandFloor[i]) * damp(v < aud.bandFloor[i] ? 2 : 0.1, dt);
      const bv = clamp((v - aud.bandFloor[i] - 0.03) / 0.25, 0, 1);
      aud.bands[i] += (bv - aud.bands[i]) * damp(bv > aud.bands[i] ? 14 : 3, dt);
    }
  }

  // ---------- 光絲（《光與壑》的 flow field，改成細、透明、會淡入淡出的光） ----------
  const particles = [];

  function spawn(p, stagger) {
    const a = Math.random() * TAU, r = Math.sqrt(Math.random()) * R * 0.9;
    p.x = p.px = Math.cos(a) * r;
    p.y = p.py = Math.sin(a) * r;
    p.vx = p.vy = 0;
    p.life = 160 + Math.random() * 240;            // 幀
    p.age = stagger ? Math.random() * p.life : 0;
    p.w = (0.3 + Math.pow(Math.random(), 3) * 1.3) * U;
    p.a = 0.06 + Math.random() * 0.1;
    p.sp = (0.45 + Math.random() * 0.55) * U;
    p.ci = (Math.random() * 6) | 0;
    p.ph = Math.random() * TAU;                    // 閃爍相位
    p.tf = 0.5 + Math.random() * 1.6;              // 閃爍頻率
    return p;
  }

  function initParticles() {
    particles.length = 0;
    for (let i = 0; i < N_PARTICLES; i++) particles.push(spawn({}, true));
    tctx.setTransform(1, 0, 0, 1, 0, 0);
    tctx.clearRect(0, 0, trail.width, trail.height);
  }

  // 先讓光絲跑一段，一出現就有完整的紋理（不會只剩色塊、看起來很飽和）
  function prewarm(steps) {
    for (let i = 0; i < steps; i++) stepParticles(1 / 60, 1);
  }

  // ---------- 光點：細小、會閃爍的光，跟著流場慢慢飄 ----------
  const sparks = [];

  function spawnSpark(sp, stagger) {
    const a = Math.random() * TAU, r = Math.sqrt(Math.random()) * R * 0.85;
    sp.x = Math.cos(a) * r;
    sp.y = Math.sin(a) * r;
    sp.life = 2 + Math.random() * 4;                       // 秒
    sp.age = stagger ? Math.random() * sp.life : 0;
    sp.r = (0.35 + Math.pow(Math.random(), 2.5) * 1.3) * U;
    sp.sp = (8 + Math.random() * 14) * U;                  // px/s
    sp.ci = (Math.random() * 6) | 0;
    sp.ph = Math.random() * TAU;
    sp.tf = 1.5 + Math.random() * 3;
    return sp;
  }

  function initSparks() {
    sparks.length = 0;
    for (let i = 0; i < N_SPARKS; i++) sparks.push(spawnSpark({}, true));
  }

  function stepSparks(dt) {
    const z = t * 0.05 + 7.3;
    const hov = hover > 0.05 && !(down && down.dragging);
    for (const sp of sparks) {
      flowAt(sp.x, sp.y, z);
      const r = Math.hypot(sp.x, sp.y) || 1;
      const k = 1 + energy + aud.level;
      let vx = fv[0] * sp.sp * k - (sp.y / R) * 6 * U;
      let vy = fv[1] * sp.sp * k + (sp.x / R) * 6 * U;
      if (r > R * 0.85) { vx -= (sp.x / r) * 20 * U; vy -= (sp.y / r) * 20 * U; }
      if (hov) {                                         // 游標滑過會被帶走
        const d = Math.hypot(sp.x - mx, sp.y - my);
        if (d < R * 0.6) { const f = (1 - d / (R * 0.6)) ** 2 * hover; vx += mvx * f * 0.6; vy += mvy * f * 0.6; }
      }
      sp.x += vx * dt;
      sp.y += vy * dt;
      sp.age += dt;
      if (sp.age > sp.life || r > R * 1.1) spawnSpark(sp, false);
    }
  }

  function drawSparks(c) {
    const cols = curV.map((col) => mixc(col, WHITE, 0.78));
    c.globalCompositeOperation = 'lighter';
    for (const sp of sparks) {
      const q = sp.age / sp.life;
      const fl = Math.sin(Math.PI * q);
      const tw = 0.5 + 0.5 * Math.sin(t * sp.tf + sp.ph);
      const edge = 1 - smooth(R * 0.5, R * 0.95, Math.hypot(sp.x, sp.y));
      const a = fl * fl * tw * edge * (0.55 + 0.35 * aud.level + 0.3 * energy);
      if (a < 0.02) continue;
      c.fillStyle = rgba(cols[sp.ci], a * 0.16);
      c.beginPath(); c.arc(sp.x, sp.y, sp.r * 3, 0, TAU); c.fill();
      c.fillStyle = rgba(cols[sp.ci], Math.min(1, a));
      c.beginPath(); c.arc(sp.x, sp.y, sp.r, 0, TAU); c.fill();
    }
  }

  // curl noise：無散度的流場，像液體一樣旋轉，不會擠成一團
  const fv = [0, 0];
  function flowAt(x, y, z) {
    const s = 0.011, e = 0.35;
    const nx = (x / U) * s, ny = (y / U) * s;
    const dx = noise3(nx + e, ny, z) - noise3(nx - e, ny, z);
    const dy = noise3(nx, ny + e, z) - noise3(nx, ny - e, z);
    const m = Math.hypot(dx, dy) || 1;
    fv[0] = dy / m; fv[1] = -dx / m;
  }

  function stepParticles(dt, k) {
    tctx.setTransform(DPR, 0, 0, DPR, (W / 2) * DPR, (H / 2) * DPR);
    tctx.globalCompositeOperation = 'destination-out';
    tctx.fillStyle = `rgba(0,0,0,${1 - Math.pow(1 - FADE, k)})`;
    tctx.fillRect(-W / 2, -H / 2, W, H);
    tctx.globalCompositeOperation = 'lighter';
    tctx.lineCap = 'butt';

    const lineCols = curV.map((c) => mixc(c, WHITE, 0.45));
    const dragging = !!(down && down.dragging);
    const pressing = !!(down && !dragging);
    const hov = hover > 0.05 && !dragging;
    const z = t * 0.05;
    const spin = 0.25 + 0.5 * energy;
    const baseRelax = damp(2.6, dt);
    const stirR = R * 0.6;
    const proxR2 = (R * 0.35) ** 2;
    const vortR = R * 0.5;

    for (const p of particles) {
      flowAt(p.x, p.y, z);
      const r = Math.hypot(p.x, p.y) || 1;
      const ux = p.x / r, uy = p.y / r;
      const sp = p.sp * (1 + energy * 1.2 + ts * 0.8 + aud.level * 0.7);
      let tx = fv[0] * sp - uy * spin * sp * (r / R);
      let ty = fv[1] * sp + ux * spin * sp * (r / R);
      const over = (r - R * 0.8) / (R * 0.2);      // 靠近邊緣時溫柔地往內拉
      if (over > 0) { tx -= ux * over * sp * 1.5; ty -= uy * over * sp * 1.5; }

      let relax = baseRelax;
      let prox = 1;
      if (hov) {
        const dx = p.x - mx, dy = p.y - my, d2 = dx * dx + dy * dy;
        const d = Math.sqrt(d2);
        if (d < stirR) {                            // 游標攪動：附近的光絲被帶著走
          const f = (1 - d / stirR) ** 2 * hover;
          tx += (mvx / 60) * f * 0.85;
          ty += (mvy / 60) * f * 0.85;
          relax += f * 0.12;
        }
        prox += 1.2 * hover * Math.exp(-d2 / proxR2); // 游標附近的光絲變亮
      }
      if (pressing) {                               // 按住：光絲往按壓點旋入
        const dx = qx - p.x, dy = qy - p.y, d = Math.hypot(dx, dy) || 1;
        const f = 1 / (1 + (d / vortR) ** 2);
        tx += ((dx / d) * 1.3 - (dy / d) * 2.2) * sp * f;
        ty += ((dy / d) * 1.3 + (dx / d) * 2.2) * sp * f;
      }

      p.vx += (tx - p.vx) * relax;
      p.vy += (ty - p.vy) * relax;
      p.x += p.vx * k;
      p.y += p.vy * k;
      p.age += k;

      const life = p.age / p.life;
      const rr = Math.hypot(p.x, p.y);
      if (life >= 1 || rr > R * 1.15) { spawn(p, false); continue; }

      const fl = Math.sin(Math.PI * life);                     // 淡入 → 淡出
      const edge = 1 - smooth(R * 0.45, R * 0.95, rr);          // 越靠邊越淡
      const twk = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(t * p.tf + p.ph)); // 若隱若現
      const a = p.a * fl * fl * edge * twk * prox * (1 + 0.5 * energy + 0.6 * ts + 0.6 * aud.level);
      if (a > 0.003) {
        tctx.strokeStyle = rgba(lineCols[p.ci], a);
        tctx.lineWidth = p.w;
        tctx.beginPath();
        tctx.moveTo(p.px, p.py);
        tctx.lineTo(p.x, p.y);
        tctx.stroke();
      }
      p.px = p.x; p.py = p.y;
    }
    tctx.globalCompositeOperation = 'source-over';
  }

  // ---------- 色塊（Siri 球的流動顏色），會被游標推開、往按壓點聚 ----------
  function stepBlobs(dt) {
    const dragging = !!(down && down.dragging);
    const pressing = !!(down && !dragging);
    for (const b of blobs) {
      let fx = -18 * b.ox - 3.2 * b.vx;
      let fy = -18 * b.oy - 3.2 * b.vy;
      if (hoverTarget && !dragging) {
        const d = Math.hypot(b.x - mx, b.y - my);
        const f = Math.max(0, 1 - d / (R * 0.95)) ** 2;
        fx += mvx * f * 2.2;
        fy += mvy * f * 2.2;
      }
      if (pressing) {
        const d = Math.hypot(qx - b.x, qy - b.y);
        const f = 1 / (1 + (d / R) ** 2);
        fx += (qx - b.x) * 4 * f;
        fy += (qy - b.y) * 4 * f;
      }
      b.vx += fx * dt; b.vy += fy * dt;
      b.ox = clamp(b.ox + b.vx * dt, -R * 0.55, R * 0.55);
      b.oy = clamp(b.oy + b.vy * dt, -R * 0.55, R * 0.55);
    }
  }

  // 放開時的光爆：光絲和色塊從按壓點散開
  function burst(x, y, s) {
    for (const p of particles) {
      const dx = p.x - x, dy = p.y - y, d = Math.hypot(dx, dy) || 1;
      const f = Math.exp(-d / (R * 0.55)) * s;
      p.vx += (dx / d) * 3.2 * U * f;
      p.vy += (dy / d) * 3.2 * U * f;
    }
    for (const b of blobs) {
      const dx = b.x - x, dy = b.y - y, d = Math.hypot(dx, dy) || 1;
      const f = Math.exp(-d / R) * s;
      b.vx += (dx / d) * 200 * U * f;
      b.vy += (dy / d) * 200 * U * f;
    }
  }

  // 泡泡破掉：本體瞬間消失，噴出水珠和膜的碎片、一陣光，停一下再重新長出來
  function pop(power = 1) {
    const rad = R * (1 + 0.14 * ts);
    const nDrops = Math.round(64 * power);
    const nShards = Math.round(16 * power);
    for (let i = 0; i < nDrops; i++) {
      const a = Math.random() * TAU;
      const r0 = rad * (0.72 + Math.random() * 0.28);
      const sp = (140 + Math.random() * 300) * U * (0.8 + 0.2 * power);
      drops.push({
        x: jx + Math.cos(a) * r0,
        y: jy + Math.sin(a) * r0,
        vx: Math.cos(a) * sp + (Math.random() - 0.5) * 60 * U,
        vy: Math.sin(a) * sp + (Math.random() - 0.5) * 60 * U,
        r: (0.7 + Math.pow(Math.random(), 2) * 2.4) * U,
        col: mixc(curV[(Math.random() * 6) | 0], WHITE, 0.45),
        t0: t,
        life: 0.55 + Math.random() * 0.7,
      });
    }
    for (let i = 0; i < nShards; i++) {
      shards.push({
        a: (i / nShards) * TAU + (Math.random() - 0.5) * 0.3,
        span: 0.18 + Math.random() * 0.32,
        r: rad * 0.95,
        vr: (160 + Math.random() * 220) * U,
        spin: (Math.random() - 0.5) * 3,
        hue: Math.random() * 360,
        cx: jx, cy: jy,
        t0: t,
        life: 0.35 + Math.random() * 0.3,
      });
    }
    flashT = t;
    kickT = t;
    waves.push({ t0: t, s: 1 }, { t0: t + 0.27, s: 0.6 }); // 兩圈衝擊波，對應兩段衝擊波震動
    pulses.push({ t0: t, x: 0, y: 0, s: 0.7 });
    popPhase = 1; popT = t;
    bub = 0; bubv = 0;
    tension = 0; ts = 0; tsv = 0;
    down = null; sq = 0; sqv = 0;
    hoverTarget = false;
    setIgnore(true);
    holdCharge = 0;
    window.__lastPopAt = performance.now(); // 測試用：記下真正炸開的時間
  }

  // 觸發爆破：先預兆、屏息，ARM_TIME 秒後才真的炸開；震動序列同時開始，BOOM 剛好落在炸開那一刻
  function triggerPop(power) {
    if (popPhase !== 0) return;
    popPhase = 3;
    armT = t;
    armPower = power;
    down = null;
    haptic(power > 1.2 ? 'bigpop' : 'pop');
    window.__lastArmAt = performance.now(); // 測試用：記下觸發的時間
  }

  // ---------- 甩動：拖著小球快速來回甩，跟連點一樣累積張力，到極限就爆 ----------
  // 每次「方向反轉」結算前一段：夠長、夠快才算一下（慢慢拖去別的地方不會算）
  const SHAKE_MIN_SPEED = 600;   // px/s
  const shake = { sx: 0, sy: 0, len: 0, t0: 0 };

  function shakeStep(dx, dy) {
    const d = Math.hypot(dx, dy);
    if (d < 1 || popPhase !== 0) return;
    const now = performance.now() / 1000;
    const sl = Math.hypot(shake.sx, shake.sy);
    if (sl > 0 && (dx * shake.sx + dy * shake.sy) / (d * sl) < -0.35) {
      const speed = shake.len / Math.max(0.03, now - shake.t0);
      if (shake.len > R * 0.35 && speed > SHAKE_MIN_SPEED) {
        // 甩越快累積越多；越接近極限加得越少
        tension = Math.min(1, tension + clamp(speed / 14000, 0.05, 0.12) * (1 - 0.5 * tension));
        lastTapT = t;
        tsv += 1.6;
        if (tension >= 0.999) { shake.len = 0; triggerPop(1.5); return; }
        if (tension > 0.45) haptic(tension > 0.75 ? 'h2' : 'h1');
      }
      shake.sx = 0; shake.sy = 0; shake.len = 0; shake.t0 = now;
    }
    if (shake.len === 0) shake.t0 = now;
    shake.sx += dx; shake.sy += dy; shake.len += d;
  }

  // ---------- 滑鼠 ----------
  const setIgnore = (v) => { if (ignoring !== v) { ignoring = v; api.setIgnore(v); } };
  const insideOrb = (cx, cy) =>
    popPhase !== 1 && Math.hypot(cx - W / 2 - jx, cy - H / 2 - jy) <= R * Math.max(0.2, Math.min(bub, 1));

  window.addEventListener('pointermove', (e) => {
    const x = e.clientX - W / 2, y = e.clientY - H / 2;
    if (down) {
      if (!down.dragging && Math.hypot(e.screenX - down.sx, e.screenY - down.sy) > 5) {
        down.dragging = true;
        api.dragStart();
      }
      if (down.dragging) {
        api.dragMove(e.screenX - down.sx, e.screenY - down.sy);
        // 視窗被拖走，球身慢半拍跟上 → 果凍般的拖曳感
        jvx -= (e.screenX - down.lx) * 7;
        jvy -= (e.screenY - down.ly) * 7;
      } else {
        mx = x; my = y;
      }
      const ddx = e.screenX - down.lx, ddy = e.screenY - down.ly;
      down.lx = e.screenX; down.ly = e.screenY;
      if (down.dragging) shakeStep(ddx, ddy); // 可能觸發爆破（會清掉 down），所以放最後
      return;
    }
    const now = performance.now();
    if (lastMoveT && now - lastMoveT < 120) {
      const dtm = Math.max(8, now - lastMoveT) / 1000;
      mvx += (clamp((x - mx) / dtm, -1500, 1500) - mvx) * 0.5;
      mvy += (clamp((y - my) / dtm, -1500, 1500) - mvy) * 0.5;
    }
    lastMoveT = now;
    mx = x; my = y;
    const inside = insideOrb(e.clientX, e.clientY);
    hoverTarget = inside;
    setIgnore(!inside); // 小球以外的透明區域讓滑鼠穿透
  });

  document.addEventListener('mouseleave', () => {
    if (down) return;
    hoverTarget = false;
    setIgnore(true);
  });

  window.addEventListener('pointerdown', (e) => {
    if (aud.ctx && aud.ctx.state === 'suspended') aud.ctx.resume().catch(() => {});
    if (e.button !== 0 || popPhase === 1 || popPhase === 3) return;
    cvs.setPointerCapture(e.pointerId);
    down = { sx: e.screenX, sy: e.screenY, lx: e.screenX, ly: e.screenY, t: performance.now(), dragging: false };
    shake.sx = 0; shake.sy = 0; shake.len = 0;
    qx = e.clientX - W / 2 - jx;
    qy = e.clientY - H / 2 - jy;
    pressAngle = Math.atan2(qy, qx);
    setIgnore(false);

    // 連點累積張力；到了極限，這一下就把泡泡戳破（按下的瞬間手指還在觸控板上，震動一定感覺得到）
    if (popPhase === 0) {
      tension = Math.min(1, tension + TAP_TENSION * (1 - 0.5 * tension)); // 越接近極限加得越少
      lastTapT = t;
      tsv += 2.2;
      if (tension >= 0.999) { triggerPop(1); return; }
      if (tension > 0.45) haptic(tension > 0.75 ? 'h2' : 'h1'); // 越來越緊繃：每點一下都有觸感提醒，越後面越重
    }
  });

  window.addEventListener('pointerup', (e) => {
    if (!down) return;
    const held = performance.now() - down.t;
    if (!down.dragging) {
      const s = 0.45 + Math.min(1, held / 900) * 0.8;  // 按越久，放開的光越大
      burst(qx, qy, s);
      pulses.push({ t0: t, x: qx, y: qy, s });
      energy = Math.max(energy, 0.9);
      if (held < 350) api.nextPalette();                // 短按 = 換顏色；長按 = 純解壓
      else if (held > 600) haptic('thunk');             // 長按放開：沉穩的一下收尾
    }
    down = null;
    hoverTarget = insideOrb(e.clientX, e.clientY);
    setIgnore(!hoverTarget);
  });

  window.addEventListener('contextmenu', (e) => { e.preventDefault(); api.contextMenu(); });

  // ---------- 繪製 ----------
  const MASK_STOPS = [[0, 1], [0.5, 1], [0.66, 0.93], [0.78, 0.74], [0.87, 0.48], [0.94, 0.22], [1, 0]];

  function spot(c, x, y, r, col, a) {
    const g = c.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, rgba(col, a));
    g.addColorStop(0.45, rgba(col, a * 0.45));
    g.addColorStop(1, rgba(col, 0));
    c.fillStyle = g;
    c.fillRect(x - r, y - r, r * 2, r * 2);
  }

  function halo(c, x, y, r, col, a) {
    const g = c.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, rgba(col, a));
    g.addColorStop(0.35, rgba(col, a * 0.8));
    g.addColorStop(0.55, rgba(col, a * 0.42));
    g.addColorStop(0.75, rgba(col, a * 0.14));
    g.addColorStop(1, rgba(col, 0));
    c.fillStyle = g;
    c.fillRect(x - r, y - r, r * 2, r * 2);
  }

  // 呼吸、擠壓、果凍拉伸
  function deform(c, s, ox, oy) {
    c.translate(jx + ox, jy + oy);
    c.scale(s, s);
    if (Math.abs(sq) > 1e-4) {
      c.rotate(pressAngle); c.scale(1 - sq, 1 + sq * 0.8); c.rotate(-pressAngle);
    }
    const st = Math.min(0.3, (Math.hypot(jx, jy) / R) * 1.0);
    if (st > 1e-4) {
      const a = Math.atan2(jy, jx);
      c.rotate(a); c.scale(1 + st, 1 - st * 0.5); c.rotate(-a);
    }
    const vf = 0.035 * aud.level * Math.sin(t * 9);  // 跟著說話聲輕輕顫動
    if (Math.abs(vf) > 1e-4) {
      const a2 = t * 0.7;
      c.rotate(a2); c.scale(1 + vf, 1 - vf); c.rotate(-a2);
    }
  }

  // 泡泡膜的虹彩邊：張力越大越明顯，像肥皂泡快破之前
  function drawFilm() {
    const f = fctx;
    f.setTransform(1, 0, 0, 1, 0, 0);
    f.globalCompositeOperation = 'source-over';
    f.clearRect(0, 0, film.width, film.height);
    f.setTransform(DPR, 0, 0, DPR, (W / 2) * DPR, (H / 2) * DPR);
    const cg = f.createConicGradient(t * 0.8, 0, 0);
    // 同色系的珍珠光：在主色調前後擺盪，不是整圈彩虹
    const OFF = [-0.1, -0.03, 0.06, 0.11, 0.03, -0.06, -0.1];
    for (let i = 0; i < OFF.length; i++) {
      const h = ((hueNow + OFF[i] * (0.8 + 0.2 * Math.sin(t * 0.9 + i))) % 1 + 1) % 1;
      cg.addColorStop(i / (OFF.length - 1), `hsl(${(h * 360).toFixed(1)}, 60%, ${i % 2 ? 86 : 78}%)`);
    }
    f.fillStyle = cg;
    f.fillRect(-W / 2, -H / 2, W, H);
    f.globalCompositeOperation = 'destination-in';
    const band = f.createRadialGradient(0, 0, 0, 0, 0, R);
    band.addColorStop(0, 'rgba(0,0,0,0)');
    band.addColorStop(0.55, 'rgba(0,0,0,0)');
    band.addColorStop(0.8, 'rgba(0,0,0,0.9)');
    band.addColorStop(0.92, 'rgba(0,0,0,0.75)');
    band.addColorStop(1, 'rgba(0,0,0,0)');
    f.fillStyle = band;
    f.fillRect(-W / 2, -H / 2, W, H);
    f.globalCompositeOperation = 'source-over';
  }

  const GRAY = [118, 120, 134];
  function render() {
    let glow = glowColor();
    if (dim > 0.01) glow = mixc(glow, GRAY, 0.5 * dim);          // 分心：顏色退掉一半
    // 呼吸：專注時放慢、變淺（breath 的節奏在 frame() 裡隨 calm 調整）
    const sBase = 1 + (0.022 - 0.008 * calm) * Math.sin(breath) + 0.012 * energy * Math.sin(t * 4.6) + 0.03 * hover + 0.02 * energy + 0.045 * aud.level;
    // 準備爆：預兆（劇烈顫抖、鼓起來）→ 屏息（停住、往內縮一點，像吸一口氣）
    let armSwell = 1, armShake = 0;
    if (popPhase === 3) {
      const a = t - armT, WIND = 0.22;
      if (a < WIND) {
        const w = a / WIND;
        armSwell = 1 + 0.09 * w;
        armShake = R * 0.04 * w;
      } else {
        armSwell = 1.09 - 0.08 * smooth(0, 1, (a - WIND) / (ARM_TIME - WIND));
      }
    }
    const sBody = sBase * (1 + 0.14 * ts) * bub * armSwell; // 張力越大，泡泡越鼓
    const shiver = R * 0.014 * ts * ts;                     // 快破時細細地顫抖
    const shx = Math.sin(t * 37) * shiver + (Math.random() - 0.5) * 2 * armShake;
    const shy = Math.cos(t * 43) * shiver + (Math.random() - 0.5) * 2 * armShake;
    // 爆的瞬間：整個畫面震一下
    const kq = t - kickT;
    const kickAmp = kq >= 0 && kq < 0.35 ? R * 0.06 * Math.exp(-kq * 12) : 0;
    const kx = Math.sin(kq * 90) * kickAmp, ky = Math.cos(kq * 77) * kickAmp;
    const big = R * 1.6;
    const showBody = bub > 0.01;

    if (showBody) {
      // 1) 光絲的柔光（半解析度 + 模糊）
      gctx.setTransform(1, 0, 0, 1, 0, 0);
      gctx.clearRect(0, 0, bloom.width, bloom.height);
      gctx.filter = `blur(${Math.max(1, 2.2 * U * DPR * 0.5).toFixed(2)}px)`;
      gctx.drawImage(trail, 0, 0, bloom.width, bloom.height);
      gctx.filter = 'none';

      // 2) 球體
      const b = bctx;
      b.setTransform(1, 0, 0, 1, 0, 0);
      b.globalCompositeOperation = 'source-over';
      b.globalAlpha = 1;
      b.clearRect(0, 0, body.width, body.height);
      b.setTransform(DPR, 0, 0, DPR, (W / 2) * DPR, (H / 2) * DPR);
      deform(b, sBody, shx, shy);

      const thin = (1 - 0.35 * ts) * (1 - 0.3 * fresh) * (1 - 0.22 * dim); // 快破時、剛重生時：膜比較薄、比較透；分心時也淡一點
      const base = b.createRadialGradient(-R * 0.15, -R * 0.25, 0, 0, 0, R);
      base.addColorStop(0, rgba(mixc(glow, WHITE, 0.35), 0.86 * thin));
      base.addColorStop(0.6, rgba(mixc(glow, INK, 0.24), 0.8 * thin));
      base.addColorStop(1, rgba(mixc(glow, INK, 0.42), 0.74 * thin));
      b.fillStyle = base;
      b.fillRect(-big, -big, big * 2, big * 2);

      b.globalCompositeOperation = 'screen';
      for (let i = 0; i < 6; i++) {
        const o = blobs[i];
        o.x = noise3(i * 3.7, 0.5, tw) * R * 1.5 + o.ox;
        o.y = noise3(i * 3.7, 9.1, tw) * R * 1.5 + o.oy;
        const br = R * (0.7 + 0.3 * noise3(i * 3.7, 17.3, tw * 1.3)) * (1 + 0.32 * aud.bands[i]); // 對應頻段越響越大
        const g = b.createRadialGradient(o.x, o.y, 0, o.x, o.y, br);
        let bc = fresh > 0.01 ? mixc(curV[i], WHITE, 0.35 * fresh) : curV[i]; // 新泡泡：同色系的淡色
        if (dim > 0.01) bc = mixc(bc, GRAY, 0.45 * dim);                     // 分心：色塊退成灰
        const ba = 1 - 0.25 * fresh;
        g.addColorStop(0, rgba(bc, (0.72 + 0.22 * aud.bands[i]) * ba));
        g.addColorStop(0.4, rgba(bc, 0.4 * ba));
        g.addColorStop(0.75, rgba(bc, 0.1 * ba));
        g.addColorStop(1, rgba(bc, 0));
        b.fillStyle = g;
        b.fillRect(o.x - br, o.y - br, br * 2, br * 2);
      }
      if (hover > 0.01) spot(b, (mx - jx) / sBody, (my - jy) / sBody, R * 0.5, mixc(glow, WHITE, 0.6), 0.22 * hover);
      for (const p of pulses) {
        const q = (t - p.t0) / 1.3, e = 1 - Math.pow(1 - q, 3);
        spot(b, p.x, p.y, R * (0.2 + 1.2 * e), mixc(glow, WHITE, 0.35), 0.38 * Math.pow(1 - q, 1.5) * p.s);
      }
      spot(b, -R * 0.3, -R * 0.42, R * 0.7, WHITE, 0.2);

      b.globalCompositeOperation = 'lighter';
      b.globalAlpha = 0.95;
      b.drawImage(bloom, -W / 2, -H / 2, W, H);
      b.globalAlpha = 0.85;
      b.drawImage(trail, -W / 2, -H / 2, W, H);
      b.globalAlpha = 1;
      drawSparks(b);

      const filmA = Math.max(0.75 * ts, 0.5 * fresh);
      if (filmA > 0.015) {
        drawFilm();
        b.globalCompositeOperation = 'screen';
        b.globalAlpha = Math.min(1, filmA);
        b.drawImage(film, -W / 2, -H / 2, W, H);
        b.globalAlpha = 1;
      }

      // 柔邊遮罩：邊緣慢慢化進光暈，沒有明確的邊界
      b.globalCompositeOperation = 'destination-in';
      const m = b.createRadialGradient(0, 0, 0, 0, 0, R);
      for (const [o, a] of MASK_STOPS) m.addColorStop(o, `rgba(0,0,0,${a})`);
      b.fillStyle = m;
      b.fillRect(-big * 2, -big * 2, big * 4, big * 4);
      b.globalCompositeOperation = 'source-over';
    }

    // 3) 合成：外圍光暈 → 光波 → 球體 → 破掉的光、碎片、水珠
    const at = (ox, oy) => ctx.setTransform(DPR, 0, 0, DPR, (W / 2 + ox + kx) * DPR, (H / 2 + oy + ky) * DPR);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cvs.width, cvs.height);

    if (showBody) {
      at(jx, jy);
      const hs = sBase * Math.min(bub, 1.15);
      ctx.scale(hs, hs);
      const ga = (0.28 + 0.18 * energy + 0.08 * hover + 0.15 * ts + 0.22 * aud.level + (popPhase === 3 ? 0.25 : 0)) * Math.min(1, bub) * (1 - 0.4 * dim);
      halo(ctx, 0, 0, R * (1.62 - 0.16 * calm), glow, ga);   // 專注時光暈收緊一點
      const c2 = mixc(curV[2], curV[4], 0.5 + 0.5 * Math.sin(t * 0.21)); // 緩慢游移的第二層光，帶一點虹彩
      halo(ctx, Math.cos(t * 0.23) * R * 0.16, Math.sin(t * 0.31) * R * 0.16, R * 1.4, c2, ga * 0.55);
    }

    at(jx, jy);
    ctx.scale(sBase, sBase);
    if (showBody) drawFocusRing(ctx, glow);           // 專注進度環（在光暈上、球體下）
    for (const p of pulses) {
      const q = (t - p.t0) / 1.3, e = 1 - Math.pow(1 - q, 3);
      const rr = R * (0.95 + 0.5 * e), w = R * 0.34;
      const g = ctx.createRadialGradient(0, 0, Math.max(0, rr - w), 0, 0, rr + w);
      const col = mixc(glow, WHITE, 0.3);
      g.addColorStop(0, rgba(col, 0));
      g.addColorStop(0.5, rgba(col, 0.16 * Math.pow(1 - q, 2) * p.s));
      g.addColorStop(1, rgba(col, 0));
      ctx.fillStyle = g;
      ctx.fillRect(-(rr + w), -(rr + w), (rr + w) * 2, (rr + w) * 2);
    }
    if (showBody) {                                   // 聲波：每個音節開頭從邊緣擴散出去
      const col = mixc(glow, WHITE, 0.35);
      for (const sw of soundWaves) {
        const q = (t - sw.t0) / 1.0;
        if (q < 0 || q >= 1) continue;
        const e = 1 - Math.pow(1 - q, 2);
        const rr = R * (0.9 + 0.55 * e), w = R * (0.1 + 0.08 * q);
        const g = ctx.createRadialGradient(0, 0, Math.max(0, rr - w), 0, 0, rr + w);
        g.addColorStop(0, rgba(col, 0));
        g.addColorStop(0.5, rgba(col, 0.22 * sw.s * Math.pow(1 - q, 1.6)));
        g.addColorStop(1, rgba(col, 0));
        ctx.fillStyle = g;
        ctx.fillRect(-(rr + w), -(rr + w), (rr + w) * 2, (rr + w) * 2);
      }
    }

    if (showBody) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = Math.min(1, bub * 2);
      ctx.drawImage(body, kx * DPR, ky * DPR);
      ctx.globalAlpha = 1;
    }

    const fq = (t - flashT) / 0.32;
    if (fq < 1 || shards.length || drops.length || waves.length) {
      at(0, 0);
      ctx.globalCompositeOperation = 'lighter';
      if (fq < 1) {
        spot(ctx, jx, jy, R * (0.5 + 1.1 * fq), mixc(glow, WHITE, 0.8), 0.8 * (1 - fq) ** 2); // 爆的強光
        spot(ctx, jx, jy, R * 0.45, WHITE, 0.7 * (1 - fq) ** 3);                              // 白色核心
      }
      for (const wv of waves) {                                                               // 衝擊波光環
        const q = (t - wv.t0) / 0.5;
        if (q < 0 || q >= 1) continue;
        const e = 1 - Math.pow(1 - q, 3);
        const rr = R * (0.85 + 0.85 * e), w = R * (0.06 + 0.12 * q);
        const g = ctx.createRadialGradient(jx, jy, Math.max(0, rr - w), jx, jy, rr + w);
        const col = mixc(glow, WHITE, 0.55);
        g.addColorStop(0, rgba(col, 0));
        g.addColorStop(0.5, rgba(col, 0.55 * wv.s * (1 - q) ** 1.5));
        g.addColorStop(1, rgba(col, 0));
        ctx.fillStyle = g;
        ctx.fillRect(jx - rr - w, jy - rr - w, (rr + w) * 2, (rr + w) * 2);
      }
      ctx.lineCap = 'round';
      for (const sh of shards) {
        const age = t - sh.t0, q = Math.min(1, age / sh.life);
        const r = sh.r + sh.vr * age;
        const a0 = sh.a + sh.spin * age;
        ctx.strokeStyle = `hsla(${(sh.hue + t * 90) % 360}, 90%, 78%, ${(0.75 * (1 - q) ** 1.5).toFixed(3)})`;
        ctx.lineWidth = (1.6 * (1 - q) + 0.3) * U;
        ctx.beginPath();
        ctx.arc(sh.cx, sh.cy, r, a0, a0 + sh.span * (1 - 0.6 * q));
        ctx.stroke();
      }
      for (const d of drops) {
        const q = Math.min(1, (t - d.t0) / d.life);
        const a = 0.9 * (1 - q) ** 1.2;
        spot(ctx, d.x, d.y, d.r * 3.2, d.col, a * 0.35); // 柔光，不要硬邊的圈
        ctx.fillStyle = rgba(d.col, a);
        ctx.beginPath(); ctx.arc(d.x, d.y, Math.max(0.2, d.r * (1 - 0.4 * q)), 0, TAU); ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';
    }
  }

  // ---------- 主迴圈 ----------
  let last = performance.now();
  let breath = 0;               // 呼吸相位（節奏會隨專注改變，所以不用 t）
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const k = dt * 60;
    t += dt;

    const dragging = !!(down && down.dragging);
    const pressing = !!(down && !dragging);

    const eT = pressing || popPhase === 3 ? 1 : hoverTarget ? 0.3 : 0;
    energy += (eT - energy) * damp(eT > energy ? 6 : 1.2, dt);
    hover += ((hoverTarget && !dragging ? 1 : 0) - hover) * damp(7, dt);
    stepAudio(dt);
    stepFocus(dt);
    breath += dt * (1.2 - 0.62 * calm);                                   // 專注時呼吸放慢（約 11 秒一輪）
    tw += dt * (0.13 + 0.6 * energy + 0.35 * aud.level) * (1 - 0.45 * calm); // 色塊流得慢一點
    const mdec = Math.exp(-dt * 5);
    mvx *= mdec; mvy *= mdec;

    // 擠壓：按越久壓越深；放開時欠阻尼回彈
    const held = pressing ? now - down.t : 0;
    // 長按蓄力：0.26 秒後開始累積，HOLD_POP 秒到極限 → 爆破（外觀維持被壓扁＋光絲旋入，蓄力主要靠震動）
    holdCharge = pressing && popPhase === 0 ? clamp((held / 1000 - 0.26) / (HOLD_POP - 0.26), 0, 1) : 0;
    const sqT = pressing ? 0.07 + 0.11 * Math.min(1, held / 700) : 0;
    sqv += (-190 * (sq - sqT) - 9.5 * sqv) * dt;
    sq += sqv * dt;

    // 連點張力：停手 0.8 秒後慢慢鬆回去；畫面上的張力用彈簧追，每點一下會抖
    if (t - lastTapT > 0.8) tension = Math.max(0, tension - 0.25 * dt);
    tsv += (-90 * (ts - tension) - 7 * tsv) * dt;
    ts = clamp(ts + tsv * dt, 0, 1.2);

    // 長按震動：分四段（輕 → 中 → 強 → 強力快打），每升一段來一下最重的連打；按滿就爆破
    if (pressing && popPhase === 0 && held > 260) {
      if (holdCharge >= 1) {
        triggerPop(1.5);
      } else if (t >= nextBuzz) {
        const seg = Math.min(3, Math.floor(holdCharge * 4));
        const [kind, gap] = HOLD_SEGMENTS[seg];
        if (seg > lastSeg) {
          lastSeg = seg;
          haptic('step');
          pulses.push({ t0: t, x: qx, y: qy, s: 0.3 + 0.12 * seg }); // 升段時一圈柔光
        } else {
          haptic(kind);
        }
        nextBuzz = t + gap;
        jvx += (Math.random() - 0.5) * R * (0.4 + 0.35 * seg);
        jvy += (Math.random() - 0.5) * R * (0.4 + 0.35 * seg);
      }
    } else {
      nextBuzz = 0;
      lastSeg = 0;
    }

    // 泡泡：準備爆 → 炸開 → 空 1.2 秒 → 「啵」地重新長出來（換新顏色）
    if (popPhase === 3 && t - armT >= ARM_TIME) pop(armPower);
    if (popPhase === 1 && t - popT > 1.2) {
      popPhase = 2;
      bub = 0.04; bubv = 0;
      initParticles();
      initSparks();
      prewarm(40);
      freshT = t;
      snapNext = true;
      api.nextPalette();
      energy = Math.max(energy, 0.7);
    }
    if (popPhase === 2) {
      bubv += (-120 * (bub - 1) - 9 * bubv) * dt;
      bub += bubv * dt;
      if (t - popT > 3 && Math.abs(bub - 1) < 0.01 && Math.abs(bubv) < 0.05) {
        popPhase = 0; bub = 1; bubv = 0;
      }
    }
    const drag = Math.exp(-dt * 3.2);
    for (let i = drops.length - 1; i >= 0; i--) {
      const d = drops[i];
      if (t - d.t0 > d.life) { drops.splice(i, 1); continue; }
      d.vx *= drag; d.vy *= drag;
      d.vy += 260 * U * dt; // 一點點重力，水珠往下落
      d.x += d.vx * dt; d.y += d.vy * dt;
    }
    for (let i = shards.length - 1; i >= 0; i--) if (t - shards[i].t0 > shards[i].life) shards.splice(i, 1);
    for (let i = waves.length - 1; i >= 0; i--) if (t - waves[i].t0 > 0.55) waves.splice(i, 1);
    for (let i = soundWaves.length - 1; i >= 0; i--) if (t - soundWaves[i].t0 > 1.0) soundWaves.splice(i, 1);

    // 果凍：hover 時往游標靠一點，拖曳時慢半拍，停下來會晃
    let jtx = 0, jty = 0;
    if (hoverTarget && !dragging) {
      jtx = clamp(mx / R, -1, 1) * R * 0.07;
      jty = clamp(my / R, -1, 1) * R * 0.07;
    }
    jvx += (-140 * (jx - jtx) - 8 * jvx) * dt;
    jvy += (-140 * (jy - jty) - 8 * jvy) * dt;
    jx = clamp(jx + jvx * dt, -R * 0.3, R * 0.3);
    jy = clamp(jy + jvy * dt, -R * 0.3, R * 0.3);

    // 顏色平滑過渡（約 2–3 秒）
    const kc = damp(1.25, dt);
    for (let i = 0; i < cur.length; i++) {
      for (let ch = 0; ch < 3; ch++) {
        cur[i][ch] += (tgt[i][ch] - cur[i][ch]) * kc;
        curV[i][ch] += (tgtV[i][ch] - curV[i][ch]) * kc;
      }
    }
    hueNow = (hueNow + hueDiff(hueTgt, hueNow) * kc + 1) % 1;

    for (let i = pulses.length - 1; i >= 0; i--) if (t - pulses[i].t0 > 1.3) pulses.splice(i, 1);

    const fa = t - freshT;
    fresh = fa < FRESH_HOLD ? 1 : 1 - smooth(0, 1, (fa - FRESH_HOLD) / FRESH_FADE);
    stepBlobs(dt);
    if (popPhase !== 1) { stepParticles(dt, k); stepSparks(dt); }
    render();
    requestAnimationFrame(frame);
  }

  // ---------- 啟動 ----------
  window.addEventListener('resize', resize);
  resize();
  api.getState().then(applyState);
  api.onState(applyState);
  if (api.onEvent) api.onEvent(onEvent);
  requestAnimationFrame(frame);
})();
