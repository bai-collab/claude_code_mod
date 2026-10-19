import { atom, read, update } from "claude-code";
import type { ElementTable, EngineInterface, Register, RenderSurface, ToolCallResult, UiPressArgument } from "claude-code";

import { copyShownOf, extractCopyTargets, messageKeyOf } from "./copy-model";
import {
  activityLines,
  addEvent,
  CONTROL_CHARS,
  DESCRIPTION_COLUMNS,
  dirnameOf,
  displayPath,
  dropEvent,
  emptyActivity,
  fileNameOf,
  fit,
  formatTokens,
  isDrivePath,
  isMcpTool,
  maskSecrets,
  mcpCommandName,
  parsePlan,
  patchEvent,
  planHeader,
  planLines,
  singleLine,
  startTurn,
  targetOf,
  truncate,
} from "./flow-model";
import type { ActivityState, PlanNode } from "./flow-model";

const SESSIONS_COMMAND = "sessions";
const PANEL_COMMAND = "panel";
const PANE_ID = "control-panel";
const PANE_TITLE = "控制台";
const DOCK_COLUMNS = 44;
const AUTO_OPEN_KEY = "autoOpen";
const LIST_LIMIT = 10;
const TITLE_COLUMNS = 40;
const BAND_LABEL_COLUMNS = 28;
const PLAN_DIR = "planned";
const KEPT_PLANS = 5;
// 狀態前綴（進行中、待驗收、暫結案、暫時結案、結案），顯示標題時去掉；長的「暫時結案」「暫結案」要排在「結案」前面。
const PREFIX_PATTERN = /^\s*(?:進行中|待驗收|暫時結案|暫結案|結案)\s*[|｜]\s*/;
const UNSAFE_SERVER_NAME = /[\s\p{Cc}]/u;
const CLAUDE_CONFIG_FILE = ".claude.json";
const MEMORY_DIR_LIMIT = 30;
const MEMORY_VIEW_LINES = 2000;
const AUTO_MEMORY_TYPE = "AutoMem";
const COPY_BAR_KEY = "copyBar";
// 按鈕一律是固定的淡黃色色塊（S5，使用者指定；不再跟 /theme、/color 變）：
// 一般按鈕底 #FFF3B0、使用中的分頁底 #F2C94C，兩者字都是深色 #3B3000（Button 沒有文字色屬性，改用子層 Text）。
const CHIP_BG = "#FFF3B0";
const CHIP_FG = "#3B3000";
const CHIP_ACTIVE_BG = "#F2C94C";

type ChipUi = Pick<ElementTable, "Box" | "Button" | "Text">;
type ChipOptions = {
  boxKey: string;
  // Button 的 key（按下、查找用的位址）；label 同時是畫面上的字。
  key: string;
  label: string;
  onPress: (press: UiPressArgument) => void;
  hotkey?: string;
  plain?: boolean;
  active?: boolean;
  // 左右各留 1 格（plain 按鈕沒有 [ ] 外框）。
  padded?: boolean;
};

// 一顆色塊：有底色的小方塊包一個 Button，Button 的子層 Text 指定深色字（粗體只給使用中的分頁）。
function chipButton(ui: ChipUi, options: ChipOptions) {
  const { Box, Button, Text } = ui;
  return (
    <Box
      key={options.boxKey}
      flexDirection="row"
      flexShrink={0}
      alignSelf="flex-start"
      paddingX={options.padded ? 1 : 0}
      backgroundColor={options.active ? CHIP_ACTIVE_BG : CHIP_BG}
    >
      <Button
        key={options.key}
        label={options.label}
        {...(options.plain ? { plain: true as const } : {})}
        {...(options.hotkey === undefined ? {} : { hotkey: options.hotkey })}
        onPress={options.onPress}
      >
        <Text bold={options.active === true} color={CHIP_FG}>
          {options.label}
        </Text>
      </Button>
    </Box>
  );
}

type Tab = "session" | "tool" | "mcp" | "flow" | "memory";

const TABS: { id: Tab; label: string }[] = [
  { id: "session", label: "Session" },
  { id: "tool", label: "Tool" },
  { id: "mcp", label: "MCP" },
  { id: "flow", label: "流程" },
  { id: "memory", label: "記憶" },
];

type SessionGroup = "open" | "paused" | "closed";
type SessionEntry = { id: string; title: string; mtimeMs: number };

// Session 分頁的三個子分頁：未結案／暫時結案／已結案（腳本一次回傳三組，切換子分頁不重跑腳本）。
const SESSION_GROUPS: { id: SessionGroup; label: string; header: (count: number) => string; empty: string }[] = [
  { id: "open", label: "未結案", header: (count) => `最近 ${count} 個未結案 session`, empty: "沒有未結案的 session" },
  { id: "paused", label: "暫時結案", header: (count) => `最近 ${count} 個暫時結案 session`, empty: "沒有暫時結案的 session" },
  { id: "closed", label: "已結案", header: (count) => `最近 ${count} 個已結案 session`, empty: "沒有已結案的 session" },
];

type Picker = {
  groups: Record<SessionGroup, SessionEntry[]>;
  error: string;
  actionError: string;
  loadedAt: number;
};

type ToolRow = { name: string; description: string; mcp: boolean };
type ToolsState = { tools: ToolRow[]; error: string };

type McpServer = { name: string; connected: boolean; tools: number };
type McpState = {
  servers: McpServer[];
  pending: string[];
  error: string;
  actionError: string;
  notice: string;
};

const pickerAtom = atom(
  { plugin: "session-picker", key: "picker" } as const,
  { groups: emptyGroups(), error: "", actionError: "", loadedAt: 0 } as Picker,
);
// 目前選的 Session 子分頁；獨立成 atom，重新整理（整個 picker 被換掉）時不會跳回「未結案」。
const sessionGroupAtom = atom({ plugin: "session-picker", key: "sessionGroup" } as const, "open" as SessionGroup);
const tabAtom = atom({ plugin: "session-picker", key: "tab" } as const, "session" as Tab);
const toolsAtom = atom(
  { plugin: "session-picker", key: "tools" } as const,
  { tools: [], error: "" } as ToolsState,
);
const mcpAtom = atom(
  { plugin: "session-picker", key: "mcp" } as const,
  { servers: [], pending: [], error: "", actionError: "", notice: "" } as McpState,
);

type PlanState = {
  files: { name: string; mtimeMs: number }[];
  selected: string;
  nodes: PlanNode[];
  error: string;
};

const planAtom = atom(
  { plugin: "session-picker", key: "plan" } as const,
  { files: [], selected: "", nodes: [], error: "" } as PlanState,
);
let spawnSeq = 0;

const activityAtom = atom({ plugin: "session-picker", key: "activity" } as const, emptyActivity() as ActivityState);

// 回覆下方複製按鈕：開關讀進 atom（render hook 不必每次 await store）；
// 「已複製」狀態只留最近一筆（key 是訊息鍵，只顯示在那一則訊息下面）。
type CopyStatus = { key: string; text: string; isError: boolean };

const copyBarAtom = atom({ plugin: "session-picker", key: "copyBar" } as const, true);
const copyStatusAtom = atom(
  { plugin: "session-picker", key: "copyStatus" } as const,
  { key: "", text: "", isError: false } as CopyStatus,
);

type MemoryFile = { type: string; path: string; tokens: number };
type MemoryState = {
  files: MemoryFile[];
  // 載入清單裡有沒有 AutoMem 那筆（沒有就不知道記憶資料夾在哪）。
  hasAutoMem: boolean;
  // 記憶資料夾裡未載入的 *.md（絕對路徑，依檔名排序，最多顯示 30 個）與其餘個數。
  folder: string[];
  folderMore: number;
  folderError: string;
  error: string;
  viewing: { path: string; lines: string[]; omitted: number } | null;
  status: string;
  statusIsError: boolean;
};

const memoryAtom = atom(
  { plugin: "session-picker", key: "memory" } as const,
  {
    files: [],
    hasAutoMem: false,
    folder: [],
    folderMore: 0,
    folderError: "",
    error: "",
    viewing: null,
    status: "",
    statusIsError: false,
  } as MemoryState,
);

function emptyGroups(): Picker["groups"] {
  return { open: [], paused: [], closed: [] };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------- Session 分頁（S1：讀清單、切換）----------

// 讀取清單：唯一的外部呼叫是 node 腳本（argv、無 shell）；失敗都存成錯誤字串，不丟出。
async function loadList($: EngineInterface): Promise<void> {
  const next: Picker = { groups: emptyGroups(), error: "", actionError: "", loadedAt: 0 };
  try {
    const [root, id, now] = await Promise.all([$.session.root(), $.session.id(), $.clock.now()]);
    next.loadedAt = now;
    const result = await $.process.run(
      [
        "node",
        `${$.plugin.root}/scripts/list-sessions.mjs`,
        "--cwd",
        root,
        "--exclude",
        id,
        "--limit",
        String(LIST_LIMIT),
      ],
      { timeoutMs: 20000 },
    );
    const firstLine = (result.stderr.trim().split("\n")[0] ?? "").trim();
    if (result.exitCode !== 0) {
      next.error = `讀取 session 清單失敗（結束碼 ${result.exitCode}）${firstLine ? `：${firstLine}` : ""}`;
    } else {
      const parsed = JSON.parse(result.stdout) as {
        ok?: boolean;
        error?: string;
        groups?: Partial<Record<SessionGroup, SessionEntry[]>>;
      };
      const groups = parsed.groups;
      if (parsed.ok === true && groups !== undefined && SESSION_GROUPS.every((entry) => Array.isArray(groups[entry.id]))) {
        next.groups = { open: groups.open ?? [], paused: groups.paused ?? [], closed: groups.closed ?? [] };
      } else next.error = `讀取 session 清單失敗：${parsed.error ?? "回應格式不符"}`;
    }
  } catch (error) {
    next.error = `讀取 session 清單失敗：${messageOf(error)}`;
  }
  await update($, pickerAtom, () => next);
}

async function resumeSession($: EngineInterface, id: string): Promise<void> {
  try {
    await $.command.run({ command: "resume", args: id });
  } catch (error) {
    await update($, pickerAtom, (state) => ({ ...state, actionError: `切換失敗：${messageOf(error)}` }));
  }
}

// ---------- Tool 分頁（唯讀）----------

async function loadTools($: EngineInterface): Promise<void> {
  let next: ToolsState;
  try {
    const list = await $.tool.list();
    next = {
      tools: list.map((tool) => ({
        name: singleLine(tool.name),
        description: singleLine((tool.description ?? "").split("\n")[0] ?? ""),
        mcp: tool.mcp === true || tool.name.startsWith("mcp__"),
      })),
      error: "",
    };
  } catch (error) {
    next = { tools: [], error: `讀取工具清單失敗：${messageOf(error)}` };
  }
  await update($, toolsAtom, () => next);
}

// ---------- MCP 分頁 ----------

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
}

function ancestorsOf(path: string): string[] {
  const parts = normalizePath(path).split("/");
  return parts.map((_, index) => parts.slice(0, parts.length - index).join("/") || "/");
}

// 只從設定檔取出「本專案的停用伺服器名稱」；其他欄位（env、headers、args、token…）一律不碰、不存、不顯示。
function disabledNamesOf(configText: string, cwd: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(configText);
  } catch {
    return [];
  }
  const projects = (parsed as { projects?: Record<string, unknown> } | null)?.projects;
  if (projects === null || typeof projects !== "object") return [];
  const byPath = new Map<string, unknown>();
  for (const [path, project] of Object.entries(projects)) byPath.set(normalizePath(path), project);
  const root = ancestorsOf(cwd).find((path) => byPath.has(path));
  const project = root === undefined ? undefined : (byPath.get(root) as Record<string, unknown> | undefined);
  if (project === undefined || project === null || typeof project !== "object") return [];
  const names: string[] = [];
  for (const key of ["disabledMcpServers", "disabledMcpjsonServers"]) {
    const value = project[key];
    if (Array.isArray(value)) for (const name of value) if (typeof name === "string") names.push(name);
  }
  return names;
}

async function configPathOf($: EngineInterface): Promise<string | undefined> {
  const configDir = await $.env.get("CLAUDE_CONFIG_DIR");
  if (configDir) return `${configDir}/${CLAUDE_CONFIG_FILE}`;
  const home = (await $.env.get("HOME")) ?? (await $.env.get("USERPROFILE"));
  return home ? `${home}/${CLAUDE_CONFIG_FILE}` : undefined;
}

// MCP 與記憶分頁共用：summary 只在本機估算、不送任何請求；memoryFiles、mcpTools 都在 context.breakdown 底下。
async function usageBreakdown($: EngineInterface) {
  const { context } = await $.session.usage({ breakdown: "summary" });
  return context.breakdown;
}

async function loadMcp($: EngineInterface): Promise<void> {
  const next: McpState = { servers: [], pending: [], error: "", actionError: "", notice: "" };
  try {
    const breakdown = await usageBreakdown($);
    const counts = new Map<string, number>();
    for (const tool of breakdown?.mcpTools ?? []) {
      const name = mcpCommandName(tool.serverName);
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    const servers: McpServer[] = [...counts].map(([name, tools]) => ({ name, connected: true, tools }));

    try {
      const path = await configPathOf($);
      if (path === undefined) throw new Error("找不到使用者目錄");
      const text = await $.fs.read(path);
      const cwd = await $.session.cwd();
      for (const name of disabledNamesOf(text, cwd)) {
        if (!counts.has(name)) servers.push({ name, connected: false, tools: 0 });
      }
    } catch (error) {
      next.notice = `未能讀取停用名單（${messageOf(error)}），已停用的伺服器可能沒有列出`;
    }
    next.servers = servers;
  } catch (error) {
    next.error = `讀取 MCP 伺服器失敗：${messageOf(error)}`;
  }
  await update($, mcpAtom, (state) => ({ ...next, pending: state.pending }));
}

async function toggleMcp($: EngineInterface, server: McpServer): Promise<void> {
  const action = server.connected ? "disable" : "enable";
  const verb = server.connected ? "停用" : "啟用";
  if (server.name === "" || UNSAFE_SERVER_NAME.test(server.name)) {
    await update($, mcpAtom, (state) => ({
      ...state,
      actionError: `無法${verb}「${singleLine(server.name) || "（空白名稱）"}」：名稱含空白或控制字元，未送出指令`,
    }));
    return;
  }
  await update($, mcpAtom, (state) => ({
    ...state,
    actionError: "",
    pending: [...state.pending, server.name],
  }));
  let failure = "";
  try {
    await $.command.run({ command: "mcp", args: `${action} ${server.name}` });
  } catch (error) {
    failure = `MCP 指令失敗：${singleLine(messageOf(error))}`;
  }
  await update($, mcpAtom, (state) => ({
    ...state,
    pending: state.pending.filter((name) => name !== server.name),
  }));
  await loadMcp($);
  if (failure) await update($, mcpAtom, (state) => ({ ...state, actionError: failure }));
}

// ---------- 記憶分頁（S4：已載入的記憶檔＋記憶資料夾；只讀、只複製路徑）----------

function pathKey(path: string): string {
  const normalized = normalizePath(path);
  return isDrivePath(path) ? normalized.toLowerCase() : normalized;
}

async function loadMemory($: EngineInterface): Promise<void> {
  const next: MemoryState = {
    files: [],
    hasAutoMem: false,
    folder: [],
    folderMore: 0,
    folderError: "",
    error: "",
    viewing: null,
    status: "",
    statusIsError: false,
  };
  try {
    const breakdown = await usageBreakdown($);
    next.files = (breakdown?.memoryFiles ?? []).map((file) => ({
      type: singleLine(file.type),
      path: file.path,
      tokens: file.tokens,
    }));
  } catch (error) {
    next.error = `讀取記憶檔清單失敗：${singleLine(messageOf(error))}`;
  }
  const auto = next.files.find((file) => file.type === AUTO_MEMORY_TYPE);
  next.hasAutoMem = auto !== undefined;
  if (auto !== undefined) {
    const dir = dirnameOf(auto.path);
    try {
      const loaded = new Set(next.files.map((file) => pathKey(file.path)));
      const names = (await $.fs.list(dir))
        .filter((entry) => entry.kind === "file" && /\.md$/i.test(entry.name))
        .map((entry) => entry.name)
        .filter((name) => !loaded.has(pathKey(`${dir}/${name}`)))
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      next.folder = names.slice(0, MEMORY_DIR_LIMIT).map((name) => `${dir}/${name}`);
      next.folderMore = Math.max(names.length - MEMORY_DIR_LIMIT, 0);
    } catch (error) {
      next.folderError = `讀取記憶資料夾失敗：${singleLine(messageOf(error))}`;
    }
  }
  await update($, memoryAtom, () => next);
}

// 只讀 fs.read；內容原樣顯示（不遮罩，使用者讀自己的檔案），只把控制字元換成空白以免弄亂畫面。
async function viewMemory($: EngineInterface, path: string): Promise<void> {
  try {
    const text = await $.fs.read(path);
    const all = text.split(/\r?\n/).map((line) => line.replace(/\t/g, "  ").replace(CONTROL_CHARS, " "));
    await update($, memoryAtom, (state) => ({
      ...state,
      viewing: { path, lines: all.slice(0, MEMORY_VIEW_LINES), omitted: Math.max(all.length - MEMORY_VIEW_LINES, 0) },
      status: "",
      statusIsError: false,
    }));
  } catch (error) {
    await update($, memoryAtom, (state) => ({
      ...state,
      status: `讀取失敗：${singleLine(messageOf(error))}`,
      statusIsError: true,
    }));
  }
}

async function backToMemoryList($: EngineInterface): Promise<void> {
  await update($, memoryAtom, (state) => ({ ...state, viewing: null, status: "", statusIsError: false }));
}

// 複製絕對路徑（Windows 反斜線形式）；surface 取自按鈕的 press 引數。失敗時顯示原因，路徑仍在畫面上可手動選取。
async function copyMemoryPath($: EngineInterface, path: string, surface: RenderSurface): Promise<void> {
  const copied = displayPath(path);
  const shown = maskSecrets(copied);
  let status: string;
  let statusIsError = false;
  try {
    const result = await $.ui.copy({ text: copied, surface });
    if (result.isCopied) status = `✔ 已複製：${shown}`;
    else {
      status = `✘ 複製失敗（${result.reason}）：${shown}`;
      statusIsError = true;
    }
  } catch (error) {
    status = `✘ 複製失敗（${singleLine(messageOf(error))}）：${shown}`;
    statusIsError = true;
  }
  await update($, memoryAtom, (state) => ({ ...state, status, statusIsError }));
}

// ---------- 回覆下方的複製按鈕（S5）----------

// 複製原文（一字不改）；狀態只顯示在該則訊息下面，顯示用的文字去掉控制字元並遮罩疑似祕密（複製的仍是原文）；
// 多行指令只顯示第一行加「…（共 N 行）」，狀態列保持單行。
async function copyReplyTarget($: EngineInterface, msgKey: string, raw: string, surface: RenderSurface): Promise<void> {
  const shown = copyShownOf(raw);
  let text: string;
  let isError = false;
  try {
    const result = await $.ui.copy({ text: raw, surface });
    if (result.isCopied) text = `✔ 已複製：${shown}`;
    else {
      text = `✘ 複製失敗（${result.reason}）：${shown}`;
      isError = true;
    }
  } catch (error) {
    text = `✘ 複製失敗（${singleLine(messageOf(error))}）：${shown}`;
    isError = true;
  }
  await update($, copyStatusAtom, () => ({ key: msgKey, text, isError }));
}

// 讀不到設定時視為預設值（開啟）。
async function copyBarOf($: EngineInterface): Promise<boolean> {
  try {
    return (await $.store.get(COPY_BAR_KEY)) !== false;
  } catch {
    return true;
  }
}

async function syncCopyBar($: EngineInterface): Promise<void> {
  const isOn = await copyBarOf($);
  await quietly(update($, copyBarAtom, () => isOn));
}

// ---------- 流程分頁（S3：計畫進度＋本 session 即時活動）----------

// 只讀：列出 <session root>/planned 直接底下的 *.md（子目錄不看），依修改時間新到舊取前 5 份，
// 讀選定的那份並解析節點。任何失敗都存成錯誤字串，不丟出。
async function loadPlan($: EngineInterface, pick?: string): Promise<void> {
  const wanted = pick ?? (await read($, planAtom)).selected;
  const next: PlanState = { files: [], selected: "", nodes: [], error: "" };
  try {
    const dir = `${normalizePath(await $.session.root())}/${PLAN_DIR}`;
    const entries = await $.fs.list(dir);
    next.files = entries
      .filter((entry) => entry.kind === "file" && /\.md$/i.test(entry.name))
      .sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name))
      .slice(0, KEPT_PLANS)
      .map((entry) => ({ name: entry.name, mtimeMs: entry.mtimeMs }));
    const chosen = next.files.find((file) => file.name === wanted) ?? next.files[0];
    if (chosen !== undefined) {
      next.selected = chosen.name;
      try {
        next.nodes = parsePlan(await $.fs.read(`${dir}/${chosen.name}`));
      } catch (error) {
        next.error = `讀取計畫書失敗：${singleLine(messageOf(error))}`;
      }
    }
  } catch (error) {
    next.error = `讀取 ${PLAN_DIR}/ 失敗：${singleLine(messageOf(error))}`;
  }
  await update($, planAtom, () => next);
}

// ‹ 往較新、› 往較舊（清單新到舊），到頭就繞回另一端。
async function stepPlan($: EngineInterface, delta: number): Promise<void> {
  const { files, selected } = await read($, planAtom);
  if (files.length === 0) return;
  const at = Math.max(
    files.findIndex((file) => file.name === selected),
    0,
  );
  await loadPlan($, files[(at + delta + files.length) % files.length]?.name);
}

// 追蹤用的寫入失敗不可影響工具、turn 本身。
async function quietly(work: Promise<unknown>): Promise<void> {
  try {
    await work;
  } catch {
    // 追蹤是附帶功能，寫不進去就算了
  }
}

// 本輪面板若開在流程分頁就重讀計畫書（節點狀態會隨工作進度改變）。
async function refreshFlowIfOpen($: EngineInterface): Promise<void> {
  try {
    if ((await read($, tabAtom)) !== "flow") return;
    if (!(await $.ui.panes()).some((pane) => pane.id === PANE_ID)) return;
    await loadPlan($);
  } catch {
    // 重讀失敗不影響 turn
  }
}

// ---------- 面板開啟、分頁切換 ----------

async function loadTab($: EngineInterface, tab: Tab): Promise<void> {
  if (tab === "session") await loadList($);
  else if (tab === "tool") await loadTools($);
  else if (tab === "mcp") await loadMcp($);
  else if (tab === "memory") await loadMemory($);
  else await loadPlan($);
}

async function switchTab($: EngineInterface, tab: Tab): Promise<void> {
  await update($, tabAtom, () => tab);
  await loadTab($, tab);
}

// 開啟控制台：先讀目前分頁的資料再開面板；被引擎拒絕時由呼叫端接住。
async function openPanel($: EngineInterface, tab: Tab | undefined, focus: boolean): Promise<void> {
  const target = tab ?? (await read($, tabAtom));
  await switchTab($, target);
  await $.ui.open({
    id: PANE_ID,
    title: PANE_TITLE,
    closeOnEscape: true,
    columns: DOCK_COLUMNS,
    ...(focus ? { focus: true as const } : {}),
  });
}

function openQuietly($: EngineInterface, tab: Tab | undefined, focus: boolean): void {
  openPanel($, tab, focus).catch((error: unknown) => {
    $.ui.log(`開啟控制台失敗：${messageOf(error)}`, { to: "debug" });
  });
}

// 讀不到設定時視為預設值（開啟）；不讓設定讀取失敗影響 session.start。
async function autoOpenOf($: EngineInterface): Promise<boolean> {
  try {
    return (await $.store.get(AUTO_OPEN_KEY)) !== false;
  } catch {
    return true;
  }
}

// ---------- 顯示輔助 ----------

function relativeTime(mtimeMs: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - mtimeMs) / 1000));
  if (seconds < 60) return "剛剛";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分鐘前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小時前`;
  return `${Math.floor(hours / 24)} 天前`;
}

function labelOf(session: SessionEntry, now: number): string {
  const title = session.title.replace(PREFIX_PATTERN, "").replace(/\s+/g, " ").trim() || "（無標題）";
  return `${truncate(title, TITLE_COLUMNS)} · ${relativeTime(session.mtimeMs, now)}`;
}

function toolLine(tool: ToolRow, columns: number): string {
  const text = tool.description ? `${tool.name}  ${tool.description}` : tool.name;
  return truncate(text, columns);
}

export const register: Register = (on) => {
  on("session.start", { isInteractive: true }, async ($, e, next) => {
    await $.command.register({ name: SESSIONS_COMMAND, description: "開啟控制台（Session 分頁：未結案／暫時結案／已結案 session）" });
    await $.command.register({
      name: PANEL_COMMAND,
      description: "開啟控制台；/panel auto on|off 設定自動開啟；/panel copybar on|off 設定回覆下方的複製按鈕",
    });
    await syncCopyBar($);
    if (await autoOpenOf($)) openQuietly($, undefined, false);
    return next(e);
  });

  on("classic.SessionStart", { source: ["clear", "resume", "fork"] }, async ($, e, next) => {
    // 對話換了（/clear、resume、fork）：舊的即時活動不屬於「本 session」，清掉。
    await quietly(update($, activityAtom, () => emptyActivity()));
    await syncCopyBar($);
    if (await autoOpenOf($)) openQuietly($, undefined, false);
    return next(e);
  });

  // ----- 即時活動追蹤：每個 hook 都原樣交還 next(e)，只記名稱、截短目標、耗時、成敗與從屬 -----

  on("turn.start", async ($, e, next) => {
    if (e.agentId === undefined) await quietly(update($, activityAtom, (state) => startTurn(state)));
    return next(e);
  });

  on("turn.complete", async ($, e, next) => {
    if (e.agentId === undefined) await refreshFlowIfOpen($);
    return next(e);
  });

  on("tool.call", async ($, e, next) => {
    // Agent 工具本身由 agent.spawn 記成一個 agent 節點，不重複記成工具。
    const toolName: string = e.tool;
    if (toolName === "Agent" || toolName === "Task") return next(e);
    const id = e.tool_use_id;
    const startedAt = await $.clock.now();
    await quietly(
      update($, activityAtom, (state) =>
        addEvent(state, {
          id,
          kind: "tool",
          name: singleLine(e.tool),
          target: isMcpTool(e.tool) ? "" : targetOf(e),
          ...(e.agentId === undefined ? {} : { agentId: e.agentId }),
          model: "",
          startedAt,
        }),
      ),
    );
    const finish = async (ok: boolean): Promise<void> => {
      const durationMs = (await $.clock.now()) - startedAt;
      await quietly(update($, activityAtom, (state) => patchEvent(state, id, { durationMs, ok })));
    };
    let ran: ToolCallResult;
    try {
      ran = await next(e);
    } catch (error) {
      await finish(false);
      throw error;
    }
    await finish(ran.deny === undefined && ran.isError !== true);
    return ran;
  });

  on("agent.spawn", async ($, e, next) => {
    const id = `agent:${e.tool_use_id}:${await $.clock.now()}:${++spawnSeq}`;
    await quietly(
      update($, activityAtom, (state) =>
        addEvent(state, {
          id,
          kind: "agent",
          name: singleLine(e.subagentType),
          target: fit(maskSecrets(singleLine(e.description)), DESCRIPTION_COLUMNS),
          ...(e.parentAgentId === undefined ? {} : { parentAgentId: e.parentAgentId }),
          model: singleLine(e.model ?? ""),
          startedAt: 0,
        }),
      ),
    );
    let spawn: Awaited<ReturnType<typeof next>>;
    try {
      spawn = await next(e);
    } catch (error) {
      await quietly(update($, activityAtom, (state) => dropEvent(state, id)));
      throw error;
    }
    if (spawn.deny !== undefined) {
      await quietly(update($, activityAtom, (state) => dropEvent(state, id)));
    } else {
      await quietly(
        update($, activityAtom, (state) =>
          patchEvent(state, id, {
            model: singleLine(spawn.model),
            ...(spawn.agentId === undefined ? {} : { agentId: spawn.agentId }),
          }),
        ),
      );
    }
    return spawn;
  });

  on("command.run", { command: SESSIONS_COMMAND }, async ($) => {
    // /sessions 一律落在「未結案」子分頁。
    await update($, sessionGroupAtom, () => "open");
    await openPanel($, "session", true);
    return {};
  }).catch(($, e, next) => {
    const text = `開啟控制台失敗：${next.error.message ?? "未知錯誤"}`;
    $.ui.log(text, { to: "debug" });
    return { text };
  });

  on("command.run", { command: PANEL_COMMAND }, async ($, e) => {
    const args = e.args.trim().split(/\s+/).filter((part) => part !== "");
    if (args.length === 0) {
      await openPanel($, undefined, true);
      return {};
    }
    const [sub, value] = args;
    if (args.length === 2 && sub === "auto" && (value === "on" || value === "off")) {
      await $.store.set(AUTO_OPEN_KEY, value === "on");
      return {
        text:
          value === "on"
            ? "控制台自動開啟：已開啟（開新對話、/clear、resume、fork 時自動開面板）"
            : "控制台自動開啟：已關閉（仍可用 /panel、/sessions 或輸入框上方的按鈕開啟）",
      };
    }
    if (args.length === 2 && sub === "copybar" && (value === "on" || value === "off")) {
      await $.store.set(COPY_BAR_KEY, value === "on");
      await update($, copyBarAtom, () => value === "on");
      return {
        text:
          value === "on"
            ? "回覆下方的複製按鈕：已開啟（回覆含 Windows 絕對路徑或網址時，下方列出複製按鈕）"
            : "回覆下方的複製按鈕：已關閉",
      };
    }
    return { text: "用法：/panel 開啟控制台；/panel auto on|off 設定自動開啟；/panel copybar on|off 設定回覆下方的複製按鈕" };
  }).catch(($, e, next) => {
    const text = `開啟控制台失敗：${next.error.message ?? "未知錯誤"}`;
    $.ui.log(text, { to: "debug" });
    return { text };
  });

  // 助理回覆下方的複製按鈕列：先取引擎的繪製（原樣保留），再把一列按鈕疊在它下面。
  // 摘要區塊、開關關閉、沒有路徑／網址時原樣回傳 drawn（同一個物件）；絕不改動 e.props（isSummary、onScreen 照引擎給的）。
  on("ui.render", { component: "AssistantMessage" }, async ($, e, next) => {
    const drawn = await next(e);
    if (e.props.isSummary === true) return drawn;
    if (!(await read($, copyBarAtom))) return drawn;
    const { shown, more } = extractCopyTargets(e.props.text);
    if (shown.length === 0) return drawn;

    const msgKey = messageKeyOf(e.props.text);
    const status = await read($, copyStatusAtom);
    const { Box, Button, Text } = $.ui.resolve(e);
    return (
      <Box key={`copybar-${msgKey}`} flexDirection="column">
        {drawn}
        <Box key={`copybar-row-${msgKey}`} flexDirection="row" flexWrap="wrap" columnGap={1}>
          {shown.map((target, index) =>
            chipButton(
              { Box, Button, Text },
              {
                boxKey: `copy-chip-${msgKey}-${index}`,
                key: `copy:${msgKey}:${index}`,
                label: target.label,
                plain: true,
                padded: true,
                onPress: (press) => void copyReplyTarget($, msgKey, target.raw, press.surface),
              },
            ),
          )}
          {more > 0 ? <Text dimColor>還有 {more} 個</Text> : null}
        </Box>
        {status.key === msgKey && status.text !== "" ? (
          status.isError ? (
            <Text key={`copy-status-${msgKey}`} color="error">
              {status.text}
            </Text>
          ) : (
            <Text key={`copy-status-${msgKey}`}>{status.text}</Text>
          )
        ) : null}
      </Box>
    );
  });

  // 輸入框上方的按鈕列：與其他外掛的 AbovePrompt 疊加（先取下一層，再把自己放在它上面）。
  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    const below = await next(e);
    if (e.props.hasSurvey) return below;

    const { Box, Button, Text } = $.ui.resolve(e);
    const showLabel = e.props.bodyColumns >= BAND_LABEL_COLUMNS;
    return (
      <Box key="band" flexDirection="column">
        <Box key="band-row" flexDirection="row" columnGap={1} width={e.props.bodyColumns} height={1} overflow="hidden">
          {showLabel ? (
            <Text dimColor wrap="truncate-end">
              控制台
            </Text>
          ) : null}
          {TABS.map((tab) =>
            chipButton(
              { Box, Button, Text },
              {
                boxKey: `band-chip-${tab.id}`,
                key: `band-${tab.id}`,
                label: tab.label,
                plain: true,
                padded: true,
                onPress: () => openQuietly($, tab.id, true),
              },
            ),
          )}
        </Box>
        {below}
      </Box>
    );
  });

  on("ui.render", { component: "Pane", requestId: PANE_ID }, async ($, e) => {
    const [tab, picker, sessionGroup, tools, mcp, memory, now] = await Promise.all([
      read($, tabAtom),
      read($, pickerAtom),
      read($, sessionGroupAtom),
      read($, toolsAtom),
      read($, mcpAtom),
      read($, memoryAtom),
      $.clock.now(),
    ]);
    const { Box, Button, Text } = $.ui.resolve(e);
    const chip = (options: ChipOptions) => chipButton({ Box, Button, Text }, options);
    const showKeyboardHint = e.surface === "terminal" && e.viewport?.isFullscreen === false;
    const columns = Math.max(e.props.bodyColumns, 12);

    const tabBar = (
      <Box key="tabs" flexDirection="row" columnGap={1}>
        {TABS.map((entry) => {
          const isActive = entry.id === tab;
          const label = isActive ? `[${entry.label}]` : entry.label;
          return chip({
            boxKey: `tab-chip-${entry.id}`,
            key: `tab-${entry.id}`,
            label,
            plain: true,
            active: isActive,
            padded: true,
            onPress: () => void switchTab($, entry.id),
          });
        })}
      </Box>
    );

    let body;
    if (tab === "session") {
      const group = SESSION_GROUPS.find((entry) => entry.id === sessionGroup) ?? SESSION_GROUPS[0]!;
      const sessions = picker.groups[group.id];
      const groupBar = (
        <Box key="groups" flexDirection="row" flexWrap="wrap" columnGap={1}>
          {SESSION_GROUPS.map((entry) => {
            const isActive = entry.id === group.id;
            const text = `${entry.label}(${picker.groups[entry.id].length})`;
            return chip({
              boxKey: `group-chip-${entry.id}`,
              key: `group-${entry.id}`,
              label: isActive ? `[${text}]` : text,
              plain: true,
              active: isActive,
              padded: true,
              onPress: () => void update($, sessionGroupAtom, () => entry.id),
            });
          })}
        </Box>
      );
      body = (
        <Box key="session" flexDirection="column">
          {groupBar}
          <Text>{group.header(sessions.length)}</Text>
          {picker.error ? <Text color="error">{picker.error}</Text> : null}
          {!picker.error && sessions.length === 0 ? <Text dimColor>{group.empty}</Text> : null}
          {sessions.map((session) =>
            chip({
              boxKey: `chip-${session.id}`,
              key: session.id,
              label: labelOf(session, now),
              onPress: () => void resumeSession($, session.id),
            }),
          )}
          {picker.actionError ? <Text color="error">{picker.actionError}</Text> : null}
          {chip({ boxKey: "chip-refresh", key: "refresh", label: "重新整理", hotkey: "r", onPress: () => void loadList($) })}
        </Box>
      );
    } else if (tab === "tool") {
      const builtin = tools.tools.filter((tool) => !tool.mcp);
      const external = tools.tools.filter((tool) => tool.mcp);
      body = (
        <Box key="tool" flexDirection="column">
          <Text>
            共 {tools.tools.length} 個工具（內建 {builtin.length}／MCP {external.length}）
          </Text>
          {tools.error ? <Text color="error">{tools.error}</Text> : null}
          {!tools.error && tools.tools.length === 0 ? <Text dimColor>目前沒有可用工具</Text> : null}
          {builtin.length > 0 ? <Text bold>內建（{builtin.length}）</Text> : null}
          {builtin.map((tool) => (
            <Text key={`tool-${tool.name}`} wrap="truncate-end">
              {toolLine(tool, columns)}
            </Text>
          ))}
          {external.length > 0 ? <Text bold>MCP（{external.length}）</Text> : null}
          {external.map((tool) => (
            <Text key={`tool-${tool.name}`} wrap="truncate-end">
              {toolLine(tool, columns)}
            </Text>
          ))}
          {chip({
            boxKey: "chip-tool-refresh",
            key: "tool-refresh",
            label: "重新整理",
            hotkey: "r",
            onPress: () => void loadTools($),
          })}
        </Box>
      );
    } else if (tab === "memory") {
      const statusLine = memory.status ? (
        memory.statusIsError ? (
          <Text key="mem-status" color="error">
            {memory.status}
          </Text>
        ) : (
          <Text key="mem-status">{memory.status}</Text>
        )
      ) : null;
      if (memory.viewing !== null) {
        const { path, lines, omitted } = memory.viewing;
        body = (
          <Box key="memory-view" flexDirection="column">
            <Text bold>{displayPath(path)}</Text>
            <Box key="mem-view-actions" flexDirection="row" columnGap={1}>
              {chip({ boxKey: "chip-mem-back", key: "mem-back", label: "返回", onPress: () => void backToMemoryList($) })}
              {chip({
                boxKey: "chip-mem-view-copy",
                key: "mem-view-copy",
                label: "複製路徑",
                onPress: (press) => void copyMemoryPath($, path, press.surface),
              })}
            </Box>
            {statusLine}
            {lines.map((line, index) => (
              <Text key={`mem-line-${index}`}>{line === "" ? " " : line}</Text>
            ))}
            {omitted > 0 ? <Text dimColor>（內容太長，後面還有 {omitted} 行未顯示）</Text> : null}
          </Box>
        );
      } else {
        const totalTokens = memory.files.reduce((sum, file) => sum + file.tokens, 0);
        const memoryRow = (kind: "mem" | "memdir", index: number, path: string, label: string) => (
          <Box key={`${kind}-row-${index}`} flexDirection="column">
            <Text bold wrap="truncate-end">
              {label}
            </Text>
            <Text>{displayPath(path)}</Text>
            <Box key={`${kind}-actions-${index}`} flexDirection="row" columnGap={1}>
              {chip({
                boxKey: `chip-${kind}-view:${index}`,
                key: `${kind}-view:${index}`,
                label: "看內容",
                onPress: () => void viewMemory($, path),
              })}
              {chip({
                boxKey: `chip-${kind}-copy:${index}`,
                key: `${kind}-copy:${index}`,
                label: "複製路徑",
                onPress: (press) => void copyMemoryPath($, path, press.surface),
              })}
            </Box>
          </Box>
        );
        body = (
          <Box key="memory" flexDirection="column">
            <Text>
              本 session 載入 {memory.files.length} 個記憶檔（約 {formatTokens(totalTokens)} tokens）
            </Text>
            {memory.error ? <Text color="error">{memory.error}</Text> : null}
            {memory.files.map((file, index) =>
              memoryRow("mem", index, file.path, `${file.type || "（未標類型）"} · ${formatTokens(file.tokens)} tokens`),
            )}
            {statusLine}
            {memory.hasAutoMem ? (
              <Text bold>記憶資料夾（未載入，被引用時才讀）{memory.folder.length + memory.folderMore} 個</Text>
            ) : (
              <Text dimColor>沒有自動記憶（AutoMem）項目，找不到記憶資料夾</Text>
            )}
            {memory.folderError ? <Text color="error">{memory.folderError}</Text> : null}
            {memory.folder.map((path, index) => memoryRow("memdir", index, path, truncate(fileNameOf(path), columns)))}
            {memory.folderMore > 0 ? <Text dimColor>還有 {memory.folderMore} 個…</Text> : null}
            {chip({
              boxKey: "chip-memory-refresh",
              key: "memory-refresh",
              label: "重新整理",
              hotkey: "r",
              onPress: () => void loadMemory($),
            })}
          </Box>
        );
      }
    } else if (tab === "flow") {
      const [plan, activity] = await Promise.all([read($, planAtom), read($, activityAtom)]);
      const rows = planLines(plan.nodes, columns);
      const at = plan.files.findIndex((file) => file.name === plan.selected);
      const lines = activityLines(activity.events, columns);
      body = (
        <Box key="flow" flexDirection="column">
          <Text bold>計畫進度</Text>
          {plan.error ? <Text color="error">{plan.error}</Text> : null}
          {!plan.error && plan.files.length === 0 ? (
            <Text dimColor>{PLAN_DIR}/ 底下沒有計畫書（*.md）</Text>
          ) : null}
          {plan.selected !== "" ? (
            <Text key="plan-header" wrap="truncate-end">
              {planHeader(singleLine(plan.selected), plan.nodes, columns)}
            </Text>
          ) : null}
          {plan.files.length > 0 ? (
            <Box key="plan-nav" flexDirection="row" columnGap={1}>
              {chip({ boxKey: "chip-plan-prev", key: "plan-prev", label: "‹", onPress: () => void stepPlan($, -1) })}
              {chip({ boxKey: "chip-plan-next", key: "plan-next", label: "›", onPress: () => void stepPlan($, 1) })}
              <Text dimColor>
                {at + 1}／{plan.files.length}
              </Text>
            </Box>
          ) : null}
          {plan.selected !== "" && !plan.error && rows.length === 0 ? (
            <Text dimColor>這份計畫書沒有可辨識的節點</Text>
          ) : null}
          {rows.map((row, index) => (
            <Box key={`plan-node-${index}`} flexDirection="row">
              <Text dimColor={row.isMuted} wrap="truncate-end">
                {row.head}
              </Text>
              {row.agent ? (
                <Text dimColor wrap="truncate-end">
                  {row.agent}
                </Text>
              ) : null}
            </Box>
          ))}
          <Text bold>本 session 即時活動</Text>
          <Text>
            本 session：工具 {activity.tools} 次（MCP {activity.mcp}）・agent {activity.agents} 個
          </Text>
          {lines.length === 0 ? <Text dimColor>外掛載入後的活動會顯示在這裡（載入前的不會補上）</Text> : null}
          {lines.map((line, index) => (
            <Text key={`activity-${index}`} wrap="truncate-end">
              {line}
            </Text>
          ))}
          {chip({
            boxKey: "chip-flow-refresh",
            key: "flow-refresh",
            label: "重新整理",
            hotkey: "r",
            onPress: () => void loadPlan($),
          })}
        </Box>
      );
    } else {
      body = (
        <Box key="mcp" flexDirection="column">
          <Text>共 {mcp.servers.length} 個 MCP 伺服器</Text>
          {mcp.error ? <Text color="error">{mcp.error}</Text> : null}
          {!mcp.error && mcp.servers.length === 0 ? <Text dimColor>沒有 MCP 伺服器</Text> : null}
          {mcp.servers.map((server) => {
            const isPending = mcp.pending.includes(server.name);
            const name = singleLine(server.name) || "（空白名稱）";
            const status = isPending
              ? "處理中…"
              : server.connected
                ? `已連線 · ${server.tools} 個工具`
                : "已停用";
            return (
              <Box key={`mcp-row-${server.name}`} flexDirection="row" columnGap={1}>
                <Text wrap="truncate-end">{truncate(`${name} · ${status}`, Math.max(columns - 6, 8))}</Text>
                {isPending ? null : (
                  chip({
                    boxKey: `chip-mcp-toggle-${server.name}`,
                    key: `mcp-toggle-${server.name}`,
                    label: server.connected ? "停用" : "啟用",
                    onPress: () => void toggleMcp($, server),
                  })
                )}
              </Box>
            );
          })}
          {mcp.actionError ? <Text color="error">{mcp.actionError}</Text> : null}
          {mcp.notice ? <Text dimColor>{mcp.notice}</Text> : null}
          {chip({ boxKey: "chip-mcp-refresh", key: "mcp-refresh", label: "重新整理", hotkey: "r", onPress: () => void loadMcp($) })}
        </Box>
      );
    }

    return (
      <Box key="card" flexDirection="column">
        {tabBar}
        {body}
        {showKeyboardHint ? (
          <Text dimColor>主畫面模式不回報滑鼠點擊，請移動焦點後按 Enter，或按 r 重新整理</Text>
        ) : null}
      </Box>
    );
  });
};
