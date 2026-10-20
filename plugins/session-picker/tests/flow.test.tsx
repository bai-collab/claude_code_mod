import { describe, expect, mock, test } from "claude-code/testing";
import type { Engine, MockClock, Mounted, On } from "claude-code/testing";

type Pane = Mounted<"terminal", "Pane">;
type Band = Mounted<"terminal", "AbovePrompt">;

const SESSION_START = { cwd: "/work", surface: "terminal", isInteractive: true } as const;
const NOW = 1_800_000_000_000;
const FENCE = "```";
const SECRET = "sk-test-SECRET";
const BRAVE = "mcp__brave-search__brave_web_search";

const PLAN_NEW = [
  "# 新計畫",
  `${FENCE}text`,
  "[A-P0] 宣告級別｜主 agent｜已執行",
  "[A-P1] 實作｜subagent（executor, Sonnet 5.5 high）｜未執行",
  "[A-W1] 沒走到的分支｜主 agent｜未執行（分支未觸發：不需要）",
  "[A-P2] 驗證｜主 agent｜未執行",
  FENCE,
].join("\n");

const PLAN_OLD = [`${FENCE}text`, "[B-P0] 舊計畫節點｜主 agent｜有問題：缺證據", FENCE].join("\n");

type File = { text: string; mtimeMs: number };

type World = {
  clock: MockClock;
  files: Record<string, File>;
  reads: string[];
  readError: string;
  listError: string;
  panes: { id: string }[];
  stored: Map<string, { value: unknown; version: number }>;
  settle: () => Promise<void>;
};

// 引擎會把路徑解析成絕對路徑（Windows 上帶磁碟代號與反斜線）；比對時統一成 /work/... 形式。
function shortPath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^[A-Za-z]:/, "");
}

function worldOf(on: On): World {
  const world: World = {
    clock: mock.clock(on, { now: NOW }),
    files: {
      "new-plan.md": { text: PLAN_NEW, mtimeMs: NOW - 1_000 },
      "old-plan.md": { text: PLAN_OLD, mtimeMs: NOW - 100_000 },
      "older-1.md": { text: PLAN_OLD, mtimeMs: NOW - 200_000 },
      "older-2.md": { text: PLAN_OLD, mtimeMs: NOW - 300_000 },
      "older-3.md": { text: PLAN_OLD, mtimeMs: NOW - 400_000 },
      "oldest-6th.md": { text: PLAN_OLD, mtimeMs: NOW - 500_000 },
    },
    reads: [],
    readError: "",
    listError: "",
    panes: [{ id: "control-panel" }],
    stored: new Map(),
    settle: () => Promise.resolve(),
  };
  const values = world.stored;
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
  on("fs.list", (_$, e) => {
    if (world.listError) throw new Error(world.listError);
    expect(shortPath(e.path)).toBe("/work/planned");
    return {
      value: [
        ...Object.entries(world.files).map(([name, file]) => ({
          name,
          kind: "file" as const,
          size: file.text.length,
          mtimeMs: file.mtimeMs,
          isLink: false,
        })),
        { name: "complete", kind: "dir" as const, size: 0, mtimeMs: 0, isLink: false },
        { name: "notes.txt", kind: "file" as const, size: 3, mtimeMs: NOW, isLink: false },
      ],
    };
  });
  on("fs.read", (_$, e) => {
    world.reads.push(shortPath(e.path));
    if (world.readError) throw new Error(world.readError);
    const name = shortPath(e.path).split("/").pop() ?? "";
    const file = world.files[name];
    if (file === undefined) throw new Error(`ENOENT ${e.path}`);
    return { value: file.text };
  });
  // 下層外掛的 band 內容：我們的 band 必須疊在它上面。
  on("ui.render", { component: "AbovePrompt" }, ($, e) => {
    const { Text } = $.ui.resolve(e);
    return <Text>別的外掛的列</Text>;
  });
  on("turn.start", (_$, e) => ({ turnId: e.turnId }));
  on("turn.complete", (_$, e) => ({ text: e.answer }));
  on("agent.spawn", (_$, e) =>
    e.subagentType === "denied" ? ({ deny: "不准" } as never) : { model: "sonnet", agentId: "agent-1" },
  );
  world.settle = () => world.clock.settle();
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

function mountPane($: Engine, bodyColumns = 80): Promise<Pane> {
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
    viewport: { columns: 120, rows: 60, isFullscreen: true },
  });
}

async function texts(pane: Pane): Promise<string[]> {
  return (await pane.findAll({ type: "Text" })).map((text) => text.text);
}

async function keys(pane: Pane): Promise<string[]> {
  return (await pane.findAll({ type: "Button" })).map((button) => button.key ?? "");
}

async function settle(pane: Pane): Promise<void> {
  for (let tick = 0; tick < 5; tick++) await pane.redraw();
}

// 按下按鈕後等背景的非同步動作（hook 內 void 的工作）跑完、面板重畫。
async function press(pane: Pane, key: string): Promise<void> {
  await pane.press({ key });
  for (let tick = 0; tick < 30; tick++) await Promise.resolve();
  await settle(pane);
}

// 按 band 的「流程」按鈕開面板並顯示流程分頁。
async function flowPane($: Engine, bodyColumns = 80): Promise<Pane> {
  await $.session.start(SESSION_START);
  const band = await mountBand($);
  await band.press({ key: "band-flow" });
  return mountPane($, bodyColumns);
}

let calls = 0;
type ToolInput = Parameters<Engine["tool"]["call"]>[0];

function callTool($: Engine, input: object): ReturnType<Engine["tool"]["call"]> {
  return $.tool.call({ tool_use_id: `call-${++calls}`, ...input } as unknown as ToolInput);
}

function spawnAgent($: Engine, description: string, extra: object = {}): ReturnType<Engine["agent"]["spawn"]> {
  return $.agent.spawn({
    tool_use_id: `spawn-${++calls}`,
    prompt: "do the work",
    description,
    subagentType: "executor",
    provider: "anthropic",
    parentModel: "opus",
    background: false,
    fork: false,
    model: "sonnet",
    ...extra,
  } as never);
}

// 工具呼叫的最底層：Bash 的 FAIL 指令與 brave 工具回傳錯誤；每個呼叫花指定毫秒。
function toolBeneath(on: On, world: World, durations: Record<string, number> = {}): { results: unknown[] } {
  const seen = { results: [] as unknown[] };
  on("tool.call", async (_$, e) => {
    const call = e as unknown as { tool: string; command?: string };
    await world.clock.advance(durations[call.tool] ?? 10);
    const result =
      call.tool === BRAVE || call.command === "FAIL"
        ? { isError: true, result: "boom", text: "boom", ref: 9 }
        : { result: `ok-${call.tool}`, text: `ok-${call.tool}`, ref: 7 };
    seen.results.push(result);
    return result as never;
  });
  return seen;
}

describe("流程分頁：計畫進度", () => {
  test("band 與分頁列都有「流程」；開啟後預設選最新一份，只列 planned/ 直接底下的 *.md 最近 5 份，顯示標題與節點符號", async ($, on) => {
    const world = worldOf(on);
    const pane = await flowPane($);

    expect(world.reads).toEqual(["/work/planned/new-plan.md"]);
    const shown = await texts(pane);
    expect(shown).toContain("計畫進度");
    expect(shown).toContain("計畫：new-plan.md  已執行 1／共 4");
    expect(shown).toContain("✔ A-P0 宣告級別");
    expect(shown).toContain("▶ A-P1 實作 ← 目前");
    expect(shown).toContain("｜subagent（executor, Sonnet 5.5 high）");
    expect(shown).toContain("· A-W1 沒走到的分支（未觸發）");
    expect(shown).toContain("○ A-P2 驗證");
    expect(shown).toContain("1／5");
    expect(await keys(pane)).toEqual([
      "tab-session",
      "tab-tool",
      "tab-mcp",
      "tab-flow",
      "tab-memory",
      "tab-quota",
      "plan-prev",
      "plan-next",
      "flow-refresh",
    ]);
    expect((await pane.findAll({ type: "Button", key: "tab-flow" }))[0]?.text).toBe("[流程]");
  });

  test("‹ › 在最近 5 份之間切換並重讀對應檔案，到頭繞回；第 6 份與子目錄、非 md 檔永遠不出現", async ($, on) => {
    const world = worldOf(on);
    const pane = await flowPane($);

    await press(pane, "plan-next");
    expect(await texts(pane)).toContain("計畫：old-plan.md  已執行 0／共 1");
    expect(await texts(pane)).toContain("✘ B-P0 舊計畫節點（有問題）");
    expect(await texts(pane)).toContain("2／5");

    await press(pane, "plan-prev");
    expect(await texts(pane)).toContain("計畫：new-plan.md  已執行 1／共 4");

    await press(pane, "plan-prev");
    expect(await texts(pane)).toContain("計畫：older-3.md  已執行 0／共 1");
    expect(await texts(pane)).toContain("5／5");

    await press(pane, "plan-next");
    expect(await texts(pane)).toContain("計畫：new-plan.md  已執行 1／共 4");
    expect(world.reads.some((path) => path.includes("oldest-6th") || path.includes("complete") || path.includes("notes"))).toBe(false);
  });

  test("重新整理重讀同一份檔案（內容改變會更新），並保留目前選擇", async ($, on) => {
    const world = worldOf(on);
    const pane = await flowPane($);
    await press(pane, "plan-next");
    const before = world.reads.length;

    world.files["old-plan.md"] = { text: PLAN_OLD.replace("有問題：缺證據", "已執行"), mtimeMs: NOW - 100_000 };
    await press(pane, "flow-refresh");

    expect(world.reads.length).toBe(before + 1);
    expect(world.reads.at(-1)).toBe("/work/planned/old-plan.md");
    expect(await texts(pane)).toContain("計畫：old-plan.md  已執行 1／共 1");
    expect(await texts(pane)).toContain("✔ B-P0 舊計畫節點");
  });

  test("讀檔失敗顯示錯誤行、不丟出，其他區塊仍在；列目錄失敗與沒有計畫書也各有訊息", async ($, on) => {
    const world = worldOf(on);
    world.readError = "EACCES denied";
    const pane = await flowPane($);

    const shown = await texts(pane);
    expect(shown.some((line) => line.startsWith("讀取計畫書失敗：") && line.length > "讀取計畫書失敗：".length)).toBe(true);
    expect(shown).toContain("計畫：new-plan.md  已執行 0／共 0");
    expect(shown).toContain("本 session 即時活動");

    world.listError = "ENOENT planned";
    await press(pane, "flow-refresh");
    expect((await texts(pane)).some((line) => line.startsWith("讀取 planned/ 失敗：") && line.length > "讀取 planned/ 失敗：".length)).toBe(true);
    expect(await keys(pane)).not.toContain("plan-prev");

    world.listError = "";
    world.readError = "";
    world.files = {};
    await press(pane, "flow-refresh");
    expect(await texts(pane)).toContain("planned/ 底下沒有計畫書（*.md）");
  });

  test("沒有任何可辨識節點的計畫書顯示提示", async ($, on) => {
    const world = worldOf(on);
    world.files = { "empty.md": { text: "# 沒有節點", mtimeMs: NOW } };
    const pane = await flowPane($);

    expect(await texts(pane)).toContain("這份計畫書沒有可辨識的節點");
  });

  test("面板開在流程分頁時，主迴圈 turn.complete 會重讀計畫書；subagent 的 turn.complete、面板關閉或別的分頁都不會", async ($, on) => {
    const world = worldOf(on);
    const pane = await flowPane($);
    const before = world.reads.length;
    world.files["new-plan.md"] = { text: PLAN_NEW.replace("實作｜subagent（executor, Sonnet 5.5 high）｜未執行", "實作｜主 agent｜已執行"), mtimeMs: NOW };
    const complete = (extra: object) =>
      $.turn.complete({ answer: "", durationMs: 5, isAborted: false, turnId: "t", reason: "answer", ...extra } as never);

    await complete({ agentId: "sub-1" });
    expect(world.reads.length).toBe(before);

    await complete({});
    expect(world.reads.length).toBe(before + 1);
    await settle(pane);
    expect(await texts(pane)).toContain("▶ A-P2 驗證 ← 目前");

    world.panes = [];
    await complete({});
    expect(world.reads.length).toBe(before + 1);

    world.panes = [{ id: "control-panel" }];
    await press(pane, "tab-tool");
    await complete({});
    expect(world.reads.length).toBe(before + 1);
  });
});

describe("流程分頁：本 session 即時活動", () => {
  test("工具、MCP（失敗）與 subagent 以文字樹顯示，計數與標題正確；結果原樣交還呼叫端", async ($, on) => {
    const world = worldOf(on);
    const seen = toolBeneath(on, world, { Bash: 3200, Read: 40, [BRAVE]: 1100 });
    const pane = await flowPane($);

    await $.turn.start({ text: "做事", turnId: "turn-1" } as never);
    const first = await callTool($, { tool: "Bash", command: "node scripts/review-check.mjs" });
    await spawnAgent($, "寫程式");
    await callTool($, { tool: "Read", file_path: "/work/hooks/register.tsx", agentId: "agent-1" });
    await callTool($, { tool: "Bash", command: "claude plugin test", agentId: "agent-1" });
    const failed = await callTool($, { tool: BRAVE, query: "x" });
    await settle(pane);

    expect(first).toEqual(seen.results[0]);
    expect(failed).toEqual(seen.results[3]);
    const shown = await texts(pane);
    expect(shown).toContain("本 session：工具 4 次（MCP 1）・agent 1 個");
    expect(shown).toContain("第 1 輪 ─┬─ Bash  node scripts/review-check.mjs  3.2s");
    expect(shown).toContain("         ├─ Agent executor（sonnet）─┬─ Read  register.tsx  40ms");
    expect(shown).toContain("         │                           └─ Bash  claude plugin test  3.2s");
    expect(shown).toContain("         └─ MCP brave-search › brave_web_search  1.1s ✘");
    expect(shown.some((line) => line.includes("外掛載入後的活動會顯示在這裡"))).toBe(false);
  });

  test("沒有活動時顯示說明；再按重新整理也不會憑空出現活動", async ($, on) => {
    worldOf(on);
    const pane = await flowPane($);

    const shown = await texts(pane);
    expect(shown).toContain("本 session：工具 0 次（MCP 0）・agent 0 個");
    expect(shown).toContain("外掛載入後的活動會顯示在這裡（載入前的不會補上）");
  });

  test("執行中的工具顯示 …，結束後換成耗時；工具丟錯時呼叫端照樣收到錯誤、該列標 ✘", async ($, on) => {
    const world = worldOf(on);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    on("tool.call", async (_$, e) => {
      const call = e as unknown as { command?: string };
      if (call.command === "THROW") throw new Error("工具壞了");
      await gate;
      return { result: "ok", text: "ok", ref: 1 } as never;
    });
    const pane = await flowPane($);
    await $.turn.start({ text: "x", turnId: "t" } as never);

    const running = callTool($, { tool: "Bash", command: "sleep 9" });
    for (let tick = 0; tick < 10; tick++) await Promise.resolve();
    await settle(pane);
    expect((await texts(pane)).some((line) => line.includes("Bash  sleep 9") && line.endsWith("…"))).toBe(true);
    await world.clock.advance(2500);
    release();
    await running;
    await settle(pane);
    expect((await texts(pane)).some((line) => line.endsWith("Bash  sleep 9  2.5s"))).toBe(true);

    await expect(callTool($, { tool: "Bash", command: "THROW" })).rejects.toThrow();
    await settle(pane);
    expect((await texts(pane)).some((line) => line.includes("Bash  THROW") && line.endsWith("✘"))).toBe(true);
  });

  test("不保存也不顯示輸入全文：超過 60 欄的指令尾端（含假金鑰）與檔案內容都不在畫面與狀態裡", async ($, on) => {
    const world = worldOf(on);
    toolBeneath(on, world);
    const pane = await flowPane($);
    await $.turn.start({ text: "x", turnId: "t" } as never);

    await callTool($, { tool: "Bash", command: `echo ${"a".repeat(70)} ${SECRET}` });
    await callTool($, { tool: "Write", file_path: "/work/secret.txt", content: `內容含 ${SECRET}` });
    await callTool($, { tool: "WebFetch", url: `https://example.com/path?key=${SECRET}`, prompt: "x" });
    await settle(pane);

    const drawn = JSON.stringify(await pane.drawn());
    const state = JSON.stringify([...world.stored.entries()]);
    expect(drawn.includes(SECRET)).toBe(false);
    expect(state.includes(SECRET)).toBe(false);
    const shown = await texts(pane);
    const bashLine = shown.find((line) => line.includes("Bash  echo")) ?? "";
    expect(bashLine.includes("…")).toBe(true);
    expect(shown.some((line) => line.includes("Write  secret.txt"))).toBe(true);
    expect(shown.some((line) => line.includes("WebFetch  example.com"))).toBe(true);
    expect(shown.some((line) => line.includes("內容含"))).toBe(false);
  });

  test("指令裡的金鑰與 --token 值先遮罩再存：畫面與狀態只有 sk-*** 與 --token ***，沒有原值", async ($, on) => {
    const world = worldOf(on);
    toolBeneath(on, world);
    const pane = await flowPane($);
    await $.turn.start({ text: "x", turnId: "t" } as never);

    await callTool($, { tool: "Bash", command: "node run.mjs sk-ant-api03-ABCDEFGHIJKLMNOP --token abc123def456" });
    await spawnAgent($, "用 Bearer abcdef123456 呼叫");
    await settle(pane);

    const drawn = JSON.stringify(await pane.drawn());
    const state = JSON.stringify([...world.stored.entries()]);
    for (const raw of ["sk-ant-api03", "ABCDEFGHIJKLMNOP", "abc123def456", "abcdef123456"]) {
      expect(drawn.includes(raw)).toBe(false);
      expect(state.includes(raw)).toBe(false);
    }
    const shown = await texts(pane);
    const bashLine = shown.find((line) => line.includes("Bash  node run.mjs")) ?? "";
    expect(bashLine).toContain("sk-***");
    expect(bashLine).toContain("--token ***");
    expect(shown.some((line) => line.includes("Bearer ***"))).toBe(true);
  });

  test("最多保留 200 筆（較舊的丟棄），計數照實累計", async ($, on) => {
    const world = worldOf(on);
    toolBeneath(on, world);
    const pane = await flowPane($, 200);
    await $.turn.start({ text: "x", turnId: "t" } as never);

    for (let index = 0; index < 205; index++) {
      await callTool($, { tool: "Bash", command: `echo n${index}x` });
    }
    await settle(pane);

    const shown = await texts(pane);
    expect(shown).toContain("本 session：工具 205 次（MCP 0）・agent 0 個");
    const lines = shown.filter((line) => line.includes("Bash  echo n"));
    expect(lines).toHaveLength(200);
    expect(lines.some((line) => line.includes("echo n0x"))).toBe(false);
    expect(lines.some((line) => line.includes("echo n4x"))).toBe(false);
    expect(lines.some((line) => line.includes("echo n5x"))).toBe(true);
    expect(lines.some((line) => line.includes("echo n204x"))).toBe(true);
  });

  test("/clear（以及 resume、fork）清掉活動並歸零；之後的新活動從第 1 輪重新算", async ($, on) => {
    const world = worldOf(on);
    toolBeneath(on, world);
    const pane = await flowPane($);
    await $.turn.start({ text: "x", turnId: "t" } as never);
    await callTool($, { tool: "Read", file_path: "/a/b.ts" });
    await spawnAgent($, "x");
    await settle(pane);
    expect(await texts(pane)).toContain("本 session：工具 1 次（MCP 0）・agent 1 個");

    await $.classic.SessionStart({ source: "clear" });
    await world.settle();
    await settle(pane);

    expect(await texts(pane)).toContain("本 session：工具 0 次（MCP 0）・agent 0 個");
    expect((await texts(pane)).some((line) => line.includes("Read  b.ts"))).toBe(false);

    await $.turn.start({ text: "y", turnId: "t2" } as never);
    await callTool($, { tool: "Read", file_path: "/a/c.ts" });
    await settle(pane);
    expect((await texts(pane)).some((line) => line.startsWith("第 1 輪") && line.includes("Read  c.ts"))).toBe(true);

    for (const source of ["resume", "fork"] as const) {
      await $.classic.SessionStart({ source });
      await settle(pane);
      expect(await texts(pane)).toContain("本 session：工具 0 次（MCP 0）・agent 0 個");
      await callTool($, { tool: "Read", file_path: "/a/d.ts" });
    }
  });

  test("只算主迴圈的 turn.start；agent.spawn 被拒不留下 agent；Agent 工具本身不重複記成工具", async ($, on) => {
    const world = worldOf(on);
    toolBeneath(on, world);
    const pane = await flowPane($);

    await $.turn.start({ text: "a", turnId: "t1" } as never);
    await $.turn.start({ text: "sub", turnId: "t2", agentId: "agent-1" } as never);
    await $.turn.start({ text: "b", turnId: "t3" } as never);
    await callTool($, { tool: "Read", file_path: "/a.ts" });
    await callTool($, { tool: "Agent", description: "d", prompt: "p" });
    const denied = await spawnAgent($, "被拒", { subagentType: "denied" });
    await settle(pane);

    expect(denied).toEqual({ deny: "不准" });
    const shown = await texts(pane);
    expect(shown).toContain("本 session：工具 1 次（MCP 0）・agent 0 個");
    expect(shown.some((line) => line.startsWith("第 2 輪") && line.includes("Read  a.ts"))).toBe(true);
    expect(shown.some((line) => line.includes("Agent "))).toBe(false);
  });

  test("面板窄（44 欄）時每行不超過欄寬，耗時與 ✘ 仍在", async ($, on) => {
    const world = worldOf(on);
    toolBeneath(on, world, { Bash: 3200 });
    const pane = await flowPane($, 44);
    await $.turn.start({ text: "x", turnId: "t" } as never);

    await callTool($, { tool: "Bash", command: "FAIL" }).catch(() => undefined);
    await callTool($, { tool: "Bash", command: `node scripts/${"very-long-name".repeat(6)}.mjs` });
    await settle(pane);

    const lines = (await texts(pane)).filter((line) => line.includes("Bash"));
    expect(lines).toHaveLength(2);
    for (const line of lines) expect([...line].length).toBeLessThanOrEqual(44);
    expect(lines.some((line) => line.endsWith("3.2s ✘"))).toBe(true);
    expect(lines.some((line) => line.endsWith("3.2s"))).toBe(true);
  });
});

describe("按鈕列", () => {
  test("band 有五個按鈕（Session Tool MCP 流程 記憶）、沒有快捷鍵，且仍疊在下層外掛的內容上", async ($, on) => {
    worldOf(on);
    await $.session.start(SESSION_START);

    const band = await mountBand($);

    const buttons = await band.findAll({ type: "Button" });
    expect(buttons.map((button) => button.key)).toEqual(["band-session", "band-tool", "band-mcp", "band-flow", "band-memory", "band-quota"]);
    expect(buttons.map((button) => button.text)).toEqual(["Session", "Tool", "MCP", "流程", "記憶", "額度"]);
    expect(buttons.every((button) => button.props.hotkey === undefined)).toBe(true);
    expect((await band.findAll({ type: "Text" })).map((text) => text.text)).toContain("別的外掛的列");
  });
});
