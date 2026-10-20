import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const script = resolve(dirname(fileURLToPath(import.meta.url)), "read-quota.mjs");
const SECRET_TEXT = "對話內容-SECRET-不該輸出";
const SECRET_CMD = "rm -rf /secret-command";
const NOW = new Date(2026, 9, 20, 15, 0, 0).getTime();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// stdout 只能有這幾個頂層欄位。
const ALLOWED_KEYS = ["codex", "codexReason", "agy", "agyReason"];

let root;
before(() => {
  root = mkdtempSync(join(tmpdir(), "quota-"));
});
after(() => rmSync(root, { recursive: true, force: true }));

function limits(pctPrimary, pctSecondary) {
  return {
    limit_id: "codex",
    limit_name: null,
    primary: { used_percent: pctPrimary, window_minutes: 300, resets_at: 1792487265 },
    secondary: { used_percent: pctSecondary, window_minutes: 10080, resets_at: 1792886307 },
    credits: { has_credits: true, balance: "SECRET-CREDITS" },
  };
}

// payload 形式：{timestamp, type, payload:{..., rate_limits}}
function eventLine(rateLimits, extra = {}) {
  return JSON.stringify({
    timestamp: "2026-10-20T04:00:00Z",
    type: "event_msg",
    payload: { type: "token_count", info: { note: SECRET_TEXT }, rate_limits: rateLimits, ...extra },
  });
}

const chat = JSON.stringify({ type: "response_item", payload: { type: "message", text: SECRET_TEXT, command: SECRET_CMD } });

// 在 codex 根目錄下建 YYYY/MM/DD/rollout-*.jsonl；ageSec 越大越舊。
function rollout(base, day, name, lines, ageSec = 0) {
  const [y, m, d] = day.split("-");
  const dir = join(base, y, m, d);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `rollout-${name}.jsonl`);
  writeFileSync(path, `${lines.join("\n")}\n`);
  const t = Date.now() / 1000 - ageSec;
  utimesSync(path, t, t);
  return path;
}

function run(args) {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, json: JSON.parse(result.stdout) };
}

function emptyAgy(name) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("read-quota：Codex", () => {
  test("挑最新的紀錄檔（跨日期目錄），讀檔尾最後一筆 rate_limits；resets_at 轉毫秒，observedAt 是檔案 mtime", () => {
    const base = join(root, "codex-latest");
    rollout(base, "2026-10-19", "old", [eventLine(limits(90, 90))], 86400);
    const newest = rollout(base, "2026-10-20", "new", [eventLine(limits(10, 11)), chat, eventLine(limits(27, 25)), chat], 10);
    const { status, json } = run(["--codex-root", base, "--agy-roots", emptyAgy("none-1")]);
    assert.equal(status, 0);
    assert.deepEqual(json.codex.primary, { pct: 27, windowMinutes: 300, resetsAt: 1792487265 * 1000 });
    assert.deepEqual(json.codex.secondary, { pct: 25, windowMinutes: 10080, resetsAt: 1792886307 * 1000 });
    assert.equal(json.codex.observedAt, Math.floor(statSync(newest).mtimeMs));
    assert.deepEqual(Object.keys(json.codex).sort(), ["observedAt", "primary", "secondary"]);
  });

  test("同時支援頂層 rate_limits 與 payload.rate_limits；null 值的行略過", () => {
    const base = join(root, "codex-shapes");
    rollout(base, "2026-10-20", "a", [JSON.stringify({ rate_limits: limits(5, 6) }), eventLine(null), JSON.stringify({ rate_limits: null })]);
    const { json } = run(["--codex-root", base, "--agy-roots", emptyAgy("none-2")]);
    assert.equal(json.codex.primary.pct, 5);
    assert.equal(json.codex.secondary.pct, 6);
  });

  test("檔尾截斷時第一行不完整：只讀最後 512 KB，丟掉被截斷的第一行，仍找得到檔尾的讀數", () => {
    const base = join(root, "codex-tail");
    const filler = JSON.stringify({ type: "response_item", payload: { text: "x".repeat(1000) } });
    const lines = [eventLine(limits(99, 99))];
    for (let i = 0; i < 700; i += 1) lines.push(filler);
    lines.push(eventLine(limits(42, 43)));
    for (let i = 0; i < 20; i += 1) lines.push(filler);
    rollout(base, "2026-10-20", "big", lines);
    const { json } = run(["--codex-root", base, "--agy-roots", emptyAgy("none-3")]);
    assert.equal(json.codex.primary.pct, 42);
    // 檔案開頭的 99% 在 512 KB 之外，不會被讀到
    assert.notEqual(json.codex.primary.pct, 99);
  });

  test("被截斷的第一行就算含 rate_limits 的殘片也不會被採用（壞 JSON 略過）", () => {
    const base = join(root, "codex-partial");
    const filler = JSON.stringify({ type: "response_item", payload: { text: "y".repeat(1000) } });
    // 最前面一行很長，讓 512 KB 的起點落在這一行中間，且殘片含 "rate_limits"
    const bigFirst = JSON.stringify({ pad: "z".repeat(600 * 1024), payload: { rate_limits: limits(77, 77) } });
    const lines = [bigFirst];
    for (let i = 0; i < 100; i += 1) lines.push(filler);
    rollout(base, "2026-10-20", "partial", lines);
    const { json } = run(["--codex-root", base, "--agy-roots", emptyAgy("none-4")]);
    assert.equal(json.codex, null);
    assert.match(json.codexReason, /讀不到額度/);
  });

  test("最新檔沒有 rate_limits 時往較舊的檔案找（最多再試 5 個）", () => {
    const base = join(root, "codex-older");
    rollout(base, "2026-10-20", "n0", [chat], 1);
    rollout(base, "2026-10-20", "n1", [chat], 2);
    rollout(base, "2026-10-19", "n2", [eventLine(limits(33, 34))], 86400);
    const { json } = run(["--codex-root", base, "--agy-roots", emptyAgy("none-5")]);
    assert.equal(json.codex.primary.pct, 33);

    const far = join(root, "codex-far");
    for (let i = 0; i < 6; i += 1) rollout(far, "2026-10-20", `f${i}`, [chat], i + 1);
    rollout(far, "2026-10-18", "has", [eventLine(limits(1, 2))], 3 * 86400);
    const tooFar = run(["--codex-root", far, "--agy-roots", emptyAgy("none-6")]).json;
    assert.equal(tooFar.codex, null);
    assert.match(tooFar.codexReason, /讀不到額度/);
  });

  test("壞 JSON 行與沒有 rate_limits 的行略過，採用前一筆有效讀數", () => {
    const base = join(root, "codex-bad");
    rollout(base, "2026-10-20", "bad", [eventLine(limits(8, 9)), '{"壞掉 "rate_limits"', "不是 JSON rate_limits", chat]);
    const { status, json } = run(["--codex-root", base, "--agy-roots", emptyAgy("none-7")]);
    assert.equal(status, 0);
    assert.equal(json.codex.primary.pct, 8);
  });

  test("只有 secondary（或 primary）也輸出；兩個都沒有就不算讀數", () => {
    const base = join(root, "codex-single");
    rollout(base, "2026-10-20", "s", [eventLine({ limit_id: "codex", primary: null, secondary: { used_percent: 12, window_minutes: 10080, resets_at: 1792886307 } })]);
    const { json } = run(["--codex-root", base, "--agy-roots", emptyAgy("none-8")]);
    assert.equal(json.codex.primary, undefined);
    assert.equal(json.codex.secondary.pct, 12);
  });

  test("沒有紀錄檔或資料夾不存在：codex 是 null 並附原因，結束碼 0", () => {
    const empty = join(root, "codex-empty");
    mkdirSync(empty, { recursive: true });
    const one = run(["--codex-root", empty, "--agy-roots", emptyAgy("none-9")]);
    assert.equal(one.status, 0);
    assert.equal(one.json.codex, null);
    assert.equal(one.json.codexReason, "找不到 Codex 紀錄檔");

    const two = run(["--codex-root", join(root, "不存在的資料夾"), "--agy-roots", emptyAgy("none-10")]);
    assert.equal(two.status, 0);
    assert.equal(two.json.codex, null);
    assert.equal(two.json.codexReason, "找不到 Codex 紀錄資料夾");
  });
});

describe("read-quota：AGY", () => {
  function brain(name, ages) {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    ages.forEach((age, index) => {
      const sub = join(dir, `conv-${index}`);
      mkdirSync(sub, { recursive: true });
      // 資料夾裡放檔案：不應被讀取或計入
      writeFileSync(join(sub, "log.txt"), SECRET_TEXT);
      const t = (NOW - age) / 1000;
      utimesSync(sub, t, t);
    });
    writeFileSync(join(dir, "stray.txt"), "檔案不算");
    return dir;
  }

  test("今天（本地午夜起）與近 7 天各算子資料夾數；一個資料夾算一次，兩個根目錄加總，單一檔案不算", () => {
    const midnight = new Date(NOW);
    midnight.setHours(0, 0, 0, 0);
    const sinceMidnight = NOW - midnight.getTime();
    const a = brain("agy-a", [HOUR / 2, sinceMidnight + HOUR, 3 * DAY, 8 * DAY]);
    const b = brain("agy-b", [1000, 20 * DAY]);
    const { status, json } = run(["--codex-root", join(root, "x"), "--agy-roots", `${a};${b}`, "--now", String(NOW)]);
    assert.equal(status, 0);
    assert.deepEqual(json.agy, { today: 2, week: 4 });
    assert.equal(json.agyReason, undefined);
  });

  test("其中一個目錄不存在照樣算另一個；都不存在時 agy 是 null 並附原因", () => {
    const a = brain("agy-c", [1000]);
    const one = run(["--codex-root", join(root, "x"), "--agy-roots", `${a};${join(root, "沒有這個目錄")}`, "--now", String(NOW)]);
    assert.deepEqual(one.json.agy, { today: 1, week: 1 });
    const none = run(["--codex-root", join(root, "x"), "--agy-roots", join(root, "沒有這個目錄"), "--now", String(NOW)]);
    assert.equal(none.status, 0);
    assert.equal(none.json.agy, null);
    assert.equal(none.json.agyReason, "找不到 AGY 對話資料夾");
  });
});

describe("read-quota：輸出不洩漏", () => {
  test("stdout 只有規定欄位；不含對話文字、指令、credits、帳號資訊", () => {
    const base = join(root, "codex-leak");
    rollout(base, "2026-10-20", "leak", [chat, eventLine(limits(27, 25), { account: "someone@example.com" }), chat]);
    const a = emptyAgy("agy-leak");
    const result = run(["--codex-root", base, "--agy-roots", a, "--now", String(NOW)]);
    assert.equal(result.status, 0);
    for (const key of Object.keys(result.json)) assert.ok(ALLOWED_KEYS.includes(key), `多餘的欄位：${key}`);
    for (const secret of [SECRET_TEXT, SECRET_CMD, "SECRET-CREDITS", "credits", "someone@example.com", "limit_id", "balance"]) {
      assert.equal(result.stdout.includes(secret), false, `輸出含有：${secret}`);
    }
    assert.equal(result.stderr, "");
  });

  test("沒有任何讀數時的輸出也只有規定欄位；參數錯誤時結束碼 0、只有固定文字", () => {
    const bad = run(["--codex-root"]);
    assert.equal(bad.status, 0);
    for (const key of Object.keys(bad.json)) assert.ok(ALLOWED_KEYS.includes(key));
    assert.equal(bad.json.codex, null);
    const unknown = run(["--nope", "x"]);
    assert.equal(unknown.status, 0);
    assert.equal(unknown.json.codex, null);
  });
});
