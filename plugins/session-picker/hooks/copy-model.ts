// 回覆下方「複製按鈕」用的純函式：從助理回覆文字抽出 Windows 絕對路徑與網址、產生按鈕標籤、算訊息鍵。
// 這個檔不碰 `$`、不宣告 atom（驗證器規則：`$` 不跨檔），只收發純資料；只對文字做樣式比對，不碰檔案或程序。

import { fit, maskSecrets, singleLine } from "./flow-model";

export const MAX_COPY_CHIPS = 8;
export const COPY_LABEL_COLUMNS = 28;
export const COPY_LABEL_PREFIX = "⧉ ";

export type CopyTargetKind = "path" | "url";

export type CopyTarget = {
  // 原文：按下去複製的就是它，一字不改（含結尾的斜線）。
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
export function findCopyTargets(text: string): { raw: string; kind: CopyTargetKind }[] {
  const seen = new Set<string>();
  const found: { raw: string; kind: CopyTargetKind }[] = [];
  for (const match of text.matchAll(TARGET_PATTERN)) {
    const kind: CopyTargetKind = match[1] === undefined ? "path" : "url";
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

// 先遮罩再截短（標籤不留秘密）；複製的原文不受影響。
export function copyLabelOf(raw: string, kind: CopyTargetKind): string {
  const base = kind === "path" ? pathLabel(raw) : urlLabel(raw);
  return `${COPY_LABEL_PREFIX}${fit(maskSecrets(singleLine(base)), COPY_LABEL_COLUMNS)}`;
}

export function extractCopyTargets(text: string, max = MAX_COPY_CHIPS): CopyTargets {
  const all = findCopyTargets(text);
  return {
    shown: all.slice(0, max).map(({ raw, kind }) => ({ raw, kind, label: copyLabelOf(raw, kind) })),
    more: Math.max(all.length - max, 0),
  };
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
