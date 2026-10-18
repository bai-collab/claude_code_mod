# 控制台（未結案 session 點選清單＋工具＋MCP＋流程＋記憶）

在 Claude Code 輸入框上方放一列按鈕，點開側邊面板「控制台」，有五個分頁（版本 0.5.1）；另外每則助理回覆下方會列出路徑與網址的複製按鈕（S5）：

- Session：本工作區最近 10 個「未結案」session，點一下就原地切換過去（S1，行為不變）。
- Tool：目前可用的工具清單（唯讀）。
- MCP：MCP 伺服器與狀態，每台一個「停用」或「啟用」按鈕。
- 流程：上半是 `planned/` 最近一份計畫書的節點進度，下半是本 session 即時的工具與 subagent 活動（S3；S4 起工具目標會先遮罩秘密）。
- 記憶：本 session 已載入的記憶檔，加上自動記憶資料夾裡未載入的記憶檔；可在面板內看原文、複製絕對路徑（S4）。

## 使用者決定（2026-10-18）

1. Session 範圍：只列本工作區（`<設定目錄>/projects/<工作目錄轉成的目錄名>/`，目錄名是把非英數字元全換成 `-`）。
2. 未結案：該 session 最新一筆 `custom-title` 以「進行中 |」開頭（接受全形「｜」與空白差異）；沒有狀態前綴或「結案」開頭的不列。
3. 打開方式：原地切換，外掛觸發 `/resume <sessionId>`；不開新終端機分頁。
4. 入口：輸入框上方常駐按鈕列＋側邊面板分頁；Tool 分頁只列工具與說明；MCP 分頁列伺服器與狀態並可啟用／停用。

## 入口

| 入口 | 作用 |
|---|---|
| 輸入框上方的 `Session`、`Tool`、`MCP`、`流程`、`記憶` 按鈕 | 開啟（或切到）控制台並顯示該分頁 |
| `/panel` | 開啟控制台，顯示上一次的分頁 |
| `/panel auto on`、`/panel auto off` | 設定「開新對話、`/clear`、resume、fork 時自動開面板」，預設開；設定存在外掛的 `$.store`（key `autoOpen`），指令會回覆確認 |
| `/panel copybar on`、`/panel copybar off` | 設定「助理回覆下方的複製按鈕」是否顯示，預設開；設定存在 `$.store`（key `copyBar`），啟動與 `/clear`、resume、fork 時讀進外掛狀態，指令會回覆確認 |
| `/sessions` | 開啟控制台並切到 Session 分頁 |

- 按鈕列刻意不設快捷鍵：空輸入框時按一個數字會被當成按下 band 的按鈕。
- 按鈕是固定的淡黃色色塊（S5，使用者指定）：一般按鈕底 `#FFF3B0`、使用中的分頁底 `#F2C94C`（字粗體），字一律深色 `#3B3000`。**不再跟 `/theme`、`/color` 變**（色碼寫死，常數是 `hooks/register.tsx` 的 `CHIP_BG`、`CHIP_FG`、`CHIP_ACTIVE_BG`）；Button 沒有文字色屬性，所以每顆按鈕都用子層 `Text` 指定深色字，按鈕的 label、key、行為不變。
- 問卷（survey）占用 band 時按鈕列會讓位；與其他外掛的 band 內容疊加（先畫別人的，我們的按鈕列放在它上面）。
- 面板要求 44 欄寬（這只是「請求」，使用者拖過的寬度優先）。

## 分頁說明

- Session：清單、點列切換、「重新整理」（快捷鍵 `r`）。目前這個 session 不列出。
- Tool：用引擎的 `$.tool.list()`，分成「內建」與「MCP」（名稱以 `mcp__` 開頭、或引擎標為 MCP）兩組，每列「名稱＋說明第一行」，依面板欄寬截斷；上方顯示總數。沒有任何動作。
- MCP：已連線的伺服器（名稱與工具數）來自 `$.session.usage({ breakdown: "summary" })` 的 MCP 工具清單；已停用的伺服器來自設定檔（見下）。按鈕執行：
  - 已連線 → 「停用」→ `/mcp disable <名稱>`
  - 已停用 → 「啟用」→ `/mcp enable <名稱>`
  - 名稱為空、含空白或控制字元時不送出，改顯示錯誤列（避免多出參數）。
  - 按下後該列標為「處理中…」，指令結束後重新讀取清單；引擎拒絕時顯示「MCP 指令失敗：…」。

### 流程分頁（S3）

分頁列與按鈕列各多一個「流程」（key `tab-flow`／`band-flow`，仍無快捷鍵）。分兩區：

**上：計畫進度**

- 自動挑計畫書：列出 `<session root>/planned/` **直接底下**的 `*.md`（`complete/`、`shelved/` 等子目錄與非 `.md` 檔不看），依修改時間新到舊取前 5 份，預設選最新一份。`‹`／`›`（`plan-prev`／`plan-next`）在這 5 份之間切換（到頭繞回，旁邊顯示 `1／5`）；「重新整理」（`flow-refresh`，快捷鍵 `r`）重讀目前這份並保留選擇。
- 標題：`計畫：<檔名>  已執行 a／共 n`（太窄時縮檔名、保留計數）。
- 節點解析：只看 ``` 圍欄區塊內的行；找 `[ID]`（英數字與連字號），其後用全形「｜」切成 `名稱｜agent｜狀態`，狀態以「已執行／未執行／有問題」開頭。欄位不全、狀態不是這三個詞、ID 不合法的行直接忽略；多個區塊依檔案順序合併。
- 每個節點一行：

| 符號 | 意義 |
|---|---|
| `✔ P0 …` | 已執行 |
| `▶ P4 … ← 目前` | 第一個未執行的節點（不含「未觸發」分支） |
| `○ P5 …` | 其餘未執行 |
| `✘ P5 …（有問題）` | 有問題 |
| `· W2 …（未觸發）` | 狀態備註含「未觸發」的分支（不算待辦、不會成為「目前」） |

  節點名稱後面接淡色的 `｜<agent>`，依面板欄寬截短。
- 重新讀檔的時機：切到流程分頁時、按「重新整理」、主迴圈每個 `turn.complete`（只在上次顯示的是流程分頁、且控制台還開著時）。讀檔失敗只顯示一行錯誤，不影響其他區塊。

**下：本 session 即時活動**

- 標題：`本 session：工具 x 次（MCP y）・agent z 個`；沒有活動時顯示「外掛載入後的活動會顯示在這裡（載入前的不會補上）」。
- 以文字樹顯示最近 5 輪（最新在下）：

```text
第 12 輪 ─┬─ Bash  node scripts/review-check.mjs  3.2s
          ├─ Agent executor（sonnet）─┬─ Read  register.tsx  40ms
          │                           └─ Bash  claude plugin test  2.5s
          └─ MCP brave-search › brave_web_search  1.1s ✘
```

  `mcp__<伺服器>__<工具>` 顯示成 `MCP <伺服器> › <工具>`；失敗（工具回報錯誤、被拒、丟錯）加 `✘`；還在執行的顯示 `…`。
- 追蹤方式：`turn.start`（只算主迴圈，算出輪次）、`tool.call`、`agent.spawn`、`turn.complete`（見上）四個 hook，一律原樣 `return next(e)`、不改寫、不阻擋；記錄寫失敗也不影響工具。Agent 工具本身由 `agent.spawn` 記成一個 agent 節點，不重複記成工具。
- subagent 從屬：subagent 自己的 `tool.call` 帶有 `agentId`（型別檔 `AgentLoop`），`agent.spawn` 的回覆帶同一個 `agentId`，兩者相同就把該工具掛在那個 agent 底下；巢狀 spawn 用 `parentAgentId`。對不到 agent 紀錄的（例如 spawn 回覆前就先呼叫）平放在該輪頂層。
- **只存**：工具名稱、截短目標（最多 60 欄：檔案取檔名、指令取第一行、pattern／query／description 原文、網址只取主機；MCP 工具不存目標）、agent 類型與說明（最多 40 欄）與模型、耗時、成功或失敗、agent 從屬、輪次。**絕不存**：工具輸入全文、檔案內容、工具結果。目標在截短前先遮罩秘密（見下方「流程分頁的秘密遮罩」）。
- 最多保留最近 200 筆（較舊的丟棄，上方的次數照實累計）；`/clear`、resume、fork 時整個重置。
- 只有外掛載入之後發生的活動會顯示，載入前的不會補上；全部存在外掛的記憶體狀態，不寫檔。

### 記憶分頁（S4）

分頁列與按鈕列各多一個「記憶」（key `tab-memory`／`band-memory`，仍無快捷鍵）。資料只在切到這個分頁、或按「重新整理」（`memory-refresh`，快捷鍵 `r`）時讀，不是每次重畫都讀。

**已載入的記憶檔**

- 來源：`$.session.usage({ breakdown: "summary" })` 的 `context.breakdown.memoryFiles`（每筆有絕對路徑、類型、估算 tokens；summary 只在本機估算、不送請求）。與 MCP 分頁共用同一個呼叫函式。
- 標題：「本 session 載入 N 個記憶檔（約 X tokens）」。
- 每筆三行：類型標籤（引擎給的 `Project`、`User`、`Local`、`Managed`、`AutoMem`，原樣顯示）與 tokens（例如 `1.2k tokens`）、絕對路徑、兩個按鈕「看內容」（`mem-view:<序號>`）與「複製路徑」（`mem-copy:<序號>`）。
- 路徑顯示：只有以磁碟代號開頭（`C:/…`、`F:/…`）的才把 `/` 換成反斜線，其他路徑（例如 `/home/…`）原樣。

**記憶資料夾**

- 取「類型為 AutoMem 的那筆」所在的目錄（不寫死路徑），用 `$.fs.list` 列出該目錄直接底下的 `*.md`，排除已在上面清單的檔案，依檔名排序；區塊標題「記憶資料夾（未載入，被引用時才讀）M 個」，每列同樣有「看內容」（`memdir-view:<序號>`）與「複製路徑」（`memdir-copy:<序號>`）。
- 最多列 30 個，其餘以淡色「還有 K 個…」帶過（沒有分頁）；子目錄與非 `.md` 檔不列。
- 已載入清單裡沒有 AutoMem 時不列資料夾，顯示淡色說明。

**看內容、複製路徑**

- 「看內容」：用 `$.fs.read` 讀檔，面板切到檢視畫面——第一行是絕對路徑，接著「返回」（`mem-back`）與「複製路徑」（`mem-view-copy`），下面是檔案原文逐行顯示。**原文不遮罩**（這是使用者讀自己的檔案，刻意如此）；只把控制字元（含 ANSI 跳脫）換成空白、tab 換成兩個空白，避免弄亂畫面；超過 2000 行只顯示前 2000 行並註明還有幾行。讀取失敗顯示「讀取失敗：…」並停在清單。
- 「複製路徑」：`$.ui.copy({ text: <Windows 絕對路徑>, surface })`，surface 取自按鈕 `onPress` 的引數（`press.surface`）。成功顯示「✔ 已複製：<路徑>」，失敗顯示「✘ 複製失敗（<原因>）：<路徑>」（原因是引擎回的 `no-surface`、`no-clipboard`、`refused`，或丟出的錯誤訊息），路徑仍在畫面上可手動選取。
- 剪貼簿由終端機的剪貼簿工具或 OSC 52 寫入；OSC 52 不會回報成功與否，有些終端機會丟掉它卻仍顯示「已複製」，貼不出來時請直接選取畫面上的路徑。
- 這個分頁絕不寫檔、不執行任何程序。

### 回覆下方的複製按鈕（S5）

每則助理回覆（`ui.render` 的 `AssistantMessage`）下方，若文字裡有 Windows 絕對路徑或網址，就多一列複製按鈕。做法：先 `next(e)` 取得引擎的繪製，原樣放在上面，再把一列按鈕疊在它下面；`e.props` 一個字都不改（`isSummary`、`onScreen` 照引擎給的）。只改畫面，不改存下來的訊息（ctrl+o 看到的仍是原文）。

- **什麼時候不畫**：摘要區塊（`isSummary`）、`/panel copybar off`、或沒有任何目標——這三種情況直接把 `next(e)` 的結果（同一個物件）回傳。
- **偵測什麼**（只對回覆文字做樣式比對，不碰檔案或程序）：
  - Windows 絕對路徑：磁碟代號加 `:\` 或 `:/`，後面接路徑字元，遇到空白、反引號、引號、`<>|*?` 與中文標點（`，。、；：「」『』（）！？`）就停；結尾的 `.,;:)]}` 與全形標點剝掉。原樣保留（不轉換斜線）。磁碟代號前面不可緊接英數字（`xF:\foo` 不算），中文字緊接在前面則算（「在F:\x」）。`F:` 單獨、`12:30` 這類時間不算。
  - 網址：`http://`、`https://` 開頭，遇到空白、反引號、引號、`<>` 與中文標點停；結尾的 `.,;:)]}>` 剝掉。網址裡的 `C:/…` 不會另外當成路徑。
  - 去重（同一段原文只出現一次），依第一次出現的順序；圍欄 ` ```text ` 區塊與行內反引號裡的也抓。
- **每則最多 8 顆**，超過時在按鈕列尾端以淡色顯示「還有 K 個」。
- **標籤**：路徑取最後一個非空區段（檔名或資料夾名）；網址取 `主機[:埠]` 加 `/` 加最後一個非空路徑區段（例如 `127.0.0.1:5181/n5.html`、`github.com/paneline`），查詢字串、片段與帳密（`@` 之前）不進標籤。標籤先套 `maskSecrets`（見下方「流程分頁的秘密遮罩」）再截到 28 欄（超過加 `…`），前面加 `⧉ `。
- **複製的是原文**：按下去 `$.ui.copy({ text: <訊息裡的原文>, surface: press.surface })`，標籤遮罩不影響複製內容（含 token 的網址會完整複製）。狀態列顯示在**那一則訊息**的按鈕下面：成功「✔ 已複製：<原文>」、失敗「✘ 複製失敗（<原因>）：<原文>」。**狀態列顯示的目標會經 `maskSecrets` 遮罩（例如 `token=***`），但實際複製的文字是原文、不遮罩**；記憶分頁複製路徑的狀態列同樣遮罩顯示、複製原路徑。全外掛只留最近一筆狀態，按了另一則訊息的按鈕，前一則的狀態就消失。訊息以內容的 FNV-1a 雜湊（`messageKeyOf`）辨識；回覆還在串流、文字變動時，狀態不會跟著帶過去。
- **按鈕 key** 是 `copy:<訊息鍵>:<序號>`，沒有快捷鍵。複製按鈕用 `plain` 外觀（沒有 `[ ]` 外框），配色與其他按鈕相同。
- **限制**：不支援含空白的路徑（遇空白就停）；UNC（`\\server\share`）、相對路徑、`file://`、`ftp://` 都不抓；只對 `AssistantMessage` 文字比對，不抓工具輸出；路徑末尾的 `)` 一律剝掉（`C:\a\f(1)` 會變成 `C:\a\f(1`）。
- `ui.copy` 的 OSC 52 路徑不回報成功與否（見記憶分頁），貼不出來時請直接選取畫面上的路徑。

### 流程分頁的秘密遮罩（S4）

流程分頁的工具目標（以及 agent 說明）在**截短之前**先經過 `maskSecrets`（`hooks/flow-model.ts`），所以外掛狀態與畫面都不會留下秘密本體；秘密部分換成 `***`，保留可辨識的前綴：

| 樣式 | 遮罩結果範例 |
|---|---|
| `sk-` 加 8 個以上英數、`_`、`-`（含 `sk-ant-…`、`sk-proj-…`；前面不可緊接英數字，所以 `task-…` 不受影響） | `sk-ant-api03-ABCDEFGH…` → `sk-***` |
| `ghp_`／`gho_`／`ghu_`／`ghs_`／`ghr_` 加 20 個以上英數 | `ghp_***` |
| `github_pat_` 加 20 個以上英數、`_` | `github_pat_***` |
| `xoxa-`／`xoxb-`／`xoxp-`／`xoxr-`／`xoxs-` 加 10 個以上 | `xoxb-***` |
| `AKIA` 加 16 個大寫英數 | `AKIA***` |
| `AIza` 加 30 個以上 | `AIza***` |
| `Bearer <8 個以上字元>`（不分大小寫） | `Bearer ***` |
| `Authorization: <值>`（含 Bearer／Basic／Token 前綴） | `Authorization: ***` |
| 鍵名為 `api_key`／`api-key`／`apikey`／`token`／`secret`／`password`／`passwd`／`pwd`／`auth`／`authorization` 的 `鍵=值`、`鍵: 值`、JSON `"鍵": "值"`，以及 `--鍵 值`、`--鍵=值` | `API_KEY=***`、`password: ***`、`--token ***` |

- 值的範圍：到空白或引號為止；被引號包住的值整段換掉並保留引號。
- 不會誤遮的例子（有測試）：`node scripts/review-check.mjs`、`git status`、檔案路徑、`task-management`、`--max-tokens 4096`、`author=bob`、`cat /etc/passwd`。
- **限制**：這是樣式比對，不保證涵蓋所有秘密——沒有固定前綴的金鑰（不在上述鍵名之後的隨機字串）、JWT、`https://帳號:密碼@主機` 內嵌的帳密、鍵名不在清單上的變數都不會被遮；鍵名後面再接字（例如 `token_file=…`）也不在比對範圍。`PWD=/work` 這種環境變數會被當成 `pwd` 一併遮掉（過度遮罩，不影響安全）。遮罩只作用在流程分頁；記憶分頁看內容的原文不遮罩。

資料只在分頁顯示時（以及按「重新整理」或操作後）讀取，不是每次重畫都讀。

## 檔案

- `.claude-plugin/plugin.json`、`types/index.d.ts`：外掛清單與狀態型別。
- `hooks/hooks.json`、`hooks/register.tsx`：註冊指令、按鈕列、面板與五個分頁、自動開啟、即時活動追蹤 hook、記憶分頁的讀檔與複製、助理回覆下方的複製按鈕。
- `hooks/copy-model.ts`：複製按鈕的純函式（路徑與網址抽取、標籤、訊息鍵；不碰 `$`）。
- `hooks/flow-model.ts`：流程與記憶分頁的純函式（計畫書解析、目標摘要、秘密遮罩、活動紀錄、文字樹、路徑與 tokens 顯示；不碰 `$`，驗證器規定 `$` 不跨檔）。
- `scripts/list-sessions.mjs`：唯讀 Node 腳本（只用內建模組），找出每個 transcript 最後一筆標題並輸出 JSON。transcript 可達 20 MB 以上，超過引擎 `$.fs.read` 的 4 MiB 上限，所以不在 hook 內讀檔。
- `scripts/list-sessions.test.mjs`：腳本測試（`node --test`）。
- `tests/register.test.tsx`：Session 分頁測試（S1）。
- `tests/panel.test.tsx`：按鈕列、按鈕配色（淡黃色）、分頁、Tool、MCP、自動開啟測試。
- `tests/flow-model.test.ts`：計畫書解析、目標摘要、文字樹、200 筆上限、秘密遮罩、路徑顯示的純函式測試。
- `tests/flow.test.tsx`：流程分頁（計畫切換、讀檔失敗、即時活動、不存輸入全文、遮罩、重置）測試。
- `tests/copy-model.test.ts`：路徑與網址抽取、標籤、遮罩、訊息鍵的純函式測試。
- `tests/copybar.test.tsx`：回覆下方複製按鈕（引擎繪製保留、摘要與無目標原樣回傳、開關、複製與狀態、失敗原因、8 顆上限、配色）測試。
- `tests/memory.test.tsx`：記憶分頁（已載入清單、記憶資料夾、看內容、複製路徑、不寫檔）測試。
- `scripts/review-check.mjs`：依序跑 validate、plugin test、腳本測試。
- `tsconfig.json`：TypeScript 檢查設定。

## 試用一次

先切到要工作的資料夾（Session 分頁列的是這個資料夾的 session），再在 PowerShell 執行：

```text
claude --plugin-dir <外掛資料夾的完整路徑>
```

進入後輸入框上方會出現 `控制台 Session Tool MCP 流程 記憶`。

## 雙擊啟動（Windows）

`open-claude-with-panel.cmd`：切到工作資料夾、確認以 API 金鑰登入、用 `--plugin-dir` 載入本外掛。

- 工作資料夾預設是外掛資料夾往上兩層（本機原本的 `<repo>\projects\claude-session-picker` 配置）。
- 從 GitHub clone 下來時，請先設定使用者環境變數 `CLAUDE_WORKDIR` 為你的工作資料夾，例如 PowerShell：`[Environment]::SetEnvironmentVariable('CLAUDE_WORKDIR','D:\work','User')`，重開終端機後雙擊即可。
- `.claude-plugin/types/` 是 Claude Code 在本機以 `/plugin-types` 產生的型別檔，不放進版本庫（見 `.gitignore`）。

## 全螢幕與鍵盤操作

- 側邊停靠（dock）需要全螢幕（alternate-screen）且終端機寬度 ≥ 110 欄；窄於這個寬度時面板改顯示在輸入框上方（inline）。外掛自己觸發的自動開啟，需寬度 ≥ 144 欄（使用者手動開過、且沒手動關掉的話降為 110 欄）才會畫出；使用者按按鈕或下指令開啟則任何寬度都會畫。
- 滑鼠點擊只在全螢幕配置可用；主畫面模式不回報點擊（面板會顯示提示），請移動焦點到項目後按 Enter。
- 面板內：`Tab` 移動焦點、`Enter` 按下按鈕、`r` 重新整理、`Esc` 關閉。
- 按鈕列：`ctrl+x ctrl+a` 收合（型別檔註解）、`ctrl+x tab` 把焦點移到 band 或面板（型別檔註解）。

## 讀什麼、不寫什麼

- 讀：
  - `<設定目錄>/projects/<目錄名>/*.jsonl` 的檔案屬性與標題行（唯讀；設定目錄為環境變數 `CLAUDE_CONFIG_DIR`，未設則 `~/.claude`）。
  - MCP 分頁：`$.session.usage`（MCP 工具清單）、`$.tool.list()`，以及 `<CLAUDE_CONFIG_DIR 或家目錄>/.claude.json` 一個檔，**只取出本專案的 `disabledMcpServers`、`disabledMcpjsonServers` 兩個名單裡的伺服器名稱**；其他欄位（含 env、headers、args、token）不顯示、不記錄、不存。
  - 流程分頁：`$.fs.list`／`$.fs.read` 讀 `<session root>/planned/*.md`（只讀）；工具與 agent 活動來自 `tool.call`、`agent.spawn`、`turn.start`、`turn.complete` 事件（見上，只存摘要）。
  - 記憶分頁：`$.session.usage`（`memoryFiles`）、`$.fs.list` 列 AutoMem 所在資料夾、`$.fs.read` 讀你按「看內容」的那一個檔（只讀）；「複製路徑」用 `$.ui.copy`，只複製路徑文字。
  - 複製按鈕：只讀 `AssistantMessage` 的文字（樣式比對）與 `$.store` 的 `copyBar`；按下去用 `$.ui.copy` 複製該則訊息裡的路徑或網址原文，不碰檔案、不執行程序。
  - 環境變數：`CLAUDE_CONFIG_DIR`、`HOME`、`USERPROFILE`（只為了找上述設定檔）。
- 寫：不寫任何檔案（`autoOpen`、`copyBar` 開關存在引擎的 `$.store`，不是檔案）。唯一對外動作是 `/resume <id>`、`/mcp enable|disable <名稱>`（由使用者按鈕觸發）與本外掛的一支 node 腳本（argv、無 shell）；記憶分頁只多一個動作：把路徑文字複製到剪貼簿。
- 不使用 `$.http`、`$.fs.write`、`$.model`、`$.settings`、`$.session.messages`。
- 面板只顯示標題、相對時間、工具名稱與說明、伺服器名稱與狀態、計畫書節點與活動摘要，不顯示對話內容；唯一例外是你主動按「看內容」時顯示的那個記憶檔原文。

## 已知限制與不確定處

- 引擎是否允許外掛用 `$.command.run({ command: "resume", args })` 觸發內建 `/resume` 並在原 session 內切換（S1 已由使用者實機確認可用）；`$.command.run({ command: "mcp", args: "disable <名稱>" })` 是否被引擎接受**尚未實機確認**，被拒絕時面板顯示「MCP 指令失敗：…」，不改動其他東西。
- MCP 分頁的狀態只有「已連線」「已停用」「處理中」。引擎沒有提供「連線失敗／連線中」的伺服器清單（沒有工具的伺服器不會出現在 `session.usage` 的 MCP 工具清單裡），所以連線失敗或還在連線的伺服器不會列出。
- 「已停用」名單來自 `.claude.json` 裡本專案的 `disabledMcpServers`／`disabledMcpjsonServers`（paneline 同法）；讀不到檔案（不存在、超過 4 MiB、被拒）時面板顯示提示，已停用的伺服器可能沒列出。
- 流程分頁的活動不會補上外掛載入前的紀錄；主迴圈 `turn.complete` 才會自動重讀計畫書（計畫書在一輪中途改變，要等到那輪結束或按「重新整理」才看得到）。subagent 的歸屬以 `agentId` 相符為準，`agent.spawn` 回覆前的短暫空檔內該 agent 的工具會先平放在頂層。
- 流程分頁的 hook 只由測試與驗證器檢查，尚未實機確認；本機沒有 `tsc`，型別只靠驗證器與測試執行把關。
- 記憶分頁尚未實機確認：`$.session.usage` 的 `memoryFiles` 在實機是否含 AutoMem、剪貼簿在你的終端機是否真的寫入，都要實測；`ui.copy` 的 OSC 52 路徑不回報成功與否（見上）。
- 複製按鈕與淡黃色配色尚未實機確認：非 `plain` 的按鈕（面板內的「重新整理」「看內容」等）在終端機會畫 `[ ]` 外框，外框字元的顏色由引擎決定，不一定是深色；請實機看可讀性。
- 自動開啟是否真的畫出，取決於終端機寬度與全螢幕（見上）；被拒時不會報錯。
- 型別檔是 Claude Code 2.1.302 產生的（外掛內 `.claude-plugin/types/claude-code/index.d.ts`）。

## 檢查

```text
node scripts/review-check.mjs
```
