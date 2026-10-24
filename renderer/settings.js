// Lock-in Orb 設定視窗：第一次打開是三步驟精靈，之後是分頁設定。
// 在瀏覽器直接開 settings.html 也能看版面（用替身 API，不會真的改到設定）。
(() => {
  'use strict';

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  // ---------- 替身 API：瀏覽器預覽用 ----------
  function makeStubApi() {
    const qs = new URLSearchParams(location.search);
    let s = {
      paletteIndex: Number(qs.get('p')) || 0, auto: true, size: 'M', opacity: 1, haptics: true, hapticBackend: 'mt',
      listen: true, sensitivity: 'M', micStatus: 'not-determined',
      focusMin: 25, breakMin: 5, driftWatch: true, driftApps: ['LINE', 'Discord', 'Messages', '訊息'], autoBreak: true,
      onboarded: qs.get('section') !== 'setup', launchAtLogin: false, driftSupported: true,
      focus: { phase: 'idle', startedAt: 0, endsAt: 0, total: 0, remaining: 0, drift: false, sessionsToday: 0 },
      palettes: window.PALETTES, sizes: { S: '小', M: '中', L: '大' }, opacities: [1, 0.8, 0.6, 0.4],
      focusChoices: [15, 25, 45, 90], shortcuts: { toggle: '⌥⌘O', focus: '⌥⌘L' }, version: '預覽',
    };
    const fm = Number(qs.get('focus'));
    if (fm > 0) {
      const now = Date.now(), total = fm * 60000, el = (Number(qs.get('elapsed')) || 0) * 60000;
      s.focus = { phase: qs.get('phase') || 'focus', startedAt: now - el, endsAt: now + total - el, total, remaining: total - el, drift: false, sessionsToday: 1 };
    }
    const listeners = [];
    const emit = () => listeners.forEach((f) => f(s));
    return {
      get: () => Promise.resolve(s),
      set: (patch) => { s = { ...s, ...patch }; emit(); return Promise.resolve(s); },
      onChange: (f) => listeners.push(f),
      onGo: () => {},
      focus: (cmd, arg) => {
        const now = Date.now();
        if (cmd === 'start') { const total = (arg || s.focusMin) * 60000; s.focus = { ...s.focus, phase: 'focus', startedAt: now, endsAt: now + total, total, remaining: 0 }; }
        if (cmd === 'pause') s.focus = { ...s.focus, phase: 'paused', remaining: s.focus.endsAt - now };
        if (cmd === 'resume') s.focus = { ...s.focus, phase: 'focus', endsAt: now + s.focus.remaining };
        if (cmd === 'stop') s.focus = { ...s.focus, phase: 'idle', total: 0 };
        emit();
        return Promise.resolve(s.focus);
      },
      hapticTest: () => console.log('[settings] haptic test'),
      requestMic: () => { s.micStatus = 'granted'; emit(); return Promise.resolve({ granted: true, status: 'granted' }); },
      openMicSettings() {}, openAutomationSettings() {}, resetPosition() {}, showOrb() {},
      openUrl: (u) => window.open(u, '_blank'), close: () => window.close(),
    };
  }
  const api = window.settings || makeStubApi();
  const isStub = !window.settings;

  let S = null;              // 最新的設定快照
  let hapticTested = false;

  // ---------- 小工具 ----------
  const fmt = (ms) => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  // 色票主色：取飽和度最高的那個，壓到看得清楚的亮度，當作本視窗的 accent
  function accentOf(pal) {
    let best = null, bs = -1;
    for (const c of pal.colors) {
      const [r, g, b] = hex(c);
      const sat = Math.max(r, g, b) - Math.min(r, g, b);
      if (sat > bs) { bs = sat; best = [r, g, b]; }
    }
    const [r, g, b] = best;
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    const k = lum > 0.78 ? 0.78 / lum : 1;           // 太白的壓暗一點
    return `rgb(${Math.round(r * k)},${Math.round(g * k)},${Math.round(b * k)})`;
  }
  function swatchBg(pal) {
    return `linear-gradient(135deg, ${pal.colors.slice(0, 4).join(', ')})`;
  }

  function set(patch) { return api.set(patch).then(applySnapshot); }

  // ---------- 建 UI ----------
  function buildSwatches() {
    for (const host of $$('[data-swatches]')) {
      host.innerHTML = '';
      S.palettes.forEach((pal, i) => {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'swatch'; b.setAttribute('role', 'radio');
        b.setAttribute('aria-label', `${pal.season}・${pal.time}`);
        b.style.setProperty('--sw', swatchBg(pal));
        const lum = pal.colors.slice(0, 4).map(hex).reduce((s, [r, g, b2]) => s + (0.299 * r + 0.587 * g + 0.114 * b2) / 255, 0) / 4;
        if (lum < 0.5) b.classList.add('dark');
        b.innerHTML = `<span>${pal.season}${pal.time}</span>`;
        b.addEventListener('click', () => set({ paletteIndex: i }));
        host.appendChild(b);
      });
    }
  }

  function buildChips(host, items, key, label) {
    host.innerHTML = '';
    for (const [value, text] of items) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'chip'; b.setAttribute('role', 'radio');
      b.dataset.value = String(value); b.textContent = text;
      b.setAttribute('aria-label', `${label}：${text}`);
      b.addEventListener('click', () => set({ [key]: value }));
      host.appendChild(b);
    }
  }

  function buildAll() {
    buildSwatches();
    for (const host of $$('[data-focus-chips]')) buildChips(host, S.focusChoices.map((m) => [m, `${m} 分鐘`]), 'focusMin', '專注長度');
    buildChips($('[data-size-chips]'), Object.entries(S.sizes), 'size', '大小');
    buildChips($('[data-opacity-chips]'), S.opacities.map((v) => [v, `${Math.round(v * 100)}%`]), 'opacity', '透明度');
    buildChips($('[data-sens-chips]'), [['L', '低'], ['M', '中'], ['H', '高']], 'sensitivity', '靈敏度');
  }

  // ---------- 把快照畫到畫面上 ----------
  function applySnapshot(s) {
    if (!s) return;
    S = s;
    const pal = S.palettes[S.paletteIndex] || S.palettes[0];
    document.documentElement.style.setProperty('--accent', accentOf(pal));

    for (const host of $$('[data-swatches]')) {
      $$('.swatch', host).forEach((b, i) => b.setAttribute('aria-checked', String(i === S.paletteIndex)));
    }
    const mark = (host, value) => { if (host) $$('.chip', host).forEach((b) => b.setAttribute('aria-checked', String(b.dataset.value === String(value)))); };
    for (const host of $$('[data-focus-chips]')) mark(host, S.focusMin);
    mark($('[data-size-chips]'), S.size);
    mark($('[data-opacity-chips]'), S.opacity);
    mark($('[data-sens-chips]'), S.sensitivity);

    for (const el of $$('[data-key]')) {
      const k = el.dataset.key;
      if (el === document.activeElement && (el.type === 'number' || el.tagName === 'TEXTAREA')) continue; // 打字中不要蓋掉
      if (el.type === 'checkbox') el.checked = !!S[k];
      else if (el.tagName === 'TEXTAREA') el.value = (S[k] || []).join('\n');
      else el.value = S[k];
    }

    // 權限、後端狀態
    const mic = S.micStatus;
    for (const p of $$('[data-mic-pill]')) {
      p.textContent = mic === 'granted' ? '已允許' : mic === 'denied' || mic === 'restricted' ? '被拒絕' : '未詢問';
      p.className = 'pill ' + (mic === 'granted' ? 'ok' : mic === 'denied' || mic === 'restricted' ? 'bad' : '');
    }
    const hb = S.hapticBackend;
    const hbText = hb === 'mt' ? '分段強度（MultitouchSupport）' : hb === 'ns' ? '系統內建（NSHapticFeedbackManager）' : hb === 'off' ? '已關閉' : '還沒準備好';
    const hbEl = $('[data-haptic-backend]'); if (hbEl) hbEl.textContent = hbText;
    const hp = $('[data-haptic-pill]');
    if (hp) { hp.textContent = hapticTested ? '試過了' : hb === 'mt' || hb === 'ns' ? '可以用' : '找不到觸控板'; hp.className = 'pill ' + (hb === 'mt' || hb === 'ns' ? 'ok' : ''); }
    const dp = $('[data-drift-pill]');
    if (dp) { dp.textContent = S.driftSupported ? (S.driftWatch ? '專注時會問' : '關閉') : '只支援 macOS'; }
    const du = $('[data-drift-unsupported]'); if (du) du.hidden = !!S.driftSupported;
    $$('[data-key="driftWatch"]').forEach((el) => { el.disabled = !S.driftSupported; });

    $('[data-version]').textContent = S.version;
    $('[data-key-toggle]').textContent = S.shortcuts.toggle;
    $('[data-key-focus]').textContent = S.shortcuts.focus;
    renderFocus();
  }

  // ---------- 專注卡 ----------
  function renderFocus() {
    if (!S) return;
    const f = S.focus || { phase: 'idle' };
    const card = $('[data-focus-card]');
    card.dataset.phase = f.phase;
    const timeEl = $('[data-focus-time]'), subEl = $('[data-focus-sub]');
    const now = Date.now();
    if (f.phase === 'focus') {
      timeEl.textContent = fmt(f.endsAt - now);
      subEl.textContent = f.drift ? `分心中（${f.driftApp || '別的 App'}），回來吧。` : `專注中，${Math.round(f.total / 60000)} 分鐘的一段。今天第 ${(f.sessionsToday || 0) + 1} 段。`;
    } else if (f.phase === 'paused') {
      timeEl.textContent = fmt(f.remaining);
      subEl.textContent = '已暫停。';
    } else if (f.phase === 'break') {
      timeEl.textContent = fmt(f.endsAt - now);
      subEl.textContent = '休息中，離開螢幕一下。';
    } else {
      timeEl.textContent = f.sessionsToday ? `今天 ${f.sessionsToday} 段` : '準備好了';
      subEl.textContent = '選一個長度，小球會陪你安靜到結束。';
    }
    const show = (name, on) => { const b = $(`[data-focus="${name}"]`); if (b) b.hidden = !on; };
    show('start', f.phase === 'idle' || f.phase === 'break');
    show('pause', f.phase === 'focus');
    show('resume', f.phase === 'paused');
    show('stop', f.phase !== 'idle');
    $('[data-focus="start"]').textContent = f.phase === 'break' ? '跳過休息，再來一段' : '開始專注';
  }
  setInterval(renderFocus, 500);

  // ---------- 事件 ----------
  function bind() {
    for (const el of $$('[data-key]')) {
      const k = el.dataset.key;
      const handler = () => {
        if (el.type === 'checkbox') set({ [k]: el.checked });
        else if (el.tagName === 'TEXTAREA') set({ [k]: el.value.split('\n').map((s) => s.trim()).filter(Boolean) });
        else if (el.type === 'number') { const n = Number(el.value); if (Number.isFinite(n)) set({ [k]: n }); }
      };
      el.addEventListener('change', handler);
    }
    for (const b of $$('[data-focus]')) {
      b.addEventListener('click', () => {
        const cmd = b.dataset.focus;
        api.focus(cmd, cmd === 'start' ? S.focusMin : undefined).then(() => api.get().then(applySnapshot));
      });
    }
    for (const b of $$('[data-haptic-test]')) b.addEventListener('click', () => { api.hapticTest(); hapticTested = true; applySnapshot(S); });
    for (const b of $$('[data-mic-ask]')) b.addEventListener('click', () => api.requestMic().then(() => api.get().then(applySnapshot)));
    for (const b of $$('[data-mic-skip]')) b.addEventListener('click', () => set({ listen: false }));
    for (const b of $$('[data-open-mic]')) b.addEventListener('click', () => api.openMicSettings());
    for (const b of $$('[data-open-automation]')) b.addEventListener('click', () => api.openAutomationSettings());
    $('[data-reset-position]').addEventListener('click', () => api.resetPosition());
    $('[data-show-orb]').addEventListener('click', () => api.showOrb());
    for (const b of $$('[data-url]')) b.addEventListener('click', () => api.openUrl(b.dataset.url));
    $('[data-rerun-setup]').addEventListener('click', () => showSetup(1));

    // 分頁
    for (const b of $$('[data-go]')) b.addEventListener('click', () => go(b.dataset.go));
    api.onGo((sec) => (sec === 'setup' ? showSetup(1) : go(sec)));

    // 精靈
    for (const b of $$('[data-next]')) b.addEventListener('click', () => step(+1));
    for (const b of $$('[data-prev]')) b.addEventListener('click', () => step(-1));
    $('[data-finish]').addEventListener('click', () => set({ onboarded: true }).then(() => { showPanel('focus'); }));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !isStub) api.close(); });
  }

  // ---------- 畫面切換 ----------
  let curStep = 1;
  function showSetup(n) {
    $('#panel').hidden = true;
    $('#setup').hidden = false;
    curStep = n;
    $$('.step').forEach((el) => { el.hidden = Number(el.dataset.step) !== n; });
    $$('.steps li').forEach((li) => li.classList.toggle('on', Number(li.dataset.step) <= n));
    const pv = $('#preview');
    if (n === 1 && !pv.src) pv.src = `index.html?p=${S ? S.paletteIndex : 0}`;
    const h = $(`.step[data-step="${n}"] h1`); if (h) { h.setAttribute('tabindex', '-1'); h.focus(); }
  }
  function step(d) { showSetup(Math.max(1, Math.min(3, curStep + d))); }
  function showPanel(sec) { $('#setup').hidden = true; $('#panel').hidden = false; go(sec || 'focus'); }
  function go(sec) {
    if (!$(`.sec[data-sec="${sec}"]`)) sec = 'focus';
    $$('.sec').forEach((el) => { el.hidden = el.dataset.sec !== sec; });
    $$('[data-go]').forEach((b) => b.classList.toggle('on', b.dataset.go === sec));
    const h = $(`.sec[data-sec="${sec}"] h1`); if (h) { h.setAttribute('tabindex', '-1'); h.focus({ preventScroll: true }); }
  }

  // ---------- 啟動 ----------
  api.get().then((s) => {
    S = s;
    buildAll();
    bind();
    applySnapshot(s);
    api.onChange(applySnapshot);
    const want = new URLSearchParams(location.search).get('section');
    if (want === 'setup' || !S.onboarded) showSetup(1); else showPanel(want || 'focus');
  });
})();
