// 唯讀：額度分頁用。輸出單一 JSON：
// { codex: { primary, secondary, observedAt } | null, codexReason?, agy: { today, week } | null, agyReason? }
// Codex：只讀最新紀錄檔檔尾的 rate_limits；AGY：只做 readdir＋stat。
// 對話文字、指令、帳號、credits 一律不輸出；錯誤只寫固定說明加 error.code，不丟出、結束碼 0。
import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";

const TAIL_BYTES = 512 * 1024;
// 最新檔沒有讀數時，往較舊的檔案最多再試幾個。
const OLDER_FILES = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

function parseArgs(argv) {
  const home = homedir();
  const options = {
    codexRoot: join(home, ".codex", "sessions"),
    agyRoots: [join(home, ".gemini", "antigravity-cli", "brain"), join(home, ".gemini", "antigravity", "brain")],
    now: Date.now(),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--codex-root" || flag === "--agy-roots" || flag === "--now") {
      if (value === undefined) throw new Error(`${flag} 缺少參數`);
      i += 1;
      if (flag === "--codex-root") options.codexRoot = value;
      else if (flag === "--agy-roots") options.agyRoots = value.split(";").filter((root) => root !== "");
      else {
        const now = Number(value);
        if (!Number.isFinite(now)) throw new Error("--now 必須是毫秒數");
        options.now = now;
      }
    } else {
      throw new Error(`未知參數：${flag}`);
    }
  }
  return options;
}

function codeOf(error) {
  return error && typeof error.code === "string" ? error.code : "ERR";
}

// ---------- Codex ----------

// 子目錄名稱依數字由大到小（年／月／日）。
function namesDesc(dir, pattern) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && pattern.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .reverse();
}

// 依年／月／日目錄新到舊，每個日目錄內依修改時間新到舊，逐一交出 rollout-*.jsonl；最多取 1 + OLDER_FILES 個。
function recentRollouts(root) {
  const found = [];
  const limit = 1 + OLDER_FILES;
  for (const year of namesDesc(root, /^\d{4}$/)) {
    for (const month of namesDesc(join(root, year), /^\d{2}$/)) {
      for (const day of namesDesc(join(root, year, month), /^\d{2}$/)) {
        const dir = join(root, year, month, day);
        const files = [];
        for (const name of readdirSync(dir)) {
          if (!/^rollout-.*\.jsonl$/.test(name)) continue;
          try {
            files.push({ path: join(dir, name), mtimeMs: statSync(join(dir, name)).mtimeMs });
          } catch {
            // 讀不到的檔案略過
          }
        }
        files.sort((a, b) => b.mtimeMs - a.mtimeMs);
        for (const file of files) {
          found.push(file);
          if (found.length >= limit) return found;
        }
      }
    }
  }
  return found;
}

function tailOf(path, size) {
  const length = Math.min(size, TAIL_BYTES);
  const buffer = Buffer.alloc(length);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buffer, 0, length, size - length);
  } finally {
    closeSync(fd);
  }
  // 檔尾被截斷時第一行不完整，丟掉到第一個換行為止。
  const start = size > length ? buffer.indexOf(0x0a) + 1 : 0;
  return start > 0 || size <= length ? buffer.toString("utf8", start) : "";
}

function windowOf(value) {
  if (value === null || typeof value !== "object") return undefined;
  const pct = value.used_percent;
  const windowMinutes = value.window_minutes;
  const resetsAt = value.resets_at;
  if (![pct, windowMinutes, resetsAt].every((n) => typeof n === "number" && Number.isFinite(n))) return undefined;
  // resets_at 是 Unix 秒，輸出一律用毫秒。
  return { pct, windowMinutes, resetsAt: resetsAt * 1000 };
}

// 倒序找最後一筆含 rate_limits（頂層或 payload 底下）的 JSON 行；值為 null、壞行都略過。
function lastRateLimits(text) {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line.includes('"rate_limits"')) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const limits = entry?.rate_limits ?? entry?.payload?.rate_limits;
    if (limits === null || typeof limits !== "object") continue;
    const primary = windowOf(limits.primary);
    const secondary = windowOf(limits.secondary);
    if (primary === undefined && secondary === undefined) continue;
    return { ...(primary === undefined ? {} : { primary }), ...(secondary === undefined ? {} : { secondary }) };
  }
  return undefined;
}

function readCodex(root) {
  let files;
  try {
    files = recentRollouts(root);
  } catch (error) {
    return { codex: null, codexReason: error && error.code === "ENOENT" ? "找不到 Codex 紀錄資料夾" : `讀不到 Codex 紀錄資料夾（${codeOf(error)}）` };
  }
  if (files.length === 0) return { codex: null, codexReason: "找不到 Codex 紀錄檔" };
  let failure = "";
  for (const file of files) {
    try {
      const limits = lastRateLimits(tailOf(file.path, statSync(file.path).size));
      if (limits !== undefined) return { codex: { ...limits, observedAt: Math.floor(file.mtimeMs) } };
    } catch (error) {
      failure = `（${codeOf(error)}）`;
    }
  }
  return { codex: null, codexReason: `近期的 Codex 紀錄檔都讀不到額度（格式可能已變）${failure}` };
}

// ---------- AGY ----------

// 只做 readdir＋stat：一個對話資料夾算一次，看資料夾修改時間在今天（本地午夜起）、近 7 天內。
function readAgy(roots, now) {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const todayStart = midnight.getTime();
  const weekStart = now - 7 * DAY_MS;
  let today = 0;
  let week = 0;
  let readable = 0;
  let failure = "";
  for (const root of roots) {
    let entries;
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch (error) {
      if (!(error && error.code === "ENOENT")) failure = `（${codeOf(error)}）`;
      continue;
    }
    readable += 1;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      let mtimeMs;
      try {
        mtimeMs = statSync(join(root, entry.name)).mtimeMs;
      } catch {
        continue;
      }
      if (mtimeMs >= todayStart) today += 1;
      if (mtimeMs >= weekStart) week += 1;
    }
  }
  if (readable === 0) return { agy: null, agyReason: `找不到 AGY 對話資料夾${failure}` };
  return { agy: { today, week } };
}

try {
  const options = parseArgs(process.argv.slice(2));
  const result = { ...readCodex(options.codexRoot), ...readAgy(options.agyRoots, options.now) };
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  // 只有參數錯誤會到這裡；訊息是固定文字，不含任何讀到的內容。
  const reason = error instanceof Error ? error.message : "參數錯誤";
  process.stdout.write(`${JSON.stringify({ codex: null, codexReason: reason, agy: null, agyReason: reason })}\n`);
}
