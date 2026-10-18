// 「流程」分頁用的純函式：計畫書解析、活動事件紀錄與文字樹。
// 這個檔不碰 `$`、不宣告 atom（驗證器規則：`$` 不跨檔），只收發純資料。

// ---------- 共用顯示輔助（Session／Tool／MCP 分頁也用）----------

export const CONTROL_CHARS = /\p{Cc}/gu;
const PLUGIN_TOOL_PREFIX = /^plugin_([^_]+)_(.+)$/;

// 外部文字（工具說明、MCP 伺服器名稱、檔名）一律去掉控制字元（含 ANSI 跳脫）再顯示。
export function singleLine(text: string): string {
  return text.replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();
}

export function mcpCommandName(name: string): string {
  return name.replace(PLUGIN_TOOL_PREFIX, "plugin:$1:$2");
}

export function displayWidth(char: string): number {
  const code = char.codePointAt(0) ?? 0;
  const isWide =
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff);
  return isWide ? 2 : 1;
}

export function textWidth(text: string): number {
  let width = 0;
  for (const char of text) width += displayWidth(char);
  return width;
}

// 一律保留一格給省略號（即使剛好放得下也截斷）；Session／Tool 分頁沿用這個行為。
export function truncate(text: string, maxColumns: number): string {
  let width = 0;
  let out = "";
  for (const char of text) {
    const w = displayWidth(char);
    if (width + w > maxColumns - 1) return `${out}…`;
    width += w;
    out += char;
  }
  return out;
}

// 放得下就原樣，放不下才截斷加省略號。
export function fit(text: string, maxColumns: number): string {
  return textWidth(text) <= maxColumns ? text : truncate(text, maxColumns);
}

// ---------- 計畫書解析 ----------

export type PlanStatus = "done" | "problem" | "todo";

export type PlanNode = {
  id: string;
  name: string;
  agent: string;
  status: PlanStatus;
  // 狀態備註含「未觸發」：分支沒走到，不算待辦。
  skipped: boolean;
};

const NODE_ID = /\[([A-Za-z0-9-]+)\]/g;
const STATUS_WORD = /^(已執行|未執行|有問題)/;
const FENCE = /^\s*```/;
const BAR = "｜";

const STATUS_OF: Record<string, PlanStatus> = {
  已執行: "done",
  未執行: "todo",
  有問題: "problem",
};

// 單行節點：找 `[ID]`，其後以全形「｜」切成 名稱｜agent｜狀態；狀態以三個關鍵字之一開頭。
export function parseNodeLine(line: string): PlanNode | undefined {
  for (const match of line.matchAll(NODE_ID)) {
    const id = match[1] ?? "";
    const rest = line.slice((match.index ?? 0) + match[0].length);
    const parts = rest.split(BAR);
    if (parts.length < 3) continue;
    const statusAt = parts.findIndex((part, index) => index >= 2 && STATUS_WORD.test(part.trim()));
    if (statusAt < 0) continue;
    const statusText = parts.slice(statusAt).join(BAR).trim();
    const word = STATUS_WORD.exec(statusText)?.[1] ?? "";
    return {
      id,
      name: singleLine(parts[0] ?? ""),
      agent: singleLine(parts.slice(1, statusAt).join(BAR)),
      status: STATUS_OF[word] ?? "todo",
      skipped: statusText.includes("未觸發"),
    };
  }
  return undefined;
}

// 只看 ``` 圍欄區塊內的行，依檔案順序收集所有節點；沒有節點的區塊自然被略過。
export function parsePlan(text: string): PlanNode[] {
  const nodes: PlanNode[] = [];
  let inFence = false;
  for (const line of text.split(/\r?\n/)) {
    if (FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) continue;
    const node = parseNodeLine(line);
    if (node !== undefined) nodes.push(node);
  }
  return nodes;
}

// 第一個「未執行」且不是未觸發分支的節點；沒有則 -1。
export function currentIndexOf(nodes: PlanNode[]): number {
  return nodes.findIndex((node) => node.status === "todo" && !node.skipped);
}

export function doneCount(nodes: PlanNode[]): number {
  return nodes.filter((node) => node.status === "done").length;
}

export type PlanLine = { head: string; agent: string; isMuted: boolean };

// 每個節點一行：head 是符號、ID、名稱（含固定後綴），agent 另列（淡色）；兩者合計不超過 columns。
export function planLines(nodes: PlanNode[], columns: number): PlanLine[] {
  const current = currentIndexOf(nodes);
  return nodes.map((node, index) => {
    let mark: string;
    let suffix = "";
    if (node.skipped && node.status === "todo") {
      mark = "·";
      suffix = "（未觸發）";
    } else if (node.status === "done") {
      mark = "✔";
    } else if (node.status === "problem") {
      mark = "✘";
      suffix = "（有問題）";
    } else if (index === current) {
      mark = "▶";
      suffix = " ← 目前";
    } else {
      mark = "○";
    }
    const lead = `${mark} ${node.id} `;
    const room = Math.max(columns - textWidth(lead) - textWidth(suffix), 6);
    const head = `${lead}${fit(node.name, room)}${suffix}`;
    const left = columns - textWidth(head);
    const agent = node.agent !== "" && left >= 6 ? fit(`｜${node.agent}`, left) : "";
    return { head, agent, isMuted: node.skipped && node.status === "todo" };
  });
}

// 標題一行：「計畫：<檔名>  已執行 a／共 n」；放不下時只縮檔名，計數保留。
export function planHeader(fileName: string, nodes: PlanNode[], columns: number): string {
  const tail = `  已執行 ${doneCount(nodes)}／共 ${nodes.length}`;
  const room = Math.max(columns - textWidth("計畫：") - textWidth(tail), 8);
  return `計畫：${fit(fileName, room)}${tail}`;
}

// ---------- 記憶分頁用的路徑與數字顯示 ----------

const DRIVE_PATH = /^[A-Za-z]:[\\/]/;

export function isDrivePath(path: string): boolean {
  return DRIVE_PATH.test(path);
}

// 引擎給的路徑可能是 C:/… 形式；只有以磁碟代號開頭時才把 / 換成反斜線，其他路徑原樣。
export function displayPath(path: string): string {
  return isDrivePath(path) ? path.replace(/\//g, "\\") : path;
}

export function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(Math.round(tokens));
  return `${(tokens / 1000).toFixed(1).replace(/\.0$/, "")}k`;
}

export function dirnameOf(path: string): string {
  const at = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return at <= 0 ? "/" : path.slice(0, at);
}

export function fileNameOf(path: string): string {
  return path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
}

// ---------- 秘密遮罩（只靠樣式比對，無法保證涵蓋所有秘密）----------

// 先遮罩再截短：狀態與畫面都不會留下秘密。保留可辨識的前綴（`sk-`、`Bearer`、`token=`），只把秘密本體換成 `***`。
const SECRET_KEYWORD = String.raw`(?:api[_-]?key|token|secret|password|passwd|pwd|auth(?:orization)?)`;
const SECRET_VALUE = String.raw`("[^"]*"|'[^']*'|[^\s"']+)`;
const AUTHORIZATION_HEADER = /\b(Authorization)(\s*:\s*)(?:(?:Bearer|Basic|Token)\s+)?[^\s"']+/gi;
const BEARER_TOKEN = /\b(Bearer)(\s+)[A-Za-z0-9._~+/=-]{8,}/gi;
// 鍵名＋ = 或 :（含 JSON 的 "token": "…"）；關鍵字後面不能再接英數字，所以 tokens、author 不會被遮。
const KEY_VALUE = new RegExp(String.raw`(${SECRET_KEYWORD}["']?\s*[=:]\s*)${SECRET_VALUE}`, "gi");
// --token 值（空白分隔的旗標形式）；只認 -- 開頭的旗標，一般文字裡的 "token abc" 不動。
const KEY_FLAG = new RegExp(String.raw`(^|\s)(--[A-Za-z0-9_.-]{0,40}${SECRET_KEYWORD}\s+)${SECRET_VALUE}`, "gi");

const TOKEN_FORMS: [RegExp, string][] = [
  [/(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{8,}/g, "sk-***"],
  [/(?<![A-Za-z0-9])(gh[pousr]_)[A-Za-z0-9]{20,}/g, "$1***"],
  [/(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]{20,}/g, "github_pat_***"],
  [/(?<![A-Za-z0-9])(xox[abprs]-)[A-Za-z0-9-]{10,}/g, "$1***"],
  [/(?<![A-Za-z0-9])AKIA[0-9A-Z]{16}/g, "AKIA***"],
  [/(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{30,}/g, "AIza***"],
];

// 被引號包住的值保留引號，只換內容。
function maskedValue(value: string): string {
  const quote = value.startsWith("\"") || value.startsWith("'") ? value[0] : "";
  return `${quote}***${quote}`;
}

export function maskSecrets(text: string): string {
  let out = text
    .replace(AUTHORIZATION_HEADER, "$1$2***")
    .replace(BEARER_TOKEN, "$1$2***");
  for (const [pattern, replacement] of TOKEN_FORMS) out = out.replace(pattern, replacement);
  return out
    .replace(KEY_VALUE, (_all, head: string, value: string) => `${head}${maskedValue(value)}`)
    .replace(KEY_FLAG, (_all, lead: string, head: string, value: string) => `${lead}${head}${maskedValue(value)}`);
}

// ---------- 活動事件（只存名稱、截短目標、耗時、成敗、agent 從屬）----------

export const TARGET_COLUMNS = 60;
export const DESCRIPTION_COLUMNS = 40;
export const KEPT_EVENTS = 200;
export const SHOWN_TURNS = 5;

export type FlowEvent = {
  id: string;
  kind: "tool" | "agent";
  turn: number;
  // 工具名稱；agent 則是 agent 類型。
  name: string;
  // 工具：截短目標（≤60 欄）；agent：說明（≤40 欄）。
  target: string;
  // 工具：它在哪個 subagent 迴圈執行；agent：自己的 id（spawn 回覆後才有）。主迴圈為 undefined。
  agentId?: string;
  // 只有 agent：它是在哪個 agent 迴圈裡被 spawn 的。
  parentAgentId?: string;
  // 只有 agent：模型別名或 id。
  model: string;
  startedAt: number;
  // 結束後才有；兩者都 undefined 代表還在執行。
  durationMs?: number;
  ok?: boolean;
};

export type ActivityState = {
  events: FlowEvent[];
  turn: number;
  tools: number;
  mcp: number;
  agents: number;
};

export function emptyActivity(): ActivityState {
  return { events: [], turn: 0, tools: 0, mcp: 0, agents: 0 };
}

export function isMcpTool(name: string): boolean {
  return name.startsWith("mcp__");
}

function baseName(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "").split("/").pop() ?? path;
}

function hostOf(url: string): string {
  return /^[a-z][a-z0-9+.-]*:\/\/([^/?#:]*)/i.exec(url)?.[1] ?? url;
}

// 目標摘要：檔案取檔名、指令取第一行、pattern／query／description 原文、網址取主機；
// 一律去控制字元、遮罩秘密（先遮罩再截短）並截到 60 欄。輸入的其餘欄位（內容、完整指令）不經過這裡就不會被保存。
export function targetOf(call: object): string {
  const fields = call as Record<string, unknown>;
  const text = (key: string): string => {
    const value = fields[key];
    return typeof value === "string" ? singleLine(value) : "";
  };
  const picked =
    text("file_path") !== ""
      ? baseName(text("file_path"))
      : text("notebook_path") !== ""
        ? baseName(text("notebook_path"))
        : text("command") !== ""
          ? text("command")
          : text("pattern") !== ""
            ? text("pattern")
            : text("url") !== ""
              ? hostOf(text("url"))
              : text("query") !== ""
                ? text("query")
                : text("description");
  return fit(maskSecrets(picked), TARGET_COLUMNS);
}

export function addEvent(state: ActivityState, event: Omit<FlowEvent, "turn">): ActivityState {
  const counted =
    event.kind === "agent"
      ? { agents: state.agents + 1 }
      : { tools: state.tools + 1, mcp: state.mcp + (isMcpTool(event.name) ? 1 : 0) };
  return {
    ...state,
    ...counted,
    events: [...state.events, { ...event, turn: state.turn }].slice(-KEPT_EVENTS),
  };
}

export function patchEvent(state: ActivityState, id: string, patch: Partial<FlowEvent>): ActivityState {
  return { ...state, events: state.events.map((event) => (event.id === id ? { ...event, ...patch } : event)) };
}

// spawn 被拒或失敗：那個 agent 沒有真的開始，把它從紀錄與計數拿掉。
export function dropEvent(state: ActivityState, id: string): ActivityState {
  const dropped = state.events.find((event) => event.id === id);
  if (dropped === undefined) return state;
  return {
    ...state,
    agents: state.agents - (dropped.kind === "agent" ? 1 : 0),
    events: state.events.filter((event) => event.id !== id),
  };
}

export function startTurn(state: ActivityState): ActivityState {
  return { ...state, turn: state.turn + 1 };
}

// ---------- 文字樹 ----------

export function formatDuration(ms: number): string {
  return ms < 1000 ? `${Math.max(0, Math.round(ms))}ms` : `${(ms / 1000).toFixed(1)}s`;
}

type TreeNode = { text: string; suffix: string; children: TreeNode[]; joint: string };

function toolText(event: FlowEvent): string {
  if (isMcpTool(event.name)) {
    const [, server = "", ...tool] = event.name.split("__");
    return `MCP ${mcpCommandName(server)} › ${tool.join("__")}`;
  }
  return event.target === "" ? event.name : `${event.name}  ${event.target}`;
}

function toolSuffix(event: FlowEvent): string {
  if (event.durationMs === undefined) return "  …";
  return `  ${formatDuration(event.durationMs)}${event.ok === false ? " ✘" : ""}`;
}

function agentText(event: FlowEvent, hasChildren: boolean): string {
  const model = event.model === "" ? "" : `（${event.model}）`;
  const label = `Agent ${event.name}${model}`;
  return !hasChildren && event.target !== "" ? `${label}  ${event.target}` : label;
}

function renderNode(node: TreeNode, first: string, rest: string, columns: number): string[] {
  if (node.children.length === 0) {
    const room = Math.max(columns - textWidth(first) - textWidth(node.suffix), 6);
    return [fit(`${first}${fit(node.text, room)}${node.suffix}`, columns)];
  }
  const head = `${node.text}${node.joint}`;
  const pad = " ".repeat(textWidth(head));
  const count = node.children.length;
  return node.children.flatMap((child, index) => {
    const isLast = index === count - 1;
    if (index === 0) {
      return renderNode(
        child,
        `${first}${head}${count > 1 ? "┬" : "─"}─ `,
        `${rest}${pad}${count > 1 ? "│" : " "}  `,
        columns,
      );
    }
    return renderNode(
      child,
      `${rest}${pad}${isLast ? "└" : "├"}─ `,
      `${rest}${pad}${isLast ? " " : "│"}  `,
      columns,
    );
  });
}

// 最近 SHOWN_TURNS 輪（最新在下）：每輪一棵樹；subagent 的工具掛在 agent 底下，
// 對不到 agent 的（例如 spawn 還沒回覆）平放在該輪頂層。
export function activityLines(events: FlowEvent[], columns: number): string[] {
  const agentById = new Map<string, FlowEvent>();
  for (const event of events) {
    if (event.kind === "agent" && event.agentId !== undefined) agentById.set(event.agentId, event);
  }
  const childrenOf = new Map<FlowEvent, FlowEvent[]>();
  const topOfTurn = new Map<number, FlowEvent[]>();
  for (const event of events) {
    const parentId = event.kind === "agent" ? event.parentAgentId : event.agentId;
    const parent = parentId === undefined ? undefined : agentById.get(parentId);
    const bucket =
      parent !== undefined && parent !== event
        ? (childrenOf.get(parent) ?? childrenOf.set(parent, []).get(parent))
        : (topOfTurn.get(event.turn) ?? topOfTurn.set(event.turn, []).get(event.turn));
    bucket?.push(event);
  }

  const nodeOf = (event: FlowEvent): TreeNode => {
    const kids = (childrenOf.get(event) ?? []).map(nodeOf);
    if (event.kind === "agent") {
      return { text: agentText(event, kids.length > 0), suffix: "", children: kids, joint: "─" };
    }
    return { text: toolText(event), suffix: toolSuffix(event), children: [], joint: "" };
  };

  const turns = [...topOfTurn.keys()].sort((a, b) => a - b).slice(-SHOWN_TURNS);
  return turns.flatMap((turn) => {
    const label = turn === 0 ? "載入前起算的一輪" : `第 ${turn} 輪`;
    const root: TreeNode = {
      text: label,
      suffix: "",
      children: (topOfTurn.get(turn) ?? []).map(nodeOf),
      joint: " ─",
    };
    return renderNode(root, "", "", columns);
  });
}
