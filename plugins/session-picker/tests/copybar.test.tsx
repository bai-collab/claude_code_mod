import { describe, expect, test } from "claude-code/testing";
import type { Engine, Mounted, On } from "claude-code/testing";

import { messageKeyOf } from "../hooks/copy-model";

type Reply = Mounted<"terminal", "AssistantMessage">;
type CopyResult = { isCopied: true } | { isCopied: false; reason: "no-surface" | "no-clipboard" | "refused" };

const SESSION_START = { cwd: "/work", surface: "terminal", isInteractive: true } as const;
const ENGINE_DRAWING = "engine drew this reply";
const CHIP_BG = "#FFF3B0";
const CHIP_FG = "#3B3000";

const README = String.raw`F:\vibeCode.v.2026.8.2\projects\claude-session-picker\README.md`;
const NOTES = "C:/Users/u/notes.txt";
const PAGE = "http://127.0.0.1:5181/n5.html";
const REPLY = `改好了：${README}，另見 ${NOTES} 與 ${PAGE}。`;
const REPLY_B = String.raw`第二則回覆放在 D:\out\result.csv 這裡`;
const PLAIN = "這一則沒有任何路徑或網址，只有 12:30 和 F: 兩個不算的東西。";

type World = {
  copies: { text: string; surface: string | undefined }[];
  copyResult: CopyResult;
  copyThrows: string;
  store: Map<string, unknown>;
};

function worldOf(on: On): World {
  const world: World = {
    copies: [],
    copyResult: { isCopied: true },
    copyThrows: "",
    store: new Map<string, unknown>([["autoOpen", false]]),
  };
  on("session.start", (_$, e) => ({ cwd: e.cwd }));
  on("classic.SessionStart", () => ({}));
  on("command.register", () => ({ value: {} }) as never);
  on("store.get", (_$, e) => ({ value: world.store.get(e.key) }));
  on("store.set", (_$, e) => {
    world.store.set(e.key, e.value);
    return { value: undefined };
  });
  on("ui.copy", (_$, e) => {
    world.copies.push({ text: e.text, surface: e.surface });
    if (world.copyThrows) throw new Error(world.copyThrows);
    return { value: world.copyResult };
  });
  // 下層（引擎）的繪製：外掛必須原樣保留它。
  on("ui.render", { component: "AssistantMessage" }, ($, e) => {
    const { Text } = $.ui.resolve(e);
    return <Text>{ENGINE_DRAWING}</Text>;
  });
  return world;
}

function mountReply(
  $: Engine,
  text: string,
  options: { requestId?: string; isSummary?: true } = {},
): Promise<Reply> {
  return $.ui.mount({
    plugin: "session-picker",
    surface: "terminal",
    component: "AssistantMessage",
    ...(options.requestId === undefined ? {} : { requestId: options.requestId }),
    props: { text, isFirstOfReply: true, ...(options.isSummary === true ? { isSummary: true as const } : {}) },
    viewport: { columns: 80, rows: 24 },
  });
}

async function buttonKeys(view: Reply): Promise<string[]> {
  return (await view.findAll({ type: "Button" })).map((button) => button.key ?? "");
}

async function buttonTexts(view: Reply): Promise<string[]> {
  return (await view.findAll({ type: "Button" })).map((button) => button.text);
}

async function texts(view: Reply): Promise<string[]> {
  return (await view.findAll({ type: "Text" })).map((text) => text.text);
}

// 沒有任何目標時外掛原樣回傳引擎的繪製：這就是「未改動」的基準樹。
async function baseline($: Engine): Promise<string> {
  const view = await mountReply($, PLAIN, { requestId: "baseline" });
  const drawn = JSON.stringify(await view.drawn());
  await view.unmount();
  return drawn;
}

function runPanel($: Engine, args: string) {
  return $.command.run({
    command: "panel",
    args,
    origin: { kind: "composer" },
    presentation: { isFullscreen: true, columns: 80 },
  });
}

describe("回覆下方的複製按鈕", () => {
  test("2 個路徑＋1 個網址：引擎繪製原樣保留，下方 3 顆按鈕、標籤正確、key 為 copy:<訊息鍵>:<序號>", async ($, on) => {
    worldOf(on);
    await $.session.start(SESSION_START);
    const plain = await baseline($);

    const view = await mountReply($, REPLY);

    expect(await view.find({ type: "Text", text: ENGINE_DRAWING })).toBeDefined();
    expect(JSON.stringify(await view.drawn()).includes(plain)).toBe(true);
    const key = messageKeyOf(REPLY);
    expect(await buttonKeys(view)).toEqual([`copy:${key}:0`, `copy:${key}:1`, `copy:${key}:2`]);
    expect(await buttonTexts(view)).toEqual(["⧉ README.md", "⧉ notes.txt", "⧉ 127.0.0.1:5181/n5.html"]);
    // 沒有快捷鍵
    const hotkeys = (await view.findAll({ type: "Button" })).map((button) => button.props.hotkey);
    expect(hotkeys.every((hotkey) => hotkey === undefined)).toBe(true);
    // 沒按過就沒有狀態列
    expect((await texts(view)).some((text) => text.startsWith("✔") || text.startsWith("✘"))).toBe(false);
  });

  test("摘要區塊（isSummary）與沒有目標的區塊：回傳的繪製與引擎給的完全相同、沒有按鈕", async ($, on) => {
    worldOf(on);
    await $.session.start(SESSION_START);
    const plain = await baseline($);

    const summary = await mountReply($, REPLY, { isSummary: true, requestId: "summary" });
    const none = await mountReply($, PLAIN, { requestId: "none" });

    expect(JSON.stringify(await summary.drawn())).toBe(plain);
    expect(JSON.stringify(await none.drawn())).toBe(plain);
    expect(await buttonKeys(summary)).toEqual([]);
    expect(await buttonKeys(none)).toEqual([]);
  });

  test("/panel copybar off：不畫按鈕、回傳引擎原繪製；on 之後恢復；設定寫入 store（key copyBar）並回覆確認", async ($, on) => {
    const world = worldOf(on);
    await $.session.start(SESSION_START);
    const plain = await baseline($);

    const off = await runPanel($, "copybar off");
    const hidden = await mountReply($, REPLY, { requestId: "hidden" });

    expect(off.text).toContain("已關閉");
    expect(world.store.get("copyBar")).toBe(false);
    expect(JSON.stringify(await hidden.drawn())).toBe(plain);
    expect(await buttonKeys(hidden)).toEqual([]);

    const back = await runPanel($, "copybar on");
    const shown = await mountReply($, REPLY, { requestId: "shown" });

    expect(back.text).toContain("已開啟");
    expect(world.store.get("copyBar")).toBe(true);
    expect(await buttonKeys(shown)).toHaveLength(3);
  });

  test("session.start 讀 store：copyBar 為 false 時一開始就關；沒設定過時預設開", async ($, on) => {
    const world = worldOf(on);
    world.store.set("copyBar", false);
    await $.session.start(SESSION_START);
    const off = await mountReply($, REPLY, { requestId: "off" });
    expect(await buttonKeys(off)).toEqual([]);

    world.store.delete("copyBar");
    await $.session.start(SESSION_START);
    const dflt = await mountReply($, REPLY, { requestId: "default" });
    expect(await buttonKeys(dflt)).toHaveLength(3);
  });

  test("/panel copybar 參數不合法時回覆用法、不改設定", async ($, on) => {
    const world = worldOf(on);
    await $.session.start(SESSION_START);

    const result = await runPanel($, "copybar maybe");

    expect(result.text).toContain("用法");
    expect(result.text).toContain("copybar");
    expect(world.store.has("copyBar")).toBe(false);
  });

  test("按按鈕：ui.copy 收到訊息裡的原文（不轉斜線）與按鈕的 surface；✔ 狀態只出現在該則訊息下面，且只留最近一筆", async ($, on) => {
    const world = worldOf(on);
    await $.session.start(SESSION_START);
    const a = await mountReply($, REPLY, { requestId: "msg-a" });
    const b = await mountReply($, REPLY_B, { requestId: "msg-b" });

    await a.press({ key: `copy:${messageKeyOf(REPLY)}:1` });

    expect(world.copies).toEqual([{ text: NOTES, surface: "terminal" }]);
    expect(await texts(a)).toContain(`✔ 已複製：${NOTES}`);
    expect((await texts(b)).some((text) => text.startsWith("✔"))).toBe(false);

    await a.press({ key: `copy:${messageKeyOf(REPLY)}:0` });
    expect(world.copies.at(-1)).toEqual({ text: README, surface: "terminal" });
    expect(await texts(a)).toContain(`✔ 已複製：${README}`);
    expect(await texts(a)).not.toContain(`✔ 已複製：${NOTES}`);

    await b.press({ key: `copy:${messageKeyOf(REPLY_B)}:0` });
    expect(world.copies.at(-1)).toEqual({ text: String.raw`D:\out\result.csv`, surface: "terminal" });
    expect(await texts(b)).toContain(String.raw`✔ 已複製：D:\out\result.csv`);
    expect((await texts(a)).some((text) => text.startsWith("✔"))).toBe(false);
  });

  test("複製失敗顯示原因與原文：引擎回 isCopied:false、或 ui.copy 丟錯", async ($, on) => {
    const world = worldOf(on);
    await $.session.start(SESSION_START);
    const view = await mountReply($, REPLY);
    const key = messageKeyOf(REPLY);

    world.copyResult = { isCopied: false, reason: "no-clipboard" };
    await view.press({ key: `copy:${key}:2` });
    const failed = await view.find({ type: "Text", text: `✘ 複製失敗（no-clipboard）：${PAGE}` });
    expect(failed).toBeDefined();
    expect(failed?.props.color).toBe("error");

    world.copyThrows = "boom";
    await view.press({ key: `copy:${key}:0` });
    // 測試的 ui.copy hook 丟錯會被引擎略過（改由引擎的預設結果回覆），所以只確認：仍顯示失敗、帶原文、狀態換成這一筆。
    const thrown =
      (await texts(view)).find((line) => line.startsWith("✘ 複製失敗（") && line.endsWith(`）：${README}`)) ?? "";
    expect(thrown).not.toBe("");
    expect(thrown).not.toContain(PAGE);
    expect(world.copies.at(-1)).toEqual({ text: README, surface: "terminal" });
  });

  test("超過 8 個目標：8 顆按鈕加淡色「還有 K 個」", async ($, on) => {
    worldOf(on);
    await $.session.start(SESSION_START);
    const text = Array.from({ length: 10 }, (_, index) => `https://x.test/page${index}`).join(" ");

    const view = await mountReply($, text);

    expect(await buttonKeys(view)).toHaveLength(8);
    expect((await buttonTexts(view))[7]).toBe("⧉ x.test/page7");
    const more = await view.find({ type: "Text", text: "還有 2 個" });
    expect(more?.props.dimColor).toBe(true);
  });

  test("標籤遮罩但複製原文：token 網址的按鈕只顯示 x.test/cb，按下去複製完整網址", async ($, on) => {
    const world = worldOf(on);
    await $.session.start(SESSION_START);
    const url = "https://x.test/cb?token=abc123def456";
    const text = `請開 ${url} 完成登入`;
    const view = await mountReply($, text);

    expect(await buttonTexts(view)).toEqual(["⧉ x.test/cb"]);
    expect(JSON.stringify(await view.drawn()).includes("abc123def456")).toBe(false);
    await view.press({ key: `copy:${messageKeyOf(text)}:0` });

    expect(world.copies).toEqual([{ text: url, surface: "terminal" }]);
  });

  test("狀態列遮罩但複製原文：token 網址按下去 ui.copy 收完整網址，成功與失敗的狀態列都只顯示 token=***", async ($, on) => {
    const world = worldOf(on);
    await $.session.start(SESSION_START);
    const url = "https://x.test/cb?token=abc123def456";
    const text = `請開 ${url} 完成登入`;
    const view = await mountReply($, text);
    const key = messageKeyOf(text);

    await view.press({ key: `copy:${key}:0` });
    expect(world.copies).toEqual([{ text: url, surface: "terminal" }]);
    const ok = (await texts(view)).find((line) => line.startsWith("✔ 已複製：")) ?? "";
    expect(ok).toContain("token=***");
    expect(ok).not.toContain("abc123def456");

    world.copyResult = { isCopied: false, reason: "no-clipboard" };
    await view.press({ key: `copy:${key}:0` });
    expect(world.copies.at(-1)).toEqual({ text: url, surface: "terminal" });
    const failed = await view.find({ type: "Text", text: "✘ 複製失敗（no-clipboard）：https://x.test/cb?token=***" });
    expect(failed).toBeDefined();
    expect((await texts(view)).some((line) => line.includes("abc123def456"))).toBe(false);
    expect(JSON.stringify(await view.drawn()).includes("abc123def456")).toBe(false);
  });

  test("複製按鈕是淡黃色色塊（#FFF3B0）配深色字（#3B3000）", async ($, on) => {
    worldOf(on);
    await $.session.start(SESSION_START);
    const view = await mountReply($, REPLY);
    const key = messageKeyOf(REPLY);

    for (const [index, label] of ["⧉ README.md", "⧉ notes.txt", "⧉ 127.0.0.1:5181/n5.html"].entries()) {
      const box = await view.find({ type: "Box", key: `copy-chip-${key}-${index}` });
      expect(box?.props.backgroundColor).toBe(CHIP_BG);
      expect((await view.find({ type: "Text", text: label }))?.props.color).toBe(CHIP_FG);
    }
  });
});
