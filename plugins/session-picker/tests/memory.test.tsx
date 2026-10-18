import { describe, expect, mock, test } from "claude-code/testing";
import type { Engine, Mounted, On } from "claude-code/testing";

type Pane = Mounted<"terminal", "Pane">;
type Band = Mounted<"terminal", "AbovePrompt">;

const SESSION_START = { cwd: "/work", surface: "terminal", isInteractive: true } as const;
const NOW = 1_800_000_000_000;

const PROJECT_PATH = "F:/proj/CLAUDE.md";
const USER_PATH = "C:\\Users\\u\\.claude\\CLAUDE.md";
const MEMORY_DIR = "C:/Users/u/.claude/projects/p/memory";
const MEMORY_INDEX = `${MEMORY_DIR}/MEMORY.md`;
const LINUX_PATH = "/home/u/.claude/rules.md";

type MemoryFile = { path: string; type: string; tokens: number };

const LOADED: MemoryFile[] = [
  { path: PROJECT_PATH, type: "Project", tokens: 1234 },
  { path: USER_PATH, type: "User", tokens: 800 },
  { path: MEMORY_INDEX, type: "AutoMem", tokens: 1966 },
];

type Entry = { name: string; kind: "file" | "dir" | "other" };

const FOLDER: Entry[] = [
  { name: "MEMORY.md", kind: "file" },
  { name: "b-note.md", kind: "file" },
  { name: "a-note.md", kind: "file" },
  { name: "notes.txt", kind: "file" },
  { name: "sub.md", kind: "dir" },
  { name: "archive", kind: "dir" },
];

type World = {
  memoryFiles: MemoryFile[];
  entries: Entry[];
  listedDirs: string[];
  texts: Record<string, string>;
  readError: string;
  usageCalls: number;
  copies: { text: string; surface: string | undefined }[];
  copyResult: { isCopied: true } | { isCopied: false; reason: "no-surface" | "no-clipboard" | "refused" };
  copyThrows: string;
  settle: () => Promise<void>;
};

// 引擎會先把路徑解析成絕對路徑；比對時只看斜線統一後的小寫尾段。
function slash(path: string): string {
  return path.replaceAll("\\", "/");
}

function worldOf(on: On): World {
  const world: World = {
    memoryFiles: LOADED,
    entries: FOLDER,
    listedDirs: [],
    texts: {},
    readError: "",
    usageCalls: 0,
    copies: [],
    copyResult: { isCopied: true },
    copyThrows: "",
    settle: () => Promise.resolve(),
  };
  const clock = mock.clock(on, { now: NOW });
  world.settle = () => clock.settle();
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
  on("session.usage", () => {
    world.usageCalls++;
    return {
      value: {
        startedAt: 0,
        context: { window: 200_000, breakdown: { mcpTools: [], memoryFiles: world.memoryFiles } },
        rateLimits: [],
      },
    } as never;
  });
  on("fs.list", (_$, e) => {
    world.listedDirs.push(slash(e.path));
    return {
      value: world.entries.map((entry) => ({ ...entry, size: 1, mtimeMs: NOW, isLink: false })),
    } as never;
  });
  on("fs.read", (_$, e) => {
    if (world.readError) throw new Error(world.readError);
    const text = world.texts[slash(e.path)];
    if (text === undefined) throw new Error(`ENOENT ${e.path}`);
    return { value: text };
  });
  on("ui.copy", (_$, e) => {
    world.copies.push({ text: e.text, surface: e.surface });
    if (world.copyThrows) throw new Error(world.copyThrows);
    return { value: world.copyResult };
  });
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

async function press(pane: Pane, key: string): Promise<void> {
  await pane.press({ key });
  for (let tick = 0; tick < 30; tick++) await Promise.resolve();
  for (let tick = 0; tick < 5; tick++) await pane.redraw();
}

// 按 band 的「記憶」開面板並顯示記憶分頁。
async function memoryPane($: Engine): Promise<Pane> {
  await $.session.start(SESSION_START);
  const band = await mountBand($);
  await band.press({ key: "band-memory" });
  return mountPane($);
}

describe("記憶分頁：已載入的記憶檔", () => {
  test("band 按「記憶」開啟記憶分頁；列出類型、Windows 反斜線路徑、tokens，標題顯示個數與合計", async ($, on) => {
    const world = worldOf(on);
    const pane = await memoryPane($);

    const shown = await texts(pane);
    expect(shown).toContain("本 session 載入 3 個記憶檔（約 4k tokens）");
    expect(shown).toContain("Project · 1.2k tokens");
    expect(shown).toContain("User · 800 tokens");
    expect(shown).toContain("AutoMem · 2k tokens");
    // C:/ 形式轉成反斜線；本來就是反斜線的不變
    expect(shown).toContain("F:\\proj\\CLAUDE.md");
    expect(shown).toContain("C:\\Users\\u\\.claude\\CLAUDE.md");
    expect(shown).toContain("C:\\Users\\u\\.claude\\projects\\p\\memory\\MEMORY.md");
    expect((await pane.findAll({ type: "Button", key: "tab-memory" }))[0]?.text).toBe("[記憶]");
    expect(await keys(pane)).toEqual([
      "tab-session",
      "tab-tool",
      "tab-mcp",
      "tab-flow",
      "tab-memory",
      "mem-view:0",
      "mem-copy:0",
      "mem-view:1",
      "mem-copy:1",
      "mem-view:2",
      "mem-copy:2",
      "memdir-view:0",
      "memdir-copy:0",
      "memdir-view:1",
      "memdir-copy:1",
      "memory-refresh",
    ]);
    expect(world.usageCalls).toBe(1);
  });

  test("非磁碟代號開頭的路徑原樣顯示；重畫不會再呼叫 session.usage，「重新整理」才會", async ($, on) => {
    const world = worldOf(on);
    world.memoryFiles = [{ path: LINUX_PATH, type: "User", tokens: 5 }];
    const pane = await memoryPane($);

    expect(await texts(pane)).toContain(LINUX_PATH);
    expect(await texts(pane)).toContain("User · 5 tokens");
    await pane.redraw();
    await pane.redraw();
    expect(world.usageCalls).toBe(1);

    await press(pane, "memory-refresh");
    expect(world.usageCalls).toBe(2);
  });
});

describe("記憶分頁：記憶資料夾", () => {
  test("列出 AutoMem 所在資料夾裡未載入的 *.md：排除已載入的 MEMORY.md、非 md 與子目錄，依檔名排序", async ($, on) => {
    const world = worldOf(on);
    const pane = await memoryPane($);

    expect(world.listedDirs).toHaveLength(1);
    expect(world.listedDirs[0]?.endsWith("/.claude/projects/p/memory")).toBe(true);
    const shown = await texts(pane);
    expect(shown).toContain("記憶資料夾（未載入，被引用時才讀）2 個");
    expect(shown.indexOf("a-note.md")).toBeGreaterThan(-1);
    expect(shown.indexOf("a-note.md")).toBeLessThan(shown.indexOf("b-note.md"));
    expect(shown).toContain("C:\\Users\\u\\.claude\\projects\\p\\memory\\a-note.md");
    expect(shown).toContain("C:\\Users\\u\\.claude\\projects\\p\\memory\\b-note.md");
    expect(shown.filter((line) => line.endsWith("MEMORY.md"))).toEqual([
      "C:\\Users\\u\\.claude\\projects\\p\\memory\\MEMORY.md",
    ]);
    expect(shown.some((line) => line.includes("notes.txt") || line.includes("archive") || line.includes("sub.md"))).toBe(
      false,
    );
    expect(shown.some((line) => line.startsWith("還有"))).toBe(false);
  });

  test("超過 30 個只列前 30 個，並顯示「還有 K 個…」", async ($, on) => {
    const world = worldOf(on);
    world.entries = Array.from({ length: 35 }, (_, index) => ({
      name: `f${String(index + 1).padStart(2, "0")}.md`,
      kind: "file" as const,
    }));
    const pane = await memoryPane($);

    const shown = await texts(pane);
    expect(shown).toContain("記憶資料夾（未載入，被引用時才讀）35 個");
    expect(shown).toContain("f01.md");
    expect(shown).toContain("f30.md");
    expect(shown).not.toContain("f31.md");
    expect(shown).toContain("還有 5 個…");
    expect((await keys(pane)).filter((key) => key.startsWith("memdir-view:"))).toHaveLength(30);
  });

  test("已載入清單沒有 AutoMem：不列資料夾（也不呼叫 fs.list），顯示淡色說明", async ($, on) => {
    const world = worldOf(on);
    world.memoryFiles = [{ path: PROJECT_PATH, type: "Project", tokens: 10 }];
    const pane = await memoryPane($);

    expect(world.listedDirs).toEqual([]);
    const shown = await texts(pane);
    expect(shown).toContain("沒有自動記憶（AutoMem）項目，找不到記憶資料夾");
    expect(shown.some((line) => line.startsWith("記憶資料夾"))).toBe(false);
    expect((await keys(pane)).some((key) => key.startsWith("memdir-"))).toBe(false);
  });
});

describe("記憶分頁：看內容", () => {
  test("看內容在面板內顯示路徑與原文（不遮罩）；返回回到清單", async ($, on) => {
    const world = worldOf(on);
    world.texts["F:/proj/CLAUDE.md"] = "# 專案規則\n\napi_key=plain-visible-value\r\n第三行\t縮排";
    const pane = await memoryPane($);

    await press(pane, "mem-view:0");

    const shown = await texts(pane);
    // 分頁列的每個按鈕現在都用有色 Text 畫（S5：Session、Tool、MCP、流程、[記憶]），路徑仍是本文的第一行。
    const tabLabels = ["Session", "Tool", "MCP", "流程", "[記憶]"];
    expect(shown.filter((line) => !tabLabels.includes(line))[0]).toBe("F:\\proj\\CLAUDE.md");
    expect(shown).toContain("# 專案規則");
    expect(shown).toContain("api_key=plain-visible-value");
    expect(shown).toContain("第三行  縮排");
    expect(shown.some((line) => line.startsWith("本 session 載入"))).toBe(false);
    expect(await keys(pane)).toEqual([
      "tab-session",
      "tab-tool",
      "tab-mcp",
      "tab-flow",
      "tab-memory",
      "mem-back",
      "mem-view-copy",
    ]);

    await press(pane, "mem-back");
    expect(await texts(pane)).toContain("本 session 載入 3 個記憶檔（約 4k tokens）");
    expect(await keys(pane)).toContain("mem-view:0");
  });

  test("記憶資料夾的檔案也能看內容", async ($, on) => {
    const world = worldOf(on);
    world.texts[`${MEMORY_DIR}/a-note.md`] = "筆記 A";
    const pane = await memoryPane($);

    await press(pane, "memdir-view:0");

    const shown = await texts(pane);
    expect(shown).toContain("C:\\Users\\u\\.claude\\projects\\p\\memory\\a-note.md");
    expect(shown).toContain("筆記 A");
  });

  test("讀取失敗：顯示「讀取失敗：…」並留在清單", async ($, on) => {
    const world = worldOf(on);
    world.readError = "EACCES: 沒有權限";
    const pane = await memoryPane($);

    await press(pane, "mem-view:1");

    const shown = await texts(pane);
    // 測試掛的 fs.read 丟錯時引擎會跳過它並回報原因；面板把原因接在「讀取失敗：」後面。
    const failure = shown.find((line) => line.startsWith("讀取失敗：")) ?? "";
    expect(failure.length).toBeGreaterThan("讀取失敗：".length);
    expect(shown).toContain("本 session 載入 3 個記憶檔（約 4k tokens）");
    expect(await keys(pane)).toContain("mem-view:1");
    expect(await keys(pane)).not.toContain("mem-back");
  });

  test("內容超過 2000 行時只顯示前 2000 行並註明還有幾行", async ($, on) => {
    const world = worldOf(on);
    world.texts["F:/proj/CLAUDE.md"] = Array.from({ length: 2005 }, (_, index) => `line ${index + 1}`).join("\n");
    const pane = await memoryPane($);

    await press(pane, "mem-view:0");

    const shown = await texts(pane);
    expect(shown).toContain("line 2000");
    expect(shown).not.toContain("line 2001");
    expect(shown).toContain("（內容太長，後面還有 5 行未顯示）");
  });
});

describe("記憶分頁：複製路徑", () => {
  test("複製路徑以 Windows 絕對路徑呼叫 ui.copy（帶按鈕的 surface），成功顯示 ✔", async ($, on) => {
    const world = worldOf(on);
    const pane = await memoryPane($);

    await press(pane, "mem-copy:0");

    expect(world.copies).toEqual([{ text: "F:\\proj\\CLAUDE.md", surface: "terminal" }]);
    expect(await texts(pane)).toContain("✔ 已複製：F:\\proj\\CLAUDE.md");

    await press(pane, "memdir-copy:1");
    expect(world.copies.at(-1)?.text).toBe("C:\\Users\\u\\.claude\\projects\\p\\memory\\b-note.md");
  });

  test("複製失敗顯示原因與路徑；ui.copy 丟錯也一樣", async ($, on) => {
    const world = worldOf(on);
    world.copyResult = { isCopied: false, reason: "no-clipboard" };
    const pane = await memoryPane($);

    await press(pane, "mem-copy:1");
    expect(await texts(pane)).toContain("✘ 複製失敗（no-clipboard）：C:\\Users\\u\\.claude\\CLAUDE.md");

    world.copyThrows = "引擎壞了";
    await press(pane, "mem-copy:0");
    const thrown = (await texts(pane)).find((line) => line.startsWith("✘ 複製失敗（") && line.endsWith("）：F:\\proj\\CLAUDE.md")) ?? "";
    expect(thrown).not.toBe("");
    expect(thrown).not.toContain("no-clipboard");
  });

  test("檢視畫面的「複製路徑」複製正在看的檔案路徑", async ($, on) => {
    const world = worldOf(on);
    world.texts["F:/proj/CLAUDE.md"] = "x";
    const pane = await memoryPane($);
    await press(pane, "mem-view:0");

    await press(pane, "mem-view-copy");

    expect(world.copies.map((copy) => copy.text)).toEqual(["F:\\proj\\CLAUDE.md"]);
    expect(await texts(pane)).toContain("✔ 已複製：F:\\proj\\CLAUDE.md");
  });
});

describe("記憶分頁：不寫檔", () => {
  test("整個流程只讀（session.usage、fs.list、fs.read）與 ui.copy；沒有寫檔或 process.run", async ($, on) => {
    const world = worldOf(on);
    let writes = 0;
    on("fs.write", () => {
      writes++;
      return { value: undefined } as never;
    });
    on("process.run", () => {
      writes++;
      return { value: { stdout: "", stderr: "", exitCode: 0 } } as never;
    });
    world.texts["F:/proj/CLAUDE.md"] = "x";
    const pane = await memoryPane($);

    await press(pane, "mem-view:0");
    await press(pane, "mem-view-copy");
    await press(pane, "mem-back");

    expect(writes).toBe(0);
  });
});
