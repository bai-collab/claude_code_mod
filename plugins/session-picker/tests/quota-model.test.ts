import { describe, expect, test } from "claude-code/testing";

import {
  addSample,
  agoLabel,
  claudeSamples,
  clockLabel,
  codexSamples,
  currentCycle,
  forecastOf,
  mergeHistory,
  parseHistory,
  parseScriptOutput,
  quotaBarLine,
  serializeHistory,
  trimHistory,
} from "../hooks/quota-model";
import { textWidth } from "../hooks/flow-model";
import type { Sample } from "../hooks/quota-model";

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// 所有時間都是毫秒數；與時區無關。
const T0 = 1_800_000_000_000;
const RESET = T0 + 3 * DAY;

function week(pct: number, atMs: number, resetsAt = RESET, source: Sample["source"] = "claude"): Sample {
  return { source, window: "seven_day", pct, resetsAt, at: atMs };
}

function five(pct: number, atMs: number, resetsAt = T0 + 4 * HOUR): Sample {
  return { source: "claude", window: "five_hour", pct, resetsAt, at: atMs };
}

describe("週期分段", () => {
  test("resetsAt 改變就是新週期，舊資料不參與；相差 ≤120 秒算同一週期", () => {
    const samples = [week(50, T0), week(55, T0 + HOUR), week(2, T0 + 2 * HOUR, RESET + 7 * DAY), week(3, T0 + 3 * HOUR, RESET + 7 * DAY + 100_000)];
    expect(currentCycle(samples, "claude", "seven_day").map((s) => s.pct)).toEqual([2, 3]);
    const jitter = [week(50, T0), week(52, T0 + HOUR, RESET + 120_000), week(54, T0 + 2 * HOUR, RESET)];
    expect(currentCycle(jitter, "claude", "seven_day")).toHaveLength(3);
  });

  test("pct 下降 ≥5 點是新週期，下降不到 5 點不算", () => {
    const dropped = [week(60, T0), week(70, T0 + HOUR), week(65, T0 + 2 * HOUR), week(66, T0 + 3 * HOUR)];
    expect(currentCycle(dropped, "claude", "seven_day").map((s) => s.pct)).toEqual([65, 66]);
    const small = [week(60, T0), week(56, T0 + HOUR), week(57, T0 + 2 * HOUR)];
    expect(currentCycle(small, "claude", "seven_day")).toHaveLength(3);
  });

  test("只取同來源、同視窗，並依時間排序", () => {
    const samples = [week(30, T0 + HOUR), five(10, T0), week(20, T0), week(5, T0, RESET, "codex")];
    expect(currentCycle(samples, "claude", "seven_day").map((s) => s.pct)).toEqual([20, 30]);
    expect(currentCycle(samples, "codex", "seven_day").map((s) => s.pct)).toEqual([5]);
    expect(currentCycle([], "claude", "five_hour")).toEqual([]);
  });
});

describe("速度與預測", () => {
  test("沒有樣本回傳 undefined；只有一筆或跨度不到 10 分鐘＝資料不足（span），不給速度", () => {
    expect(forecastOf([], T0)).toBeUndefined();
    const one = forecastOf([week(40, T0)], T0)!;
    expect(one.insufficient).toBe("span");
    expect(one.ratePerHour).toBeUndefined();
    expect(one.hours95).toBeUndefined();
    const short = forecastOf([week(40, T0), week(45, T0 + 9 * MIN)], T0 + 9 * MIN)!;
    expect(short.insufficient).toBe("span");
    expect(short.ratePerHour).toBeUndefined();
  });

  test("跨度夠但沒有上升到 1 點＝資料不足（flat）", () => {
    const flat = forecastOf([week(40, T0), week(40.5, T0 + HOUR)], T0 + HOUR)!;
    expect(flat.insufficient).toBe("flat");
    expect(flat.ratePerHour).toBeUndefined();
  });

  test("eta：速度 = Δpct／Δ小時，到 95%、100% 的小時數；重置前判斷", () => {
    // 2 小時上升 4 點 → 每小時 2；目前 60% → 95% 還要 17.5 小時、100% 要 20 小時
    const now = T0 + 2 * HOUR;
    const f = forecastOf([week(56, T0), week(58, T0 + HOUR), week(60, now)], now)!;
    expect(Math.abs((f.ratePerHour!) - (2)) < 1e-9).toBe(true);
    expect(Math.abs((f.hours95!) - (17.5)) < 1e-9).toBe(true);
    expect(Math.abs((f.hours100!) - (20)) < 1e-9).toBe(true);
    expect(f.count).toBe(3);
    expect(f.spanMs).toBe(2 * HOUR);
    expect(f.beforeReset).toBe(true);
    expect(f.beforeReset100).toBe(true);

    // 同樣速度，重置時間在 10 小時後 → 重置前不會到 95%
    const later = forecastOf([week(56, T0, now + 10 * HOUR), week(60, now, now + 10 * HOUR)], now)!;
    expect(later.beforeReset).toBe(false);
    expect(later.beforeReset100).toBe(false);
  });

  test("已 ≥95 顯示已達、不再給 eta；已 ≥100 另記", () => {
    const now = T0 + HOUR;
    const at95 = forecastOf([week(90, T0), week(96, now)], now)!;
    expect(at95.reached).toBe(95);
    expect(at95.hours95).toBeUndefined();
    expect(at95.beforeReset).toBeUndefined();
    expect(forecastOf([week(97, T0), week(100, now)], now)!.reached).toBe(100);
    expect(forecastOf([week(10, T0), week(20, now)], now)!.reached).toBe(0);
  });

  test("回看範圍：週用量 6 小時、5 小時用量 60 分鐘；更舊的樣本不參與速度", () => {
    const now = T0 + 8 * HOUR;
    const old = [week(10, T0), week(30, T0 + 1 * HOUR), week(31, T0 + 3 * HOUR), week(33, now)];
    const f = forecastOf(old, now)!;
    // 回看 6 小時：T0+3h（31）到 now（33），跨 5 小時、上升 2 點
    expect(f.count).toBe(2);
    expect(f.spanMs).toBe(5 * HOUR);
    expect(Math.abs((f.ratePerHour!) - (0.4)) < 1e-9).toBe(true);

    const fiveNow = T0 + 2 * HOUR;
    const g = forecastOf([five(10, T0, fiveNow + HOUR), five(20, fiveNow - 50 * MIN, fiveNow + HOUR), five(25, fiveNow, fiveNow + HOUR)], fiveNow)!;
    expect(g.count).toBe(2);
    expect(g.spanMs).toBe(50 * MIN);
    expect(Math.abs((g.ratePerHour!) - (6)) < 1e-9).toBe(true);
  });

  test("跳升（其他裝置用掉的額度）照實計入速度", () => {
    const now = T0 + 2 * HOUR;
    const f = forecastOf([week(20, T0), week(21, T0 + HOUR), week(41, now)], now)!;
    expect(Math.abs((f.ratePerHour!) - (10.5)) < 1e-9).toBe(true);
  });

  test("最後一筆的重置時間已過＝讀數過期，不預測", () => {
    const now = RESET + MIN;
    const f = forecastOf([week(50, RESET - 2 * HOUR), week(60, RESET - HOUR)], now)!;
    expect(f.isExpired).toBe(true);
    expect(f.hours95).toBeUndefined();
  });

  test("只用毫秒數：把整組時間平移（模擬不同時區的牆上時間）結果不變", () => {
    const shift = 5 * HOUR + 30 * MIN;
    const base = [week(56, T0), week(58, T0 + HOUR), week(60, T0 + 2 * HOUR)];
    const moved = base.map((s) => ({ ...s, at: s.at + shift, resetsAt: s.resetsAt + shift }));
    const a = forecastOf(base, T0 + 2 * HOUR)!;
    const b = forecastOf(moved, T0 + 2 * HOUR + shift)!;
    expect(b.ratePerHour).toBe(a.ratePerHour);
    expect(b.hours95).toBe(a.hours95);
    expect(b.beforeReset).toBe(a.beforeReset);
  });
});

describe("歷史：去重、合併、上限", () => {
  test("相鄰同值且相隔 <5 分鐘不重複存（回傳原陣列）；相隔 ≥5 分鐘、值不同、新週期照存", () => {
    const history = [week(40, T0)];
    expect(addSample(history, week(40, T0 + 4 * MIN), T0 + 4 * MIN)).toBe(history);
    expect(addSample(history, week(40, T0 + 5 * MIN), T0 + 5 * MIN)).toHaveLength(2);
    expect(addSample(history, week(41, T0 + 1 * MIN), T0 + MIN)).toHaveLength(2);
    expect(addSample(history, week(40, T0 + MIN, RESET + 7 * DAY), T0 + MIN)).toHaveLength(2);
    // 不同來源或視窗互不影響
    expect(addSample(history, five(40, T0 + MIN), T0 + MIN)).toHaveLength(2);
    expect(addSample(history, week(40, T0 + MIN, RESET, "codex"), T0 + MIN)).toHaveLength(2);
  });

  test("mergeHistory 依 (source, window, at) 去重並排序，兩邊各自多出的都保留", () => {
    const file = [week(10, T0), week(20, T0 + HOUR)];
    const mem = [week(20, T0 + HOUR), week(30, T0 + 2 * HOUR), week(5, T0 - HOUR)];
    const merged = mergeHistory(file, mem);
    expect(merged.map((s) => s.pct)).toEqual([5, 10, 20, 30]);
    // 同時間、不同視窗或來源不算重複
    const other = mergeHistory([week(1, T0)], [five(1, T0), week(1, T0, RESET, "codex")]);
    expect(other).toHaveLength(3);
  });

  test("trimHistory：只留最近 7 天；每個來源與視窗最多 500 筆（留最新的）", () => {
    const now = T0 + 10 * DAY;
    const old = week(1, now - 8 * DAY);
    const fresh = week(2, now - 6 * DAY);
    expect(trimHistory([old, fresh], now)).toEqual([fresh]);

    const many = Array.from({ length: 600 }, (_, i) => week(i / 10, now - 600 * MIN + i * MIN));
    const codex = [week(7, now - MIN, RESET, "codex")];
    const kept = trimHistory([...many, ...codex], now);
    const claude = kept.filter((s) => s.source === "claude");
    expect(claude).toHaveLength(500);
    expect(Math.abs((claude[0]!.pct) - (10)) < 1e-9).toBe(true);
    expect(Math.abs((claude[499]!.pct) - (59.9)) < 1e-9).toBe(true);
    expect(kept.filter((s) => s.source === "codex")).toHaveLength(1);
  });
});

describe("歷史檔讀寫", () => {
  test("序列化只有五個欄位；多餘欄位不會寫出", () => {
    const text = serializeHistory([{ ...week(40, T0), secret: "不該出現", content: "對話" } as Sample]);
    expect(JSON.parse(text)).toEqual({ samples: [{ source: "claude", window: "seven_day", pct: 40, resetsAt: RESET, at: T0 }] });
    expect(text.includes("不該出現")).toBe(false);
  });

  test("parseHistory：往返一致；壞 JSON、格式不符回傳 undefined；單筆壞的略過", () => {
    const samples = [week(40, T0), five(10, T0 + MIN)];
    expect(parseHistory(serializeHistory(samples))).toEqual(samples);
    expect(parseHistory("{壞掉")).toBeUndefined();
    expect(parseHistory("[]")).toBeUndefined();
    expect(parseHistory('{"samples":"x"}')).toBeUndefined();
    const mixed = JSON.stringify({ samples: [samples[0], { source: "x", window: "seven_day", pct: 1, resetsAt: 1, at: 1 }, { pct: "9" }, null] });
    expect(parseHistory(mixed)).toEqual([samples[0]]);
  });
});

describe("取樣轉換", () => {
  test("claudeSamples：只取 five_hour／seven_day 且有重置時間的；resetsAt 轉毫秒", () => {
    const resetsAt = "2026-10-23T00:00:00.000Z";
    const out = claudeSamples(
      [
        { kind: "five_hour", percentUsed: 18, resetsAt },
        { kind: "seven_day", percentUsed: 62.5, resetsAt },
        { kind: "spend_limit", percentUsed: 5, resetsAt },
        { kind: "seven_day", percentUsed: 1 },
        { kind: "five_hour", percentUsed: 1, resetsAt: "不是時間" },
      ],
      T0,
    );
    expect(out).toEqual([
      { source: "claude", window: "five_hour", pct: 18, resetsAt: Date.parse(resetsAt), at: T0 },
      { source: "claude", window: "seven_day", pct: 62.5, resetsAt: Date.parse(resetsAt), at: T0 },
    ]);
    expect(claudeSamples([], T0)).toEqual([]);
  });

  test("codexSamples：primary＝5 小時、secondary＝週，at 用 observedAt", () => {
    const out = codexSamples({
      primary: { pct: 27, windowMinutes: 300, resetsAt: T0 + HOUR },
      secondary: { pct: 25, windowMinutes: 10080, resetsAt: RESET },
      observedAt: T0 - MIN,
    });
    expect(out).toEqual([
      { source: "codex", window: "five_hour", pct: 27, resetsAt: T0 + HOUR, at: T0 - MIN },
      { source: "codex", window: "seven_day", pct: 25, resetsAt: RESET, at: T0 - MIN },
    ]);
    expect(codexSamples({ observedAt: T0 })).toEqual([]);
  });

  test("parseScriptOutput：取規定欄位、丟掉多餘的；格式不符回傳 undefined", () => {
    const text = JSON.stringify({
      codex: { primary: { pct: 1, windowMinutes: 300, resetsAt: 5, extra: "x" }, observedAt: 9, leak: "x" },
      agy: { today: 3, week: 11, leak: "x" },
      other: "x",
    });
    expect(parseScriptOutput(text)).toEqual({
      codex: { primary: { pct: 1, windowMinutes: 300, resetsAt: 5 }, observedAt: 9 },
      agy: { today: 3, week: 11 },
    });
    expect(parseScriptOutput('{"codex":null,"codexReason":"找不到","agy":null,"agyReason":"沒有"}')).toEqual({
      codex: null,
      codexReason: "找不到",
      agy: null,
      agyReason: "沒有",
    });
    expect(parseScriptOutput("壞")).toBeUndefined();
    expect(parseScriptOutput('{"codex":{"observedAt":1}}')).toBeUndefined();
    expect(parseScriptOutput('{"agy":{"today":"3","week":1}}')).toBeUndefined();
  });
});

describe("顯示字串", () => {
  test("clockLabel：同一天只顯示時間，不同天顯示月/日（以本地時間組成毫秒數，與時區無關）", () => {
    const now = new Date(2026, 9, 20, 9, 5).getTime();
    expect(clockLabel(new Date(2026, 9, 20, 14, 30).getTime(), now)).toBe("14:30");
    expect(clockLabel(new Date(2026, 9, 23, 8, 0).getTime(), now)).toBe("10/23 08:00");
    expect(clockLabel(new Date(2026, 9, 19, 23, 59).getTime(), now)).toBe("10/19 23:59");
  });

  test("agoLabel：剛剛、分鐘、小時、天", () => {
    expect(agoLabel(T0 - 30_000, T0)).toBe("剛剛");
    expect(agoLabel(T0 - 12 * MIN, T0)).toBe("12 分鐘前");
    expect(agoLabel(T0 - 3 * HOUR, T0)).toBe("3 小時前");
    expect(agoLabel(T0 - 2 * DAY, T0)).toBe("2 天前");
    expect(agoLabel(T0 + MIN, T0)).toBe("剛剛");
  });
});

describe("進度條一行", () => {
  const now = new Date(2026, 9, 20, 9, 0).getTime();
  const resetsAt = now + 3 * DAY;
  // 兩筆讀數：2 小時內從 from 升到 to（重置時間 3 天後），算出速度。
  function rising(from: number, to: number, reset = resetsAt, span = 2 * HOUR) {
    return forecastOf([week(from, now - span, reset), week(to, now, reset)], now)!;
  }
  function single(pct: number) {
    return forecastOf([week(pct, now, resetsAt)], now)!;
  }
  function barOfLine(text: string): string {
    return /[█░│]+/.exec(text)![0];
  }

  test("整行格式：縮 2 格、標籤、進度條、百分比、行尾狀態；剛好 15 格寬的條與範例相同", () => {
    const line = quotaBarLine("週用量", rising(57.6, 62), 39);
    expect(line.text).toBe("  週用量 █████████░░░░│░ 62% ⚠15時後95%");
    expect(line.level).toBe("success");
    expect(quotaBarLine("5 小時", single(18), 120).text.startsWith("  5 小時 ")).toBe(true);
  });

  test("行尾六種狀態與判斷順序", () => {
    const status = (text: string) => text.slice(text.indexOf("% ") + 2);
    const expired = forecastOf([week(90, now - 5 * HOUR, now - HOUR)], now)!;
    expect(status(quotaBarLine("週用量", expired, 120).text)).toBe("等新讀數");
    // 已過重置時間優先於已滿
    const expiredFull = forecastOf([week(100, now - 5 * HOUR, now - HOUR)], now)!;
    expect(status(quotaBarLine("週用量", expiredFull, 120).text)).toBe("等新讀數");
    expect(status(quotaBarLine("週用量", rising(97, 100), 120).text)).toBe("已滿");
    expect(status(quotaBarLine("週用量", rising(90, 96), 120).text)).toBe("已達95%");
    expect(status(quotaBarLine("週用量", single(10), 120).text)).toBe("資料不足");
    expect(status(quotaBarLine("週用量", rising(10, 10), 120).text)).toBe("資料不足");
    expect(status(quotaBarLine("週用量", rising(56, 60), 120).text)).toBe("⚠18時後95%");
    // 同樣速度但 10 小時後就重置：重置前不會到 95%
    expect(status(quotaBarLine("週用量", rising(56, 60, now + 10 * HOUR), 120).text)).toBe("重置前安全");
  });

  test("⚠ 的時間：分、小於 10 小時一位小數、10 小時以上整數，且不含空白", () => {
    const status = (text: string) => text.slice(text.indexOf("⚠"));
    const half = forecastOf([week(60, now - 30 * MIN, resetsAt), week(63, now, resetsAt)], now)!;
    expect(status(quotaBarLine("週用量", half, 120).text)).toBe("⚠5.3時後95%");
    const soon = forecastOf([week(88, now - 30 * MIN, resetsAt), week(91, now, resetsAt)], now)!;
    expect(status(quotaBarLine("週用量", soon, 120).text)).toBe("⚠40分後95%");
  });

  test("百分比沿用一位小數規則", () => {
    expect(quotaBarLine("週用量", single(62.34), 120).text).toContain(" 62.3% ");
    expect(quotaBarLine("週用量", single(62.0), 120).text).toContain(" 62% ");
  });

  test("顏色：≥95 error、≥70 warning、其他 success", () => {
    const level = (pct: number) => quotaBarLine("週用量", single(pct), 120).level;
    expect(level(0)).toBe("success");
    expect(level(69.9)).toBe("success");
    expect(level(70)).toBe("warning");
    expect(level(94.9)).toBe("warning");
    expect(level(95)).toBe("error");
    expect(level(100)).toBe("error");
  });

  test("95% 門檻標記：條內恰一格「│」，位置固定，後面留一格；已用格數依百分比", () => {
    for (const columns of [30, 44, 60, 120]) {
      const bar = barOfLine(quotaBarLine("週用量", single(62), columns).text);
      const width = [...bar].length;
      const mark = Math.min(width - 2, Math.round(0.95 * width) - 1);
      expect([...bar].filter((char) => char === "│")).toHaveLength(1);
      expect([...bar].indexOf("│")).toBe(mark);
      expect(width - 1 - mark).toBeGreaterThanOrEqual(1);
      const filled = [...bar].filter((char) => char === "█").length;
      expect(filled).toBe(Math.round(0.62 * width));
    }
    // 寬欄：條寬 24，標記在第 23 格（索引 22）
    const wide = barOfLine(quotaBarLine("週用量", single(62), 120).text);
    expect([...wide]).toHaveLength(24);
    expect([...wide].indexOf("│")).toBe(22);
  });

  test("0% 全是未用格（標記仍在）、100% 全是已用格（標記仍在）", () => {
    const zero = barOfLine(quotaBarLine("週用量", single(0), 120).text);
    expect([...zero].filter((char) => char === "█")).toHaveLength(0);
    expect(zero).toContain("│");
    expect(quotaBarLine("週用量", single(0), 120).text).toContain(" 0% ");
    const full = barOfLine(quotaBarLine("週用量", rising(97, 100), 120).text);
    expect([...full].filter((char) => char === "░")).toHaveLength(0);
    expect([...full].filter((char) => char === "█")).toHaveLength([...full].length - 1);
    expect(quotaBarLine("週用量", rising(97, 100), 120).text).toContain(" 100% ");
  });

  test("窄欄（30）與寬欄（120）整行都不超寬；條寬在 6～24 之間", () => {
    const forecasts = [
      single(0),
      single(62.34),
      rising(57.6, 62),
      rising(56, 60, now + 10 * HOUR),
      rising(90, 96),
      rising(97, 100),
      forecastOf([week(90, now - 5 * HOUR, now - HOUR)], now)!,
      forecastOf([week(88, now - 30 * MIN, resetsAt), week(91, now, resetsAt)], now)!,
    ];
    for (const columns of [30, 44, 80, 120]) {
      for (const forecast of forecasts) {
        for (const label of ["週用量", "5 小時"]) {
          const text = quotaBarLine(label, forecast, columns).text;
          expect(textWidth(text) <= columns).toBe(true);
        }
      }
    }
    // 空間夠時條寬依欄寬縮放：寬欄上限 24；30 欄時比寬欄短
    const wide = [...barOfLine(quotaBarLine("週用量", single(62), 120).text)].length;
    const narrow = [...barOfLine(quotaBarLine("週用量", single(62), 30).text)].length;
    expect(wide).toBe(24);
    expect(narrow >= 6 && narrow < wide).toBe(true);
    // 條寬下限：極窄時條仍是 6 格，整行以省略號截斷而不超寬
    const tiny = quotaBarLine("週用量", rising(57.6, 62), 20).text;
    expect(textWidth(tiny) <= 20).toBe(true);
  });
});
