import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const script = resolve(dirname(fileURLToPath(import.meta.url)), "list-sessions.mjs");
const uuid = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;

let root;
before(() => {
  root = mkdtempSync(join(tmpdir(), "session-picker-"));
});
after(() => rmSync(root, { recursive: true, force: true }));

function titleLine(title) {
  return JSON.stringify({ type: "custom-title", customTitle: title, sessionId: "x" });
}

// 建立 fixture 目錄；files: { 檔名: { lines: [...], age: 越大越舊（秒） } }
function fixture(name, files) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const base = Date.now() / 1000;
  for (const [file, spec] of Object.entries(files)) {
    const path = join(dir, file);
    writeFileSync(path, `${spec.lines.join("\n")}\n`);
    const t = base - (spec.age ?? 0);
    utimesSync(path, t, t);
  }
  return dir;
}

function run(args) {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
  return { status: result.status, json: JSON.parse(result.stdout) };
}

const chat = JSON.stringify({ type: "user", message: { content: "hi" } });

describe("list-sessions", () => {
  test("只保留「進行中」前綴（含全形 ｜），捨棄結案與無前綴", () => {
    const dir = fixture("prefix", {
      [`${uuid(1)}.jsonl`]: { lines: [chat, titleLine("進行中 | 甲")], age: 1 },
      [`${uuid(2)}.jsonl`]: { lines: [chat, titleLine("進行中｜乙")], age: 2 },
      [`${uuid(3)}.jsonl`]: { lines: [chat, titleLine("結案 | 丙")], age: 3 },
      [`${uuid(4)}.jsonl`]: { lines: [chat, titleLine("沒有前綴")], age: 4 },
      [`${uuid(5)}.jsonl`]: { lines: [chat], age: 5 },
    });
    const { status, json } = run(["--dir", dir]);
    assert.equal(status, 0);
    assert.equal(json.ok, true);
    assert.deepEqual(json.sessions.map((s) => s.title), ["進行中 | 甲", "進行中｜乙"]);
    assert.deepEqual(json.sessions.map((s) => s.id), [uuid(1), uuid(2)]);
  });

  test("同檔多筆標題以最後一筆為準", () => {
    const dir = fixture("last", {
      [`${uuid(1)}.jsonl`]: { lines: [titleLine("進行中 | 舊"), chat, titleLine("結案 | 新")] },
      [`${uuid(2)}.jsonl`]: { lines: [titleLine("結案 | 舊"), chat, titleLine("進行中 | 新")], age: 1 },
    });
    const { json } = run(["--dir", dir]);
    assert.deepEqual(json.sessions.map((s) => s.title), ["進行中 | 新"]);
  });

  test("--exclude 排除指定 id（可重複）", () => {
    const dir = fixture("exclude", {
      [`${uuid(1)}.jsonl`]: { lines: [titleLine("進行中 | 一")], age: 1 },
      [`${uuid(2)}.jsonl`]: { lines: [titleLine("進行中 | 二")], age: 2 },
      [`${uuid(3)}.jsonl`]: { lines: [titleLine("進行中 | 三")], age: 3 },
    });
    const { json } = run(["--dir", dir, "--exclude", uuid(1), "--exclude", uuid(3)]);
    assert.deepEqual(json.sessions.map((s) => s.id), [uuid(2)]);
  });

  test("依 mtime 由新到舊排序並套用 --limit", () => {
    const files = {};
    for (let n = 1; n <= 5; n += 1) {
      files[`${uuid(n)}.jsonl`] = { lines: [titleLine(`進行中 | 第${n}個`)], age: n * 100 };
    }
    const dir = fixture("limit", files);
    const { json } = run(["--dir", dir, "--limit", "3"]);
    assert.deepEqual(json.sessions.map((s) => s.title), ["進行中 | 第1個", "進行中 | 第2個", "進行中 | 第3個"]);
    assert.ok(json.sessions[0].mtimeMs > json.sessions[1].mtimeMs);
  });

  test("排序依 mtime 而非檔名：檔名較大但較舊的排後面", () => {
    const dir = fixture("order", {
      [`${uuid(9)}.jsonl`]: { lines: [titleLine("進行中 | 舊檔")], age: 500 },
      [`${uuid(1)}.jsonl`]: { lines: [titleLine("進行中 | 新檔")], age: 5 },
    });
    const { json } = run(["--dir", dir]);
    assert.deepEqual(json.sessions.map((s) => s.title), ["進行中 | 新檔", "進行中 | 舊檔"]);
  });

  test("壞行被忽略，往前找到可解析的標題", () => {
    const dir = fixture("malformed", {
      [`${uuid(1)}.jsonl`]: {
        lines: [titleLine("進行中 | 好的"), '{"type":"custom-title","customTitle":"進行中 | 壞', "not json"],
      },
      [`${uuid(2)}.jsonl`]: { lines: ['{"type":"custom-title" broken'], age: 1 },
    });
    const { status, json } = run(["--dir", dir]);
    assert.equal(status, 0);
    assert.deepEqual(json.sessions.map((s) => s.title), ["進行中 | 好的"]);
  });

  test("目錄不存在時回傳空清單", () => {
    const { status, json } = run(["--dir", join(root, "missing")]);
    assert.equal(status, 0);
    assert.equal(json.ok, true);
    assert.deepEqual(json.sessions, []);
  });

  test("非 UUID 檔名被略過", () => {
    const dir = fixture("names", {
      "notes.jsonl": { lines: [titleLine("進行中 | 非 id")] },
      [`${uuid(1)}.jsonl`]: { lines: [titleLine("進行中 | 正常")], age: 1 },
      [`${uuid(2)}.txt`]: { lines: [titleLine("進行中 | 副檔名不對")], age: 2 },
    });
    const { json } = run(["--dir", dir]);
    assert.deepEqual(json.sessions.map((s) => s.id), [uuid(1)]);
  });

  test("缺少 --cwd 與 --dir 時 ok:false 且結束碼 1", () => {
    const { status, json } = run([]);
    assert.equal(status, 1);
    assert.equal(json.ok, false);
    assert.equal(typeof json.error, "string");
  });
});
