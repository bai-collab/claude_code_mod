// 唯讀：列出某工作目錄下最近的「進行中」session（依 transcript 最後一筆 custom-title 判定）。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";

const ID_PATTERN = /^[0-9a-f-]{36}$/i;
const UNFINISHED_PATTERN = /^\s*進行中\s*[|｜]/;
const TITLE_MARKER = Buffer.from('"type":"custom-title"');

function parseArgs(argv) {
  const options = { cwd: undefined, dir: undefined, exclude: new Set(), limit: 10 };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--cwd" || flag === "--dir" || flag === "--exclude" || flag === "--limit") {
      if (value === undefined) throw new Error(`${flag} 缺少參數`);
      i += 1;
      if (flag === "--cwd") options.cwd = value;
      else if (flag === "--dir") options.dir = value;
      else if (flag === "--exclude") options.exclude.add(value);
      else {
        const limit = Number(value);
        if (!Number.isInteger(limit) || limit < 0) throw new Error("--limit 必須是非負整數");
        options.limit = limit;
      }
    } else {
      throw new Error(`未知參數：${flag}`);
    }
  }
  if (options.dir === undefined && options.cwd === undefined) throw new Error("需要 --cwd 或 --dir");
  return options;
}

function transcriptDir(options) {
  if (options.dir !== undefined) return options.dir;
  const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  return join(configDir, "projects", options.cwd.replace(/[^A-Za-z0-9]/g, "-"));
}

// 從檔尾往前找最後一筆可解析的 custom-title；整檔讀成 Buffer（最大約 21 MB），只對命中行做 JSON.parse。
function lastCustomTitle(path) {
  const buffer = readFileSync(path);
  let end = buffer.length;
  while (end > 0) {
    const hit = buffer.lastIndexOf(TITLE_MARKER, end - 1);
    if (hit < 0) return undefined;
    const lineStart = buffer.lastIndexOf(0x0a, hit) + 1;
    let lineEnd = buffer.indexOf(0x0a, hit);
    if (lineEnd < 0) lineEnd = buffer.length;
    try {
      const entry = JSON.parse(buffer.toString("utf8", lineStart, lineEnd));
      if (entry && entry.type === "custom-title" && typeof entry.customTitle === "string") {
        return entry.customTitle;
      }
    } catch {
      // 壞行略過，繼續往前找
    }
    end = lineStart;
  }
  return undefined;
}

function listSessions(options) {
  const dir = transcriptDir(options);
  let names;
  try {
    names = readdirSync(dir);
  } catch (error) {
    if (error && error.code === "ENOENT") return { dir, sessions: [] };
    throw error;
  }

  const files = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const id = name.slice(0, -".jsonl".length);
    if (!ID_PATTERN.test(id) || options.exclude.has(id)) continue;
    try {
      files.push({ id, path: join(dir, name), mtimeMs: statSync(join(dir, name)).mtimeMs });
    } catch {
      // 讀不到的檔案略過
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const sessions = [];
  for (const file of files) {
    if (sessions.length >= options.limit) break;
    let title;
    try {
      title = lastCustomTitle(file.path);
    } catch {
      continue;
    }
    if (title !== undefined && UNFINISHED_PATTERN.test(title)) {
      sessions.push({ id: file.id, title, mtimeMs: file.mtimeMs });
    }
  }
  return { dir, sessions };
}

try {
  const result = listSessions(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
  process.exitCode = 1;
}
