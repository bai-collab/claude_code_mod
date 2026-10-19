// 回覆下方「複製按鈕」用的純函式：從助理回覆文字抽出 Windows 絕對路徑、網址與 ``` 圍欄裡的指令、產生按鈕標籤、算訊息鍵。
// 這個檔不碰 `$`、不宣告 atom（驗證器規則：`$` 不跨檔），只收發純資料；只對文字做樣式比對，不碰檔案或程序。

import { fit, maskSecrets, singleLine } from "./flow-model";

export const MAX_COPY_CHIPS = 8;
export const COPY_LABEL_COLUMNS = 28;
export const COPY_LABEL_PREFIX = "⧉ ";

// 連結類（路徑、網址）；指令類是從 ``` 圍欄區塊來的。
export type LinkKind = "path" | "url";
export type CopyTargetKind = LinkKind | "command";

export type CopyTarget = {
  // 原文：按下去複製的就是它，一字不改（含結尾的斜線；指令區塊則是整段內容，含換行）。
  raw: string;
  kind: CopyTargetKind;
  // 已遮罩、截短、加前綴的按鈕標籤。
  label: string;
};

export type CopyTargets = {
  // 最多 MAX_COPY_CHIPS 個，依第一次出現的順序。
  shown: CopyTarget[];
  // 去重後超出上限的個數。
  more: number;
};

// 路徑／網址共同的終止字元：空白、反引號、各種引號、全形標點。
const QUOTES = String.raw`\x60'"‘’“”`;
const CJK_PUNCTUATION = "，。、；：「」『』（）！？";
const PATH_STOP = String.raw`\s${QUOTES}<>|*?${CJK_PUNCTUATION}`;
const URL_STOP = String.raw`\s${QUOTES}<>${CJK_PUNCTUATION}`;

// 一個 regex 同時掃網址與路徑（由左到右、網址優先），所以網址裡的 `C:/…` 不會被另外當成路徑。
// 路徑：磁碟代號前面不可緊接英數字（`xF:\` 不算）；中文字緊接在前面則算（「在F:\x」）。
const TARGET_PATTERN = new RegExp(
  String.raw`(https?:\/\/[^${URL_STOP}]+)|((?<![A-Za-z0-9])[A-Za-z]:[\\/][^${PATH_STOP}]+)`,
  "gi",
);

// 結尾要剝掉的標點（句號、逗號、括號、閉引號、全形標點）；中間的不動。
const TRAILING = new Set([...".,;:)]}>", ...CJK_PUNCTUATION, "…"]);
const URL_BODY = /^https?:\/\/./i;
const DRIVE_ONLY = /^[A-Za-z]:$/;

function stripTrailing(text: string): string {
  let end = text.length;
  while (end > 0 && TRAILING.has(text[end - 1] ?? "")) end--;
  return text.slice(0, end);
}

// 依第一次出現的順序列出所有不重複的目標原文（不限個數）。
export function findCopyTargets(text: string): { raw: string; kind: LinkKind }[] {
  const seen = new Set<string>();
  const found: { raw: string; kind: LinkKind }[] = [];
  for (const match of text.matchAll(TARGET_PATTERN)) {
    const kind: LinkKind = match[1] === undefined ? "path" : "url";
    const raw = stripTrailing(match[0]);
    if (kind === "url" && !URL_BODY.test(raw)) continue;
    if (kind === "path" && raw.length < 3) continue;
    if (seen.has(raw)) continue;
    seen.add(raw);
    found.push({ raw, kind });
  }
  return found;
}

// 路徑取最後一個非空的區段（資料夾或檔名）；只有磁碟代號時顯示 `F:\`。
function pathLabel(raw: string): string {
  const segments = raw.split(/[\\/]+/).filter((segment) => segment !== "");
  const last = segments.at(-1) ?? raw;
  return segments.length === 1 && DRIVE_ONLY.test(last) ? `${last}\\` : last;
}

// 網址取 `主機[:埠]`，有路徑時再加 `/最後一個非空區段`；帳密（@ 之前）、查詢字串與片段都不進標籤。
function urlLabel(raw: string): string {
  const parts = /^https?:\/\/([^/?#]*)([^?#]*)/i.exec(raw);
  const host = (parts?.[1] ?? raw).split("@").pop() ?? "";
  const last = (parts?.[2] ?? "").split("/").filter((segment) => segment !== "").at(-1);
  return last === undefined ? host : `${host}/${last}`;
}

// 標籤一律：先遮罩再截短（標籤不留秘密）、加前綴；複製的原文不受影響。
function labelOfBase(base: string): string {
  return `${COPY_LABEL_PREFIX}${fit(maskSecrets(singleLine(base)), COPY_LABEL_COLUMNS)}`;
}

export function copyLabelOf(raw: string, kind: LinkKind): string {
  return labelOfBase(kind === "path" ? pathLabel(raw) : urlLabel(raw));
}

// ---------- ``` 圍欄裡的指令 ----------

const FENCE_OPENER = /^\s*```[^`]*$/;
const FENCE_CLOSER = /^\s*```\s*$/;
const TITLE_LINE = /^#\s+(.+)$/;

const isBlank = (line: string): boolean => line.trim() === "";

// 去掉頭尾空白行，再去掉非空白行共同的最小縮排。
function blockLines(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && isBlank(lines[start] ?? "")) start++;
  while (end > start && isBlank(lines[end - 1] ?? "")) end--;
  const body = lines.slice(start, end);
  const indents = body.filter((line) => !isBlank(line)).map((line) => /^\s*/.exec(line)?.[0].length ?? 0);
  const common = indents.length === 0 ? 0 : Math.min(...indents);
  return body.map((line) => line.slice(common));
}

// 含 `\` 或 `/` 的字取最後一個非空區段（`harness/cli/review-loop.mjs` → `review-loop.mjs`）。
function shortWord(word: string): string {
  if (!/[\\/]/.test(word)) return word;
  return word.split(/[\\/]+/).filter((segment) => segment !== "").at(-1) ?? word;
}

// 一個區塊（已去頭尾空白行與共同縮排）→ 指令按鈕；不產生按鈕時回 undefined（區塊維持一般文字）。
function commandOfBlock(lines: string[]): { raw: string; label: string } | undefined {
  const content = lines.join("\n");
  if (content === "") return undefined;
  const only = findCopyTargets(content);
  if (only.length === 1 && only[0]?.raw === content) return undefined;

  // `# 標題` 開頭：標題當標籤，其餘（去掉標題後緊接的空白行）當複製內容；先於單行規則判斷。
  const title = TITLE_LINE.exec(lines[0] ?? "");
  if (title !== null) {
    const rest = lines.slice(1);
    while (rest.length > 0 && isBlank(rest[0] ?? "")) rest.shift();
    if (rest.length === 0) return undefined;
    return { raw: rest.join("\n"), label: labelOfBase((title[1] ?? "").trim()) };
  }

  if (lines.length === 1) {
    const words = content.split(/\s+/);
    const first = words[0] ?? content;
    if (first.startsWith("/")) {
      return { raw: content, label: labelOfBase(first.slice(1) === "" ? first : first.slice(1)) };
    }
    return { raw: content, label: labelOfBase(words.slice(0, 2).map(shortWord).join(" ")) };
  }
  return { raw: content, label: labelOfBase(`指令（${lines.length} 行）`) };
}

// 狀態列顯示用：單行遮罩；多行只顯示遮罩後的第一個非空行加「…（共 N 行）」。複製的仍是原文。
export function copyShownOf(raw: string): string {
  const lines = raw.split(/\r?\n/);
  if (lines.length === 1) return maskSecrets(singleLine(raw));
  const first = lines.find((line) => !isBlank(line)) ?? "";
  return `${maskSecrets(singleLine(first))}…（共 ${lines.length} 行）`;
}

// 依出現順序列出全部（不限個數、未去重）：產生按鈕的圍欄區塊（開頭到結尾那行都不再掃路徑與網址）給指令按鈕，其餘文字照舊掃路徑與網址。
function collectTargets(text: string): CopyTarget[] {
  const out: CopyTarget[] = [];
  const lines = text.split(/\r?\n/);
  let prose: string[] = [];
  const flush = (): void => {
    for (const { raw, kind } of findCopyTargets(prose.join("\n"))) out.push({ raw, kind, label: copyLabelOf(raw, kind) });
    prose = [];
  };

  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    let close = -1;
    if (FENCE_OPENER.test(line)) {
      for (let next = index + 1; next < lines.length; next++) {
        if (FENCE_CLOSER.test(lines[next] ?? "")) {
          close = next;
          break;
        }
      }
    }
    // 沒有結尾的開頭圍欄忽略，維持一般文字（下一行照常往下看）。
    if (close === -1) {
      prose.push(line);
      index++;
      continue;
    }
    // 沒產生按鈕的圍欄區塊整塊（含結尾那行，避免它被當成下一個開頭）併回一般文字；只有產生按鈕的才整塊略過。
    const command = commandOfBlock(blockLines(lines.slice(index + 1, close)));
    if (command === undefined) {
      prose.push(...lines.slice(index, close + 1));
      index = close + 1;
      continue;
    }
    flush();
    out.push({ raw: command.raw, kind: "command", label: command.label });
    index = close + 1;
  }
  flush();
  return out;
}

export function extractCopyTargets(text: string, max = MAX_COPY_CHIPS): CopyTargets {
  const seen = new Set<string>();
  const all = collectTargets(text).filter((target) => {
    const key = `${target.kind}\0${target.raw}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { shown: all.slice(0, max), more: Math.max(all.length - max, 0) };
}

// 訊息鍵：FNV-1a 32 位元雜湊（純函式、不需要 crypto），只用來讓「已複製」狀態對得到同一則訊息。
export function messageKeyOf(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
