import { describe, expect, mock, test } from "claude-code/testing";
import type { Engine, Mounted, On } from "claude-code/testing";

type Pane = Mounted<"terminal", "Pane">;
type Band = Mounted<"terminal", "AbovePrompt">;

const SESSION_START = { cwd: "/work", surface: "terminal", isInteractive: true } as const;
const NOW = 1_800_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;
const HOME = "C:/Users/u";
const HISTORY_TAIL = "/.claude/plugin-data/session-picker/quota-history.json";
const WEEK_RESET = NOW + 2 * 24 * HOUR;
const FIVE_RESET = NOW + 3 * HOUR;

type Limit = { kind: string; percentUsed: number; resetsAt?: string };
type Script = { exitCode: number; stdout: string; stderr: string };

type World = {
  limits: Limit[];
  usageThrows: string;
  usageCalls: number;
  files: Record<string, string>;
  readError: string;
  writeError: string;
  writes: { path: string; text: string }[];
  argvs: string[][];
  script: Script;
  panes: { id: string }[];
  clock: ReturnType<typeof mock.clock>;
};

function slash(path: string): string {
  return path.replaceAll("\\", "/");
}

// 歷史檔只認尾段（引擎會先把路徑解析成絕對路徑）。
function historyKey(path: string): string | undefined {
  return slash(path).endsWith(HISTORY_TAIL) ? "history" : undefined;
}

const CODEX_STDOUT = JSON.stringify({
  codex: {
    primary: { pct: 27, windowMinutes: 300, resetsAt: FIVE_RESET },
    secondary: { pct: 25, windowMinutes: 10080, resetsAt: WEEK_RESET },
    observedAt: NOW - 12 * MIN,
  },
  agy: { today: 3, week: 11 },
});

function worldOf(on: On, env: Record<string, string> = { HOME }): World {
  const world: World = {
    limits: [],
    usageThrows: "",
    usageCalls: 0,
    files: {},
    readError: "",
    writeError: "",
    writes: [],
    argvs: [],
    script: { exitCode: 0, stdout: CODEX_STDOUT, stderr: "" },
    panes: [{ id: "control-panel" }],
    clock: mock.clock(on, { now: NOW }),
  };
  mock.env(on, env);
  const values = new Map<string, { value: unknown; version: number }>();
  on("session.start", (_$, e) => ({ cwd: e.cwd }));
  on("classic.SessionStart", () => ({}));
  on("command.register", () => ({ value: {} }) as never);
  on("store.get", () => ({ value: false }));
  on("session.root", () => ({ value: "/work" }));
  on("session.cwd", () => ({ value: "/work" }));
  on("state.get", (_$, e) => ({ value: values.get(e.key) ?? { value: undefined, version: 0 } }));
  on("state.set", (_$, e) => {
    const version = (values.get(e.key)?.version ?? 0) + 1;
    values.set(e.key, { value: e.value, version });
    return { value: { isSet: true, version } };
  });
  on("ui.open", () => ({ value: { isPlaced: true } }));
  on("ui.panes", () => ({ value: world.panes }) as never);
  on("session.usage", () => {
    world.usageCalls++;
    if (world.usageThrows) throw new Error(world.usageThrows);
    return { value: { startedAt: 0, context: { window: 200_000 }, rateLimits: world.limits } } as never;
  });
  on("fs.exists", (_$, e) => {
    const key = historyKey(e.path);
    return { value: key !== undefined && world.files[key] !== undefined };
  });
  on("fs.read", (_$, e) => {
    if (world.readError) throw new Error(world.readError);
    const key = historyKey(e.path);
    const text = key === undefined ? undefined : world.files[key];
    if (text === undefined) throw new Error(`ENOENT ${e.path}`);
    return { value: text };
  });
  on("fs.write", (_$, e) => {
    if (world.writeError) throw new Error(world.writeError);
    world.writes.push({ path: slash(e.path), text: e.text });
    const key = historyKey(e.path);
    if (key !== undefined) world.files[key] = e.text;
    return { value: undefined };
  });
  on("process.run", (_$, e) => {
    world.argvs.push([...e.argv]);
    return { value: { ...world.script } } as never;
  });
  on("turn.complete", (_$, e) => ({ text: e.answer }));
  on("ui.render", { component: "AbovePrompt" }, ($, e) => {
    const { Text } = $.ui.resolve(e);
    return <Text>別的外掛的列</Text>;
  });
  return world;
}

function mountBand($: Engine): Promise<Band> {
  return $.ui.mount({
    plugin: "session-picker",
    surface: "terminal",
    component: "AbovePrompt",
    props: {
      hasSurvey: false,
      isWorking: false,
      maxRows: 10,
      bodyColumns: 100,
      scroll: { offset: 0, bodyRows: 10 },
      view: {},
    },
    viewport: { columns: 100, rows: 30, isFullscreen: true },
  });
}

function mountPane($: Engine, bodyColumns = 120): Promise<Pane> {
  return $.ui.mount({
    plugin: "session-picker",
    surface: "terminal",
    component: "Pane",
    requestId: "control-panel",
    props: {
      title: "控制台",
      isFocused: true,
      bodyColumns,
      placement: "dock",
      scroll: { offset: 0, bodyRows: 60 },
      view: {},
    },
    viewport: { columns: 160, rows: 60, isFullscreen: true },
  });
}

async function texts(pane: Pane): Promise<string[]> {
  return (await pane.findAll({ type: "Text" })).map((text) => text.text);
}

// 以開頭找一行 Text，回傳文字與顏色。
async function rowOf(pane: Pane, prefix: string): Promise<{ text: string; color: unknown } | undefined> {
  const found = (await pane.findAll({ type: "Text" })).find((node) => node.text.startsWith(prefix));
  return found === undefined ? undefined : { text: found.text, color: found.props.color };
}

async function keys(pane: Pane): Promise<string[]> {
  return (await pane.findAll({ type: "Button" })).map((button) => button.key ?? "");
}

async function settle(pane: Pane): Promise<void> {
  for (let tick = 0; tick < 30; tick++) await Promise.resolve();
  for (let tick = 0; tick < 5; tick++) await pane.redraw();
}

async function press(pane: Pane, key: string): Promise<void> {
  await pane.press({ key });
  await settle(pane);
}

async function quotaPane($: Engine, bodyColumns?: number): Promise<Pane> {
  await $.session.start(SESSION_START);
  const band = await mountBand($);
  await band.press({ key: "band-quota" });
  return mountPane($, bodyColumns);
}

function complete($: Engine, extra: object = {}) {
  return $.turn.complete({ answer: "好", durationMs: 5, isAborted: false, turnId: "t", reason: "answer", ...extra } as never);
}

function weekLimit(pct: number): Limit {
  return { kind: "seven_day", percentUsed: pct, resetsAt: new Date(WEEK_RESET).toISOString() };
}

function samplesOf(text: string): Record<string, unknown>[] {
  return (JSON.parse(text) as { samples: Record<string, unknown>[] }).samples;
}

describe("額度分頁：顯示", () => {
  test("band 與分頁列都有「額度」；開啟時跑讀取腳本，顯示 Codex 讀數、最後更新與 AGY 使用次數", async ($, on) => {
    const world = worldOf(on);
    const pane = await quotaPane($);

    expect(world.argvs).toHaveLength(1);
    expect(world.argvs[0]![0]).toBe("node");
    expect(slash(world.argvs[0]![1]!).endsWith("/scripts/read-quota.mjs")).toBe(true);
    expect(world.argvs[0]).toHaveLength(2);

    const shown = await texts(pane);
    expect(shown).toContain("額度預測");
    expect(shown).toContain("  還沒有讀數（Claude 要回覆過一次才有）");
    expect(shown).toContain("Codex　最後更新 12 分鐘前");
    const weekRow = await rowOf(pane, "  週用量 ");
    expect(weekRow?.text).toMatch(/^ {2}週用量 [█░│]+ 25% 資料不足$/);
    expect(weekRow?.color).toBe("success");
    const fiveRow = await rowOf(pane, "  5 小時 ");
    expect(fiveRow?.text).toMatch(/^ {2}5 小時 [█░│]+ 27% 資料不足$/);
    expect(fiveRow?.color).toBe("success");
    expect(shown.some((line) => line.includes("根據") || line.includes("重置 "))).toBe(false);
    expect(shown).toContain("AGY　無額度與 token 資料");
    expect(shown).toContain("  使用次數：今天 3｜近 7 天 11（依本機對話資料夾）");
    expect((await pane.findAll({ type: "Button", key: "tab-quota" }))[0]?.text).toBe("[額度]");
    expect(await keys(pane)).toEqual([
      "tab-session",
      "tab-tool",
      "tab-mcp",
      "tab-flow",
      "tab-memory",
      "tab-quota",
      "quota-refresh",
    ]);
  });

  test("重新整理（r）再跑一次腳本；Codex 讀數寫進歷史檔，只有五個欄位", async ($, on) => {
    const world = worldOf(on);
    const pane = await quotaPane($);
    expect(world.writes).toHaveLength(1);
    expect(world.writes[0]!.path.endsWith(HISTORY_TAIL)).toBe(true);
    const rows = samplesOf(world.writes[0]!.text);
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(Object.keys(row).sort()).toEqual(["at", "pct", "resetsAt", "source", "window"]);
    expect(world.writes[0]!.text).not.toContain("agy");

    await press(pane, "quota-refresh");
    expect(world.argvs).toHaveLength(2);
    expect((await pane.findAll({ type: "Button", key: "quota-refresh" }))[0]?.props.hotkey).toBe("r");
  });

  test("腳本結束碼非 0：顯示含 stderr 首行的錯誤，其他區塊照常", async ($, on) => {
    const world = worldOf(on);
    world.script = { exitCode: 1, stdout: "", stderr: "boom\nsecond" };
    const pane = await quotaPane($);

    const shown = await texts(pane);
    expect(shown).toContain("讀取 Codex／AGY 失敗（結束碼 1）：boom");
    expect(shown).toContain("  還沒有讀數");
    expect(shown).toContain("Claude");
    expect(world.writes).toHaveLength(0);
  });

  test("腳本輸出格式不符、或腳本回報讀不到：各自顯示原因", async ($, on) => {
    const world = worldOf(on);
    world.script = { exitCode: 0, stdout: "not json", stderr: "" };
    const pane = await quotaPane($);
    expect(await texts(pane)).toContain("讀取 Codex／AGY 失敗（回應格式不符）");

    world.script = {
      exitCode: 0,
      stdout: JSON.stringify({ codex: null, codexReason: "找不到紀錄檔", agy: null, agyReason: "目錄不存在" }),
      stderr: "",
    };
    await press(pane, "quota-refresh");
    const shown = await texts(pane);
    expect(shown).toContain("  讀不到：找不到紀錄檔");
    expect(shown).toContain("  讀不到：目錄不存在");
    expect(shown.some((line) => line.startsWith("讀取 Codex／AGY 失敗"))).toBe(false);
  });

  test("歷史檔讀取失敗或格式不符：只顯示一行淡色說明，讀數照常顯示", async ($, on) => {
    const world = worldOf(on);
    world.files.history = "{壞掉";
    const pane = await quotaPane($);
    const shown = await texts(pane);
    expect(shown).toContain("歷史檔格式不符，改用本次記錄重建");
    expect(shown).toContain("Codex　最後更新 12 分鐘前");

    world.readError = "EACCES";
    await press(pane, "quota-refresh");
    expect((await texts(pane)).some((line) => line.startsWith("讀取歷史檔失敗：") || line.startsWith("寫入歷史檔失敗："))).toBe(true);
  });
});

describe("額度分頁：Claude 取樣與預測", () => {
  test("主迴圈 turn.complete 記一筆 Claude 讀數並寫歷史檔；subagent 的不取樣；結果原樣交還", async ($, on) => {
    const world = worldOf(on);
    await $.session.start(SESSION_START);
    world.limits = [weekLimit(60)];

    expect(await complete($, { agentId: "sub-1" })).toEqual({ text: "好" });
    expect(world.usageCalls).toBe(0);

    expect(await complete($)).toEqual({ text: "好" });
    expect(world.usageCalls).toBe(1);
    expect(world.writes).toHaveLength(1);
    expect(world.writes[0]!.path).toBe(`${HOME}${HISTORY_TAIL}`);
    expect(samplesOf(world.writes[0]!.text)).toEqual([
      { source: "claude", window: "seven_day", pct: 60, resetsAt: WEEK_RESET, at: NOW },
    ]);
  });

  test("兩次寫檔至少隔 2 分鐘；寫前先讀檔合併，其他 session 的讀數不會被蓋掉", async ($, on) => {
    const world = worldOf(on);
    world.files.history = JSON.stringify({
      samples: [{ source: "codex", window: "seven_day", pct: 10, resetsAt: WEEK_RESET, at: NOW - HOUR }],
    });
    await $.session.start(SESSION_START);

    world.limits = [weekLimit(60)];
    await complete($);
    expect(world.writes).toHaveLength(1);

    await world.clock.advance(MIN);
    world.limits = [weekLimit(61)];
    await complete($);
    expect(world.writes).toHaveLength(1);

    await world.clock.advance(29 * MIN);
    world.limits = [weekLimit(63)];
    await complete($);
    expect(world.writes).toHaveLength(2);
    const rows = samplesOf(world.writes[1]!.text);
    expect(rows.map((row) => `${String(row.source)}:${String(row.pct)}`)).toEqual(["codex:10", "claude:60", "claude:61", "claude:63"]);
  });

  test("累積到跨 30 分鐘後，額度分頁顯示速度與重置前會到 95% 的警示", async ($, on) => {
    const world = worldOf(on);
    world.script = { exitCode: 0, stdout: JSON.stringify({ codex: null, codexReason: "沒有讀數", agy: { today: 0, week: 0 } }), stderr: "" };
    await $.session.start(SESSION_START);
    world.limits = [weekLimit(60)];
    await complete($);
    await world.clock.advance(30 * MIN);
    world.limits = [weekLimit(63)];
    await complete($);

    const band = await mountBand($);
    await band.press({ key: "band-quota" });
    const pane = await mountPane($);
    const shown = await texts(pane);
    expect(shown.some((line) => line.startsWith("  週用量 "))).toBe(true);
    const claude = await rowOf(pane, "  週用量 ");
    expect(claude?.text).toMatch(/^ {2}週用量 [█░│]+ 63% ⚠5\.3時後95%$/);
    expect(claude?.color).toBe("success");
  });

  test("百分比 ≥70 用 warning、≥95 用 error 顏色，已達 95% 時行尾是「已達95%」", async ($, on) => {
    const world = worldOf(on);
    world.script = { exitCode: 0, stdout: JSON.stringify({ codex: null, codexReason: "沒有讀數", agy: null }), stderr: "" };
    await $.session.start(SESSION_START);
    world.limits = [weekLimit(75)];
    await complete($);
    const band = await mountBand($);
    await band.press({ key: "band-quota" });
    const pane = await mountPane($);
    const warn = await rowOf(pane, "  週用量 ");
    expect(warn?.text).toMatch(/ 75% 資料不足$/);
    expect(warn?.color).toBe("warning");

    world.limits = [weekLimit(96)];
    await complete($);
    await press(pane, "quota-refresh");
    const high = await rowOf(pane, "  週用量 ");
    expect(high?.text).toMatch(/ 96% 已達95%$/);
    expect(high?.color).toBe("error");
  });

  test("面板開在額度分頁時 turn.complete 會重跑腳本；面板關閉或別的分頁不會", async ($, on) => {
    const world = worldOf(on);
    const pane = await quotaPane($);
    const before = world.argvs.length;

    await complete($);
    expect(world.argvs.length).toBe(before + 1);

    world.panes = [];
    await complete($);
    expect(world.argvs.length).toBe(before + 1);

    world.panes = [{ id: "control-panel" }];
    await press(pane, "tab-tool");
    await complete($);
    expect(world.argvs.length).toBe(before + 1);
  });

  test("額度視窗是空的：顯示「此帳號沒有額度視窗」，也不碰歷史檔", async ($, on) => {
    const world = worldOf(on);
    world.script = { exitCode: 0, stdout: JSON.stringify({ codex: null, agy: null }), stderr: "" };
    await $.session.start(SESSION_START);
    world.limits = [];
    await complete($);
    expect(world.writes).toHaveLength(0);

    const band = await mountBand($);
    await band.press({ key: "band-quota" });
    const pane = await mountPane($);
    expect(await texts(pane)).toContain("  此帳號沒有額度視窗");
  });

  test("session.usage 丟錯或寫檔失敗都不影響 turn：結果照常交還", async ($, on) => {
    const world = worldOf(on);
    await $.session.start(SESSION_START);
    world.usageThrows = "no usage";
    expect(await complete($)).toEqual({ text: "好" });
    expect(world.writes).toHaveLength(0);

    world.usageThrows = "";
    world.limits = [weekLimit(50)];
    world.writeError = "EROFS";
    expect(await complete($)).toEqual({ text: "好" });
  });

  test("有 CLAUDE_CONFIG_DIR 時歷史檔放在它底下", async ($, on) => {
    const world = worldOf(on, { CLAUDE_CONFIG_DIR: "D:/cfg", HOME });
    await $.session.start(SESSION_START);
    world.limits = [weekLimit(40)];
    await complete($);
    expect(world.writes[0]?.path).toBe("D:/cfg/plugin-data/session-picker/quota-history.json");
  });
});
