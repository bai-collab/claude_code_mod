# 啟動前選計費方式（start-claude）

Windows 雙擊啟動 Claude Code 命令列（CLI）前，先選這次要用哪種計費方式，不必進 claude 後再 `/login`、退出重開。

| 檔案 | 作用 |
|---|---|
| `start-claude.cmd` | 選單：按 `1` 用訂閱（claude.ai 登入，OAuth），按 `2` 用 API 金鑰 |
| `start-claude-api.cmd` | API 金鑰路線；`start-claude.cmd` 按 `2` 時呼叫它，也可以單獨雙擊 |

兩個檔案必須放在同一個資料夾（`start-claude.cmd` 用自己所在的資料夾找 `start-claude-api.cmd`）。

## 選項 1：訂閱（OAuth）

- 只在這個視窗清掉 `ANTHROPIC_API_KEY`、`ANTHROPIC_AUTH_TOKEN`，**不改系統設定**（使用者層環境變數不動），讓 Claude Code 不會拿到金鑰。
- 先執行 `claude.cmd auth status`：
  - 結束碼不是 0 → 提示執行 `claude.cmd auth login`（或進 claude 後用 `/login`），然後停下。
  - `authMethod` 不是 `claude.ai`（例如設了 `apiKeyHelper`、`CLAUDE_CODE_OAUTH_TOKEN` 或其他設定檔的金鑰來源）→ 顯示提醒並停下。
- 兩項都通過才啟動 `claude`，不加 `--bare`，所以 `CLAUDE.md`、掛鉤與外掛照常載入，也不指定模型。

## 選項 2：API 金鑰

- 需要使用者層環境變數 `ANTHROPIC_API_KEY`（視窗裡沒有時，從 `HKCU\Environment` 讀入，只存在該視窗）。
- 先執行 `claude.cmd --bare auth status`，失敗就停下。
- 通過後執行 `claude.cmd --bare --model claude-opus-5-5 --add-dir <工作資料夾>`。
  - `--bare` 會跳過自動尋找 `CLAUDE.md`，所以用 `--add-dir` 把工作資料夾的 `CLAUDE.md` 補回來。
- 金鑰不會顯示、不會寫進任何檔案；請勿把金鑰寫進啟動檔。

## 工作資料夾（`CLAUDE_WORKDIR`）

- 有設使用者環境變數 `CLAUDE_WORKDIR` 就切到那個資料夾；沒設就用啟動檔往上兩層的資料夾。
- 剛 clone 下來時，往上兩層是這個 repo 的根目錄，通常不是你的工作資料夾，請先設定：

```bat
setx CLAUDE_WORKDIR "<你的工作資料夾>"
```

設定後要開新的視窗才會生效。資料夾不存在時會顯示「Cannot open work folder」並停下。

## 附第一句指令

兩種選項都會把參數原樣傳給 claude，可以直接帶第一句指令：

```bat
start-claude.cmd "請讀 handoff.md 並照做"
```

## 限制

- 只支援 Windows：啟動檔呼叫的是 `claude.cmd`（npm 全域安裝的 Claude Code），並用 `choice`、`reg query`、`findstr`。
- `authMethod` 的判斷是比對 `claude.cmd auth status` 的輸出；日後 CLI 若改了輸出格式，選項 1 會停下，不會誤放行。
