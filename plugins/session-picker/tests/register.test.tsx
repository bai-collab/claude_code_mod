import { describe, expect, mock, test } from "claude-code/testing";
import type { Engine, Mounted, On } from "claude-code/testing";

type PickerPane = Mounted<"terminal", "Pane">;

const SESSION_START = { cwd: "/work", surface: "terminal", isInteractive: true } as const;
const COLUMNS = 80;
const ROWS = 24;
const NOW = 1_800_000_000_000;
const ID_A = "11111111-1111-1111-1111-111111111111";
const ID_B = "22222222-2222-2222-2222-222222222222";

type Fixture = { id: string; title: string; mtimeMs: number };

const SESSIONS: Fixture[] = [
  { id: ID_A, title: "進行中 | 博論｜第二章評讀", mtimeMs: NOW - 3 * 60_000 },
  { id: ID_B, title: "進行中｜Harness｜外審收據", mtimeMs: NOW - 5 * 24 * 3_600_000 },
];

type World = {
  argvs: string[][];
  opened: string[];
  registered: string[];
  resumes: { command: string; args: string }[];
  resumeError: string;
  store: Map<string, unknown>;
  next: { stdout: string; stderr: string; exitCode: number };
};

function listJson(sessions: Fixture[]): string {
  return JSON.stringify({ ok: true, dir: "/transcripts", sessions });
}

function worldOf(on: On, sessions: Fixture[] = SESSIONS): World {
  const world: World = {
    argvs: [],
    opened: [],
    registered: [],
    resumes: [],
    resumeError: "",
    store: new Map<string, unknown>([["autoOpen", false]]),
    next: { stdout: listJson(sessions), stderr: "", exitCode: 0 },
  };
  mock.clock(on, { now: NOW });
  on("session.start", (_$, e) => ({ cwd: e.cwd }));
  on("command.register", (_$, e) => {
    world.registered.push(e.name);
    return { value: {} } as never;
  });
  on("store.get", (_$, e) => ({ value: world.store.get(e.key) }));
  on("store.set", (_$, e) => {
    world.store.set(e.key, e.value);
    return { value: undefined };
  });
  on("session.root", () => ({ value: "/work" }));
  on("session.id", () => ({ value: "current-session-id" }));
  on("process.run", (_$, e) => {
    world.argvs.push([...e.argv]);
    return { value: { ...world.next } } as never;
  });
  on("ui.open", (_$, e) => {
    world.opened.push(e.id);
    return { value: { isPlaced: true } };
  });
  on("command.run", { command: "resume" }, (_$, e) => {
    if (world.resumeError) throw new Error(world.resumeError);
    world.resumes.push({ command: e.command, args: e.args });
    return {};
  });
  return world;
}

async function runSessions($: Engine) {
  return $.command.run({
    command: "sessions",
    args: "",
    origin: { kind: "composer" },
    presentation: { isFullscreen: true, columns: COLUMNS },
  });
}

function mountPane($: Engine, isFullscreen = true): Promise<PickerPane> {
  return $.ui.mount({
    plugin: "session-picker",
    surface: "terminal",
    component: "Pane",
    requestId: "control-panel",
    props: {
      title: "控制台",
      isFocused: true,
      bodyColumns: COLUMNS,
      placement: "dock",
      scroll: { offset: 0, bodyRows: ROWS },
      view: {},
    },
    viewport: { columns: COLUMNS, rows: ROWS, isFullscreen },
  });
}

async function buttonTexts(pane: PickerPane): Promise<string[]> {
  return (await pane.findAll({ type: "Button" }))
    .filter((button) => !(button.key ?? "").startsWith("tab-"))
    .map((button) => button.text);
}

describe("未結案 session 外掛", () => {
  test("/sessions 註冊後執行，以正確 argv 讀清單並開啟 control-panel 面板", async ($, on) => {
    const world = worldOf(on);
    await $.session.start(SESSION_START);
    await $.session.start(SESSION_START);
    const result = await runSessions($);

    expect(world.registered).toEqual(["sessions", "panel", "sessions", "panel"]);
    expect(world.opened).toEqual(["control-panel"]);
    expect(result.text).toBeUndefined();
    expect(world.argvs).toHaveLength(1);
    const argv = world.argvs[0] ?? [];
    expect(argv[0]).toBe("node");
    expect(argv[1]?.endsWith("scripts/list-sessions.mjs")).toBe(true);
    expect(argv.slice(2)).toEqual([
      "--cwd",
      "/work",
      "--exclude",
      "current-session-id",
      "--limit",
      "10",
    ]);
  });

  test("面板顯示去掉「進行中」前綴的標題、相對時間與筆數", async ($, on) => {
    worldOf(on);
    await $.session.start(SESSION_START);
    await runSessions($);
    const pane = await mountPane($);

    expect(await buttonTexts(pane)).toEqual([
      "博論｜第二章評讀 · 3 分鐘前",
      "Harness｜外審收據 · 5 天前",
      "重新整理",
    ]);
    expect(await pane.find({ type: "Text", text: "最近 2 個未結案 session" })).toBeDefined();
  });

  test("沒有未結案 session 時顯示空清單訊息", async ($, on) => {
    worldOf(on, []);
    await $.session.start(SESSION_START);
    await runSessions($);
    const pane = await mountPane($);

    expect(await pane.find({ type: "Text", text: "沒有未結案的 session" })).toBeDefined();
    expect(await buttonTexts(pane)).toEqual(["重新整理"]);
  });

  test("過長標題截斷成一行並加省略號", async ($, on) => {
    const long = "進行中 | " + "很長的標題".repeat(10);
    worldOf(on, [{ id: ID_A, title: long, mtimeMs: NOW - 2 * 3_600_000 }]);
    await $.session.start(SESSION_START);
    await runSessions($);
    const pane = await mountPane($);

    const label = (await buttonTexts(pane))[0] ?? "";
    expect(label.endsWith("… · 2 小時前")).toBe(true);
    expect(label.includes("\n")).toBe(false);
    expect(label.split(" · ")[0]?.length).toBeLessThanOrEqual(20);
  });

  test("按下清單列會以該 session id 執行 resume", async ($, on) => {
    const world = worldOf(on);
    await $.session.start(SESSION_START);
    await runSessions($);
    const pane = await mountPane($);

    await pane.press({ key: ID_B });

    expect(world.resumes).toEqual([{ command: "resume", args: ID_B }]);
  });

  test("resume 執行失敗（被引擎拒絕）時面板顯示「切換失敗：…」", async ($, on) => {
    worldOf(on).resumeError = "resume 不可用";
    await $.session.start(SESSION_START);
    await runSessions($);
    const pane = await mountPane($);

    await pane.press({ key: ID_A });

    const line = await pane.find({ type: "Text", text: /^切換失敗：/ });
    expect(line?.text.length).toBeGreaterThan("切換失敗：".length);
  });

  test("process.run 結束碼非 0 時顯示含 stderr 首行的錯誤，且沒有清單列", async ($, on) => {
    const world = worldOf(on);
    world.next = { stdout: "", stderr: "boom first line\nsecond line", exitCode: 1 };
    await $.session.start(SESSION_START);
    await runSessions($);
    const pane = await mountPane($);

    const line = await pane.find({ type: "Text", text: /^讀取 session 清單失敗/ });
    expect(line?.text.includes("boom first line")).toBe(true);
    expect(line?.text.includes("second line")).toBe(false);
    expect(await buttonTexts(pane)).toEqual(["重新整理"]);
  });

  test("process.run 回傳非 JSON 時顯示錯誤", async ($, on) => {
    const world = worldOf(on);
    world.next = { stdout: "not json", stderr: "", exitCode: 0 };
    await $.session.start(SESSION_START);
    await runSessions($);
    const pane = await mountPane($);

    expect(await pane.find({ type: "Text", text: /^讀取 session 清單失敗/ })).toBeDefined();
  });

  test("重新整理會再執行一次 process.run 並更新清單", async ($, on) => {
    const world = worldOf(on);
    await $.session.start(SESSION_START);
    await runSessions($);
    const pane = await mountPane($);
    expect(world.argvs).toHaveLength(1);

    world.next = {
      stdout: listJson([{ id: ID_B, title: "進行中 | 新出現的", mtimeMs: NOW - 10 * 60_000 }]),
      stderr: "",
      exitCode: 0,
    };
    await pane.press({ key: "refresh" });

    expect(world.argvs).toHaveLength(2);
    expect(await buttonTexts(pane)).toEqual(["新出現的 · 10 分鐘前", "重新整理"]);
  });

  test("主畫面模式顯示鍵盤操作提示", async ($, on) => {
    worldOf(on);
    await $.session.start(SESSION_START);
    await runSessions($);
    const pane = await mountPane($, false);

    expect(await pane.find({ type: "Text", text: /主畫面模式不回報滑鼠點擊/ })).toBeDefined();
  });
});
