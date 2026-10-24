# Lock-in Orb 更新：專注模式、設定視窗、設定流程（2026-10-24）

Kun 與 Grace 共同維護。這份文件記錄這次更新的來源、我們怎麼理解它、做了什麼、還沒做什麼。

## 這次的參考資源

Kun 在 X 上選的貼文：<https://x.com/abmankendrick/status/2113572201199018167>
（Abraham John，2026-10-23，影片 22 秒）。影片裡展示的是 **thinking-orbs**：
Jakub Antalik 做的「AI 思考中」點陣球元件庫。

- 網站與試玩：<https://libraries.dev/orbs>
- 套件：`npm install thinking-orbs`（MIT，純 Canvas 2D，無相依套件）
- 九種狀態，每種是一支不同的動畫：working（粒子在斜軌道上）、searching（掃描線掃過點陣球）、
  solving（色帶打亂再解回來）、listening（波形滾過環）、connecting（星座自己連線）、
  weaving（三股編織）、composing、breathing（環慢慢變形）、shaping（圓→三角→方）。
- 兩個尺寸（64 給頭像、20 給行內文字），單色，自動配合深淺色主題。

我們的理解：它的價值不在「球」本身，而在**把一個抽象狀態翻成一眼看得懂的動作**。
使用者不用讀字就知道 agent 在找、在算、在聽。Lock-in Orb 原本只有一種情緒（漂亮、可以玩），
這次借它的語彙，讓小球也能「說」自己現在在做什麼：專注中、進度到哪、你分心了、這段完成了。

視覺上我們**不**換掉 Grace 的莫內流場球，而是在球外多一圈點陣進度環：
點陣是 thinking-orbs 的語言，顏色仍然是《光與壑》的色票。

## 方向：專注陪伴，但仍然是解壓玩具

Kun 選的是方向 1（lock-in 陪伴），並要求互動時仍是解壓玩具。所以規則很簡單：

1. **專注只改變小球的「情緒」，不改變它的「身體」。** 點、按、甩、拖，在任何狀態都和原本一樣。
2. **專注中小球安靜下來。** 呼吸從約 5 秒一輪放慢到約 11 秒；色塊流得慢一半；光暈收緊；不自動換色。
3. **進度看環，不看數字。** 球外 60 個點，走過的亮、沒走過的暗，領頭的點像掃描線一樣閃。
   選單列同時顯示倒數（macOS 才有）。
4. **分心會被看見。** 專注中若前景切到 LINE、Discord 這類 App，小球退成灰、變暗、輕震一下；切回來就恢復。
5. **完成有儀式。** 時間到：點陣環依序「解出來」亮到最白、一圈暖光散開，1.1 秒後泡泡爆開、換新顏色
   （沿用原本的爆破，等於用自己的獎勵機制收尾）。接著自動進入休息（可關），休息結束再輕輕脈動一下。

## 做了什麼

### 主程序 `main.js`

- 專注引擎：`startFocus / pauseFocus / resumeFocus / stopFocus / startBreak`，每秒檢查一次是否到時；
  畫面只拿 `startedAt / endsAt` 自己插值，主程序不用每秒推狀態。
- 分心偵測（macOS）：專注中每 4 秒用 `osascript` 問 System Events 前景 App 名稱，只拿名稱。
  第一次會跳「允許控制 System Events」；拒絕的話只是不偵測。
- 選單列：專注子選單（15／25／45／90 分鐘、暫停、繼續、結束）、倒數標題、「設定…」。
- 快捷鍵 `⌥⌘L` 開始／結束專注。
- 設定視窗 + 第一次打開的設定精靈（`onboarded` 旗標）。
- 設定新增欄位：`focusMin / breakMin / autoBreak / driftWatch / driftApps / onboarded`；舊設定檔相容。

### 小球畫面 `renderer/orb.js`

- `applyFocus / focusProgress / stepFocus / drawFocusRing / onEvent`。
- 瀏覽器預覽參數：`?focus=25&elapsed=10`、`&drift=1`、`&phase=paused|break`；
  主控台 `window.__orbEvent('focus-done')` 可試結束儀式。

### 設定視窗 `renderer/settings.html / settings.css / settings.js`、`preload-settings.js`

- 精靈三步：看看小球（互動說明）→ 三個權限（震動試一下、麥克風、分心偵測）→ 專注長度與色票。
- 分頁：專注（倒數卡、長度、休息、分心 App 清單）、外觀（16 色票、自動變色、大小、透明度）、
  觸感（後端狀態、試震動）、聲音（麥克風權限、靈敏度）、系統（登入啟動、快捷鍵、版本）。
- 控制項都有名稱、鍵盤焦點、44px 以上的點擊範圍；窄視窗會改成單欄。
- 直接用瀏覽器開 `renderer/settings.html?section=setup` 可以看版面（替身 API，不會改到設定）。

### 網站 `site/index.html`

一頁式介紹：小球在瀏覽器裡活的預覽、互動說明、專注模式說明、安裝步驟。
放到 GitHub Pages 時用 repo 根目錄發布即可（頁面引用 `../renderer/`）。

## 怎麼驗證的（誠實版）

- 這次的開發環境是 Linux 雲端容器，沒有 macOS。所以：
  - 小球畫面與設定視窗：用 Playwright 無頭 Chromium 開 HTML 截圖，確認每個狀態都有畫出來、沒有 JS 錯誤。
  - 主程序：`node --check` 語法檢查，加上 xvfb 下啟動 Electron 看啟動日誌（Linux 上沒有 panel 視窗、沒有震動、沒有分心偵測）。
  - **沒有驗證的**：真機上的觸控板震動節奏、選單列倒數字型、System Events 權限提示、登入啟動。
    這些要 Grace 或 Kun 在 Mac 上 `npm start` 跑一次。
- 瀏覽器視窗測試 ≠ 實體裝置測試。上面每一條都請當成「畫面畫得出來」，不是「手感對了」。

## 給 Grace 的待辦（Mac 實測）

1. `git pull`、`npm start`。第一次會跳設定精靈：試震動、給或不給麥克風。
2. 選單列 → 開始專注 15 分鐘。看：小球是否安靜下來、點陣環是否開始走、選單列有無倒數。
3. 專注中切到 LINE：macOS 應該問「允許控制 System Events」。允許後小球應變灰；切回來恢復。
4. 等它到時（或改 `focusMin` 成 1 分鐘）：看結束儀式和爆破是否接得順、震動有沒有跟上。
5. 覺得哪裡不對，直接在 PR 留言，或改 `renderer/orb.js` 裡 `drawFocusRing` 的參數。

## 下一步（還沒做）

- 專注結束的統計（今天幾段）目前只存在記憶體，重開就歸零；要不要寫進設定檔，Grace 決定。
- 分心 App 清單目前用名稱比對；之後可以加「允許清單」模式（只有這些 App 算專注）。
- 打包成可分發的 .dmg 與公證，等介面定稿再做。
- 網站放到 GitHub Pages（Settings → Pages → main / root）。
