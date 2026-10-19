import { describe, expect, mock, test } from "claude-code/testing";
import type { Engine, Mounted, On } from "claude-code/testing";

type Pane = Mounted<"terminal", "Pane">;
type Band = Mounted<"terminal", "AbovePrompt">;

const SESSION_START = { cwd: "/work", surface: "terminal", isInteractive: true } as const;
const COLUMNS = 80;
const ROWS = 30;
const NOW = 1_800_000_000_000;
const SECRET = "sk-ant-SECRET-TOKEN-VALUE";

const TOOLS = [
  { name: "Read", description: "讀取檔案內容\n第二行說明不該出現", mcp: false },
  { name: "Bash", description: "執行 shell 指令", mcp: false },
  { name: "mcp__linear__create_issue", description: "建立 Linear 議題", mcp: true },
];

const MCP_TOOLS = [
  { name: "mcp__linear__a", serverName: "linear", tokens: 10, isLoaded: true },
  { name: "mcp__linear__b", serverName: "linear", tokens: 10, isLoaded: true },
  { name: "mcp__my server__c", serverName: "my server", tokens: 10, isLoaded: true },
];

// 設定檔含不該出現在畫面上的欄位；外掛只能取停用名單。
const CONFIG = JSON.stringify({
  oauthToken: SECRET,
  projects: {
    "/work": {
      disabledMcpServers: ["old-server"],
      mcpServers: { "old-server": { env: { API_KEY: SECRET }, args: [SECRET] } },
    },
    "/other": { disabledMcpServers: ["not-this-project"] },
  },
});

type Opened = { id: string; title: string | undefined; columns: number | undefined };

type World = {
  opened: Opened[];
  commands: { command: string; args: string }[];
  store: Map<string, unknown>;
  mcpError: string;
  openError: string;
  config: string;
  mcpTools: typeof MCP_TOOLS;
  usageCalls: number;
  onMcp: (args: string) => void;
  gate: Promise<void> | undefined;
  tools: typeof TOOLS;
  fsError: string;
  settle: () => Promise<void>;
};

function worldOf(on: On, options: { autoOpen?: boolean } = {}): World {
  const world: World = {
    opened: [],
    commands: [],
    store: new Map<string, unknown>([["autoOpen", options.autoOpen ?? false]]),
    mcpError: "",
    openError: "",
    config: CONFIG,
    mcpTools: MCP_TOOLS,
    usageCalls: 0,
    onMcp: () => {},
    gate: undefined,
    tools: TOOLS,
    fsError: "",
    settle: () => Promise.resolve(),
  };
  const clock = mock.clock(on, { now: NOW });
  world.settle = () => clock.settle();
  mock.env(on, { HOME: "/home/u" });
  on("session.start", (_$, e) => ({ cwd: e.cwd }));
  on("classic.SessionStart", () => ({}));
  on("command.register", () => ({ value: {} }) as never);
  on("store.get", (_$, e) => ({ value: world.store.get(e.key) }));
  on("store.set", (_$, e) => {
    world.store.set(e.key, e.value);
    return { value: undefined };
  });
  on("session.root", () => ({ value: "/work" }));
  on("session.cwd", () => ({ value: "/work" }));
  on("session.id", () => ({ value: "current-session-id" }));
  on("process.run", () =>
    ({ value: { stdout: JSON.stringify({ ok: true, dir: "/t", groups: { open: [], paused: [], closed: [] } }), stderr: "", exitCode: 0 } }) as never,
  );
  on("tool.list", () => ({ value: world.tools }));
  // 下層外掛的 band 內容：我們的 band 必須疊在它上面而不是蓋掉它。
  on("ui.render", { component: "AbovePrompt" }, ($, e) => {
    const { Text } = $.ui.resolve(e);
    return <Text>別的外掛的列</Text>;
  });
  on("session.usage", () => {
    world.usageCalls++;
    return {
      value: {
        startedAt: 0,
        context: { window: 200_000, breakdown: { mcpTools: world.mcpTools } },
        rateLimits: [],
      },
    } as never;
  });
  on("fs.read", () => {
    if (world.fsError) throw new Error(world.fsError);
    return { value: world.config };
  });
  on("ui.open", (_$, e) => {
    if (world.openError) throw new Error(world.openError);
    world.opened.push({ id: e.id, title: e.title, columns: e.columns });
    return { value: { isPlaced: true } };
  });
  on("command.run", { command: "mcp" }, async (_$, e) => {
    world.commands.push({ command: e.command, args: e.args });
    await world.gate;
    if (world.mcpError) throw new Error(world.mcpError);
    world.onMcp(e.args);
    return {};
  });
  return world;
}

function mountBand($: Engine, props: Partial<{ hasSurvey: boolean; bodyColumns: number }> = {}): Promise<Band> {
  return $.ui.mount({
    plugin: "session-picker",
    surface: "terminal",
    component: "AbovePrompt",
    props: {
      hasSurvey: props.hasSurvey ?? false,
      isWorking: false,
      maxRows: 10,
      bodyColumns: props.bodyColumns ?? 100,
      scroll: { offset: 0, bodyRows: 10 },
      view: {},
    },
    viewport: { columns: 100, rows: ROWS, isFullscreen: true },
  });
}

function mountPane($: Engine): Promise<Pane> {
  return $.ui.mount({
    plugin: "session-picker",
    surface: "terminal",
    component: "Pane",
    requestId: "control-panel",
    props: {
      title: "控制台",
      isFocused: true,
      bodyColumns: 44,
      placement: "dock",
      scroll: { offset: 0, bodyRows: ROWS },
      view: {},
    },
    viewport: { columns: COLUMNS, rows: ROWS, isFullscreen: true },
  });
}

async function texts(view: Pane | Band): Promise<string[]> {
  return (await view.findAll({ type: "Text" })).map((text) => text.text);
}

async function keys(view: Pane | Band): Promise<string[]> {
  return (await view.findAll({ type: "Button" })).map((button) => button.key ?? "");
}

async function openedPane($: Engine, world: World, command: "sessions" | "panel", args = ""): Promise<Pane> {
  const result = await $.command.run({
    command,
    args,
    origin: { kind: "composer" },
    presentation: { isFullscreen: true, columns: COLUMNS },
  });
  expect(result.text).toBeUndefined();
  expect(world.opened.at(-1)?.id).toBe("control-panel");
  return mountPane($);
}

describe("按鈕列", () => {
  test("顯示 Session／Tool／MCP／流程／記憶 五個按鈕，且保留下層外掛畫的內容", async ($, on) => {
    worldOf(on);
    await $.session.start(SESSION_START);

    const band = await mountBand($);

    expect(await keys(band)).toEqual(["band-session", "band-tool", "band-mcp", "band-flow", "band-memory"]);
    expect((await band.findAll({ type: "Button" })).map((button) => button.text)).toEqual([
      "Session",
      "Tool",
      "MCP",
      "流程",
      "記憶",
    ]);
    expect(await texts(band)).toContain("別的外掛的列");
    expect(await band.findAll({ type: "Button", key: "band-mcp" })).toHaveLength(1);
    const hotkeys = (await band.findAll({ type: "Button" })).map((button) => button.props.hotkey);
    expect(hotkeys.every((hotkey) => hotkey === undefined)).toBe(true);
  });

  test("問卷占用 band（hasSurvey）時不畫按鈕，原樣交還下層", async ($, on) => {
    worldOf(on);
    await $.session.start(SESSION_START);

    const band = await mountBand($, { hasSurvey: true });

    expect(await keys(band)).toEqual([]);
    expect(await texts(band)).toEqual(["別的外掛的列"]);
  });

  test("band 很窄時省略「控制台」字樣但五個按鈕仍在、仍是一列", async ($, on) => {
    worldOf(on);
    await $.session.start(SESSION_START);

    const band = await mountBand($, { bodyColumns: 16 });

    expect(await keys(band)).toEqual(["band-session", "band-tool", "band-mcp", "band-flow", "band-memory"]);
    expect(await texts(band)).not.toContain("控制台");
    const row = await band.find({ type: "Box", key: "band-row" });
    expect(row?.props.height).toBe(1);
    expect(row?.props.width).toBe(16);
  });

  test("按 band 的 MCP：以 44 欄寬開啟 control-panel，面板顯示 MCP 分頁；/panel 之後回到同一分頁", async ($, on) => {
    const world = worldOf(on);
    await $.session.start(SESSION_START);
    const band = await mountBand($);

    await band.press({ key: "band-mcp" });

    expect(world.opened).toEqual([{ id: "control-panel", title: "控制台", columns: 44 }]);
    const pane = await mountPane($);
    expect(await texts(pane)).toContain("共 3 個 MCP 伺服器");
    await pane.unmount();

    world.opened.length = 0;
    const again = await openedPane($, world, "panel");
    expect(await texts(again)).toContain("共 3 個 MCP 伺服器");
  });
});

// S5（使用者新決定）：所有按鈕固定淡黃色色塊，不再跟 /theme 變；字一律深色。
const CHIP_BG = "#FFF3B0";
const CHIP_FG = "#3B3000";
const CHIP_ACTIVE_BG = "#F2C94C";
const TABS_UNDER_TEST = ["session", "tool", "mcp", "flow", "memory"];

async function boxHolding(view: Pane | Band, boxKey: string, buttonKey: string) {
  const box = await view.find({ type: "Box", key: boxKey });
  const holds = (box?.children ?? []).some(
    (child) => {
      const found = child as { type?: unknown; props?: { key?: unknown } };
      return found.type === "Button" && found.props?.key === buttonKey;
    },
  );
  return { box, holds };
}

describe("按鈕底色（色塊）", () => {
  test("band 的每個按鈕都包在有 backgroundColor 淡黃色 #FFF3B0 的 Box 裡、字是深色 #3B3000；窄寬度仍是一列、五個都在、仍疊在下層外掛的內容上", async ($, on) => {
    worldOf(on);
    await $.session.start(SESSION_START);

    for (const bodyColumns of [100, 16]) {
      const band = await mountBand($, { bodyColumns });

      for (const id of TABS_UNDER_TEST) {
        const { box, holds } = await boxHolding(band, `band-chip-${id}`, `band-${id}`);
        expect(holds).toBe(true);
        expect(box?.props.backgroundColor).toBe(CHIP_BG);
        expect(box?.props.paddingX).toBe(1);
      }
      expect(await keys(band)).toEqual(["band-session", "band-tool", "band-mcp", "band-flow", "band-memory"]);
      for (const label of ["Session", "Tool", "MCP", "流程", "記憶"]) {
        expect((await band.find({ type: "Text", text: label }))?.props.color).toBe(CHIP_FG);
      }
      expect(await texts(band)).toContain("別的外掛的列");
      const row = await band.find({ type: "Box", key: "band-row" });
      expect(row?.props.height).toBe(1);
      expect(row?.props.width).toBe(bodyColumns);
      expect(row?.props.overflow).toBe("hidden");
      await band.unmount();
    }
  });

  test("面板分頁列：使用中的分頁底 #F2C94C、其他分頁底 #FFF3B0（兩者不同），字都是 #3B3000；切換分頁後跟著換", async ($, on) => {
    const world = worldOf(on);
    await $.session.start(SESSION_START);
    const pane = await openedPane($, world, "sessions");

    const fills = async () =>
      Object.fromEntries(
        await Promise.all(
          TABS_UNDER_TEST.map(async (id) => {
            const { box, holds } = await boxHolding(pane, `tab-chip-${id}`, `tab-${id}`);
            expect(holds).toBe(true);
            return [id, String(box?.props.backgroundColor)] as const;
          }),
        ),
      );

    const first = await fills();
    const inactive = new Set(TABS_UNDER_TEST.filter((id) => id !== "session").map((id) => first[id]));
    expect(inactive.size).toBe(1);
    expect([...inactive][0]).toBe(CHIP_BG);
    expect(first.session).toBe(CHIP_ACTIVE_BG);
    expect(first.session).not.toBe([...inactive][0]);
    const activeText = await pane.find({ type: "Text", text: "[Session]" });
    expect(activeText?.props.color).toBe(CHIP_FG);
    expect(activeText?.props.bold).toBe(true);
    expect((await pane.find({ type: "Text", text: "Tool" }))?.props.color).toBe(CHIP_FG);
    expect((await pane.find({ type: "Text", text: "Tool" }))?.props.bold).toBe(false);

    await pane.press({ key: "tab-tool" });
    const second = await fills();
    expect(second.tool).toBe(first.session);
    expect(second.session).toBe([...inactive][0]);
  });

  test("面板內的按鈕（重新整理、session 列、MCP 啟用／停用）用和未使用分頁相同的色塊底色", async ($, on) => {
    const world = worldOf(on);
    await $.session.start(SESSION_START);
    const pane = await openedPane($, world, "sessions");
    const inactive = (await pane.find({ type: "Box", key: "tab-chip-tool" }))?.props.backgroundColor;

    const refresh = await boxHolding(pane, "chip-refresh", "refresh");
    expect(refresh.holds).toBe(true);
    expect(refresh.box?.props.backgroundColor).toBe(inactive);
    expect(inactive).toBe(CHIP_BG);
    expect((await pane.find({ type: "Text", text: "重新整理" }))?.props.color).toBe(CHIP_FG);

    await pane.press({ key: "tab-mcp" });
    const toggle = await pane.find({ type: "Button", text: "停用" });
    expect(toggle?.key).toBe("mcp-toggle-linear");
    const toggleBox = await boxHolding(pane, "chip-mcp-toggle-linear", "mcp-toggle-linear");
    expect(toggleBox.holds).toBe(true);
    expect(toggleBox.box?.props.backgroundColor).toBe(inactive);
  });
});

describe("分頁切換", () => {
  test("分頁按鈕切換 Session／Tool／MCP／流程／記憶，各分頁在顯示時才載入", async ($, on) => {
    const world = worldOf(on);
    await $.session.start(SESSION_START);
    const pane = await openedPane($, world, "sessions");

    expect(await keys(pane)).toEqual([
      "tab-session",
      "tab-tool",
      "tab-mcp",
      "tab-flow",
      "tab-memory",
      "group-open",
      "group-paused",
      "group-closed",
      "refresh",
    ]);
    expect((await pane.findAll({ type: "Button", key: "tab-session" }))[0]?.text).toBe("[Session]");

    await pane.press({ key: "tab-tool" });
    expect(await texts(pane)).toContain("共 3 個工具（內建 2／MCP 1）");
    expect((await pane.findAll({ type: "Button", key: "tab-tool" }))[0]?.text).toBe("[Tool]");
    expect(await keys(pane)).toEqual(["tab-session", "tab-tool", "tab-mcp", "tab-flow", "tab-memory", "tool-refresh"]);

    await pane.press({ key: "tab-mcp" });
    expect(await texts(pane)).toContain("共 3 個 MCP 伺服器");

    await pane.press({ key: "tab-session" });
    expect(await texts(pane)).toContain("沒有未結案的 session");
  });

  test("/sessions 一律開在 Session 分頁", async ($, on) => {
    const world = worldOf(on);
    await $.session.start(SESSION_START);
    const band = await mountBand($);
    await band.press({ key: "band-tool" });

    const pane = await openedPane($, world, "sessions");

    expect(await texts(pane)).toContain("最近 0 個未結案 session");
    expect(await keys(pane)).toContain("refresh");
  });
});

describe("Tool 分頁", () => {
  test("列出工具（只取說明第一行）、MCP 工具分組標示、顯示總數與各組數量", async ($, on) => {
    const world = worldOf(on);
    await $.session.start(SESSION_START);
    const pane = await openedPane($, world, "sessions");

    await pane.press({ key: "tab-tool" });

    const shown = await texts(pane);
    expect(shown).toContain("共 3 個工具（內建 2／MCP 1）");
    expect(shown).toContain("內建（2）");
    expect(shown).toContain("MCP（1）");
    expect(shown).toContain("Read  讀取檔案內容");
    expect(shown).toContain("Bash  執行 shell 指令");
    expect(shown).toContain("mcp__linear__create_issue  建立 Linear 議題");
    expect(shown.some((line) => line.includes("第二行說明"))).toBe(false);
    // 內建在「內建」標題之後、MCP 工具在「MCP」標題之後
    expect(shown.indexOf("內建（2）")).toBeLessThan(shown.indexOf("Read  讀取檔案內容"));
    expect(shown.indexOf("MCP（1）")).toBeLessThan(shown.indexOf("mcp__linear__create_issue  建立 Linear 議題"));
    // 唯讀：除分頁與重新整理外沒有任何動作按鈕
    expect(await keys(pane)).toEqual(["tab-session", "tab-tool", "tab-mcp", "tab-flow", "tab-memory", "tool-refresh"]);
  });

  test("太長的一行依面板欄寬截斷並加省略號", async ($, on) => {
    const world = worldOf(on);
    await $.session.start(SESSION_START);
    world.tools = [{ name: "Long", description: "很長的說明".repeat(20), mcp: false }];
    const pane = await openedPane($, world, "sessions");

    await pane.press({ key: "tab-tool" });

    const line = (await texts(pane)).find((text) => text.startsWith("Long  ")) ?? "";
    expect(line.endsWith("…")).toBe(true);
    expect(line.length).toBeLessThan(44);
  });
});

describe("MCP 分頁", () => {
  test("列出已連線與已停用的伺服器；設定檔其他欄位與別的專案不會出現在畫面", async ($, on) => {
    const world = worldOf(on);
    await $.session.start(SESSION_START);
    const pane = await openedPane($, world, "panel");
    await pane.press({ key: "tab-mcp" });

    const shown = await texts(pane);
    expect(shown).toContain("linear · 已連線 · 2 個工具");
    expect(shown).toContain("old-server · 已停用");
    expect(shown.some((line) => line.includes("not-this-project"))).toBe(false);
    const drawn = JSON.stringify(await pane.drawn());
    expect(drawn.includes(SECRET)).toBe(false);
    expect(drawn.includes("API_KEY")).toBe(false);
    const toggles = await pane.findAll({ type: "Button" });
    expect(toggles.filter((b) => (b.key ?? "").startsWith("mcp-toggle-")).map((b) => [b.key, b.text])).toEqual([
      ["mcp-toggle-linear", "停用"],
      ["mcp-toggle-my server", "停用"],
      ["mcp-toggle-old-server", "啟用"],
    ]);
  });

  test("按「停用」只送出 disable <name>；指令進行中該列標為處理中且沒有按鈕，完成後重新讀取並依新資料重畫", async ($, on) => {
    const world = worldOf(on);
    await $.session.start(SESSION_START);
    const pane = await openedPane($, world, "panel");
    await pane.press({ key: "tab-mcp" });
    // 模擬引擎執行 disable 之後的狀態：linear 沒有工具了，設定檔把它列為停用
    world.onMcp = (args) => {
      if (args !== "disable linear") return;
      world.mcpTools = MCP_TOOLS.filter((tool) => tool.serverName !== "linear");
      world.config = JSON.stringify({ projects: { "/work": { disabledMcpServers: ["old-server", "linear"] } } });
    };
    let release: () => void = () => {};
    world.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const usageBefore = world.usageCalls;

    const pressing = pane.press({ key: "mcp-toggle-linear" });
    for (let tick = 0; tick < 10; tick++) await Promise.resolve();
    const during = await texts(pane);
    const duringKeys = await keys(pane);
    release();
    await pressing;
    await world.settle();

    expect(world.commands).toEqual([{ command: "mcp", args: "disable linear" }]);
    expect(during).toContain("linear · 處理中…");
    expect(duringKeys).not.toContain("mcp-toggle-linear");
    expect(world.usageCalls).toBe(usageBefore + 1);
    const after = await texts(pane);
    expect(after).toContain("linear · 已停用");
    expect(after.some((line) => line.includes("處理中"))).toBe(false);
    expect((await pane.findAll({ type: "Button", key: "mcp-toggle-linear" }))[0]?.text).toBe("啟用");
  });

  test("按「啟用」只送出 enable <name>", async ($, on) => {
    const world = worldOf(on);
    await $.session.start(SESSION_START);
    const pane = await openedPane($, world, "panel");
    await pane.press({ key: "tab-mcp" });

    await pane.press({ key: "mcp-toggle-old-server" });

    expect(world.commands).toEqual([{ command: "mcp", args: "enable old-server" }]);
  });

  test("名稱含空白時不送任何指令，改顯示錯誤列", async ($, on) => {
    const world = worldOf(on);
    await $.session.start(SESSION_START);
    const pane = await openedPane($, world, "panel");
    await pane.press({ key: "tab-mcp" });

    await pane.press({ key: "mcp-toggle-my server" });

    expect(world.commands).toEqual([]);
    const line = await pane.find({ type: "Text", text: /^無法停用/ });
    expect(line?.text).toContain("my server");
    expect(line?.text).toContain("未送出指令");
  });

  test("引擎拒絕 mcp 指令時顯示「MCP 指令失敗：…」並取消處理中標記", async ($, on) => {
    const world = worldOf(on);
    world.mcpError = "mcp 不可用";
    await $.session.start(SESSION_START);
    const pane = await openedPane($, world, "panel");
    await pane.press({ key: "tab-mcp" });

    await pane.press({ key: "mcp-toggle-linear" });

    const line = await pane.find({ type: "Text", text: /^MCP 指令失敗：/ });
    expect(line?.text.length).toBeGreaterThan("MCP 指令失敗：".length);
    expect(line?.text.split("\n")).toHaveLength(1);
    expect(world.commands).toEqual([{ command: "mcp", args: "disable linear" }]);
    expect((await pane.findAll({ type: "Button", key: "mcp-toggle-linear" })).length).toBe(1);
  });

  test("讀不到設定檔時仍列出已連線伺服器，並顯示提示", async ($, on) => {
    const world = worldOf(on);
    await $.session.start(SESSION_START);
    world.fsError = "ENOENT";
    const pane = await openedPane($, world, "panel");

    await pane.press({ key: "tab-mcp" });

    const shown = await texts(pane);
    expect(shown).toContain("linear · 已連線 · 2 個工具");
    expect(shown.some((line) => line.startsWith("未能讀取停用名單"))).toBe(true);
  });
});

describe("自動開啟", () => {
  test("autoOpen 為 true：session.start 與 clear／resume／fork 都開 control-panel（44 欄、不搶焦點）", async ($, on) => {
    const world = worldOf(on, { autoOpen: true });

    await $.session.start(SESSION_START);
    await $.classic.SessionStart({ source: "clear" });
    await $.classic.SessionStart({ source: "resume" });
    await $.classic.SessionStart({ source: "fork" });
    await world.settle();

    expect(world.opened.map((opened) => opened.id)).toEqual([
      "control-panel",
      "control-panel",
      "control-panel",
      "control-panel",
    ]);
    expect(world.opened[0]).toEqual({ id: "control-panel", title: "控制台", columns: 44 });
  });

  test("/panel auto off 寫入 autoOpen=false 並回覆確認；之後新對話不自動開，/panel 仍能手動開", async ($, on) => {
    const world = worldOf(on, { autoOpen: true });
    await $.session.start(SESSION_START);
    await world.settle();
    world.opened.length = 0;

    const off = await $.command.run({
      command: "panel",
      args: "auto off",
      origin: { kind: "composer" },
      presentation: { isFullscreen: true, columns: COLUMNS },
    });
    await $.session.start(SESSION_START);
    await $.classic.SessionStart({ source: "clear" });
    await world.settle();

    expect(world.store.get("autoOpen")).toBe(false);
    expect(off.text).toContain("已關閉");
    expect(world.opened).toEqual([]);

    await openedPane($, world, "panel");
    expect(world.opened).toHaveLength(1);
  });

  test("/panel auto on 寫入 true 並回覆確認；之後的新對話會自動開", async ($, on) => {
    const world = worldOf(on, { autoOpen: false });
    await $.session.start(SESSION_START);
    expect(world.opened).toEqual([]);

    const result = await $.command.run({
      command: "panel",
      args: "auto on",
      origin: { kind: "composer" },
      presentation: { isFullscreen: true, columns: COLUMNS },
    });
    await $.classic.SessionStart({ source: "clear" });
    await world.settle();

    expect(world.store.get("autoOpen")).toBe(true);
    expect(result.text).toContain("已開啟");
    expect(world.opened.map((opened) => opened.id)).toEqual(["control-panel"]);
  });

  test("沒設定過 autoOpen 時預設為開", async ($, on) => {
    const world = worldOf(on);
    world.store.clear();

    await $.session.start(SESSION_START);
    await world.settle();

    expect(world.opened.map((opened) => opened.id)).toEqual(["control-panel"]);
  });

  test("ui.open 被拒絕時 session.start 不丟錯", async ($, on) => {
    const world = worldOf(on, { autoOpen: true });
    world.openError = "寬度不足";

    await $.session.start(SESSION_START);
    await world.settle();

    expect(world.opened).toEqual([]);
  });

  test("/panel 參數不合法時回覆用法、不改設定", async ($, on) => {
    const world = worldOf(on, { autoOpen: true });
    await $.session.start(SESSION_START);
    world.opened.length = 0;

    const result = await $.command.run({
      command: "panel",
      args: "auto maybe",
      origin: { kind: "composer" },
      presentation: { isFullscreen: true, columns: COLUMNS },
    });

    expect(result.text).toContain("用法");
    expect(world.store.get("autoOpen")).toBe(true);
    expect(world.opened).toEqual([]);
  });
});
