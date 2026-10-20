// 額度分頁的純函式：樣本分段、消耗速度、到 95%／100% 的預測、歷史合併與顯示字串。
// 不碰 `$`（驗證器規定 `$` 不跨檔）；時間一律用毫秒數計算，現在時間由呼叫端傳入。
import { fit, textWidth } from "./flow-model";

export type QuotaSource = "claude" | "codex";
export type QuotaWindow = "five_hour" | "seven_day";

// 一筆讀數：只有這五個欄位會寫進歷史檔（沒有任何對話內容或帳號）。
export type Sample = {
  source: QuotaSource;
  window: QuotaWindow;
  pct: number;
  // 該視窗的重置時間（毫秒）。
  resetsAt: number;
  // 取得讀數的時間（毫秒）。
  at: number;
};

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
const DAY_MS = 24 * HOUR_MS;

// 同一個週期：resetsAt 相差 ≤ 120 秒；pct 下降 ≥ 5 點視為新週期。
const SAME_RESET_MS = 120_000;
const DROP_POINTS = 5;
// 速度的回看範圍、最短跨度與最小上升量。
const LOOKBACK_MS: Record<QuotaWindow, number> = { seven_day: 6 * HOUR_MS, five_hour: 60 * MINUTE_MS };
const MIN_SPAN_MS = 10 * MINUTE_MS;
const MIN_RISE = 1;
const WARN_PCT = 95;
const FULL_PCT = 100;
// 歷史上限：每個來源與視窗最近 7 天、最多 500 筆；相鄰且相隔不到 5 分鐘的同值讀數不重複存。
const KEEP_MS = 7 * DAY_MS;
const KEEP_COUNT = 500;
const SAME_VALUE_GAP_MS = 5 * MINUTE_MS;

function byTime(a: Sample, b: Sample): number {
  return (
    a.at - b.at ||
    (a.source < b.source ? -1 : a.source > b.source ? 1 : 0) ||
    (a.window < b.window ? -1 : a.window > b.window ? 1 : 0)
  );
}

function keyOf(sample: Sample): string {
  return `${sample.source}|${sample.window}|${sample.at}`;
}

// ---------- 分段與預測 ----------

// 取某來源、某視窗「目前這個週期」的樣本（依時間排序）：resetsAt 改變或 pct 下降 ≥ 5 點之前的舊資料不算。
export function currentCycle(samples: Sample[], source: QuotaSource, window: QuotaWindow): Sample[] {
  const own = samples.filter((sample) => sample.source === source && sample.window === window).sort(byTime);
  let start = 0;
  for (let index = 1; index < own.length; index++) {
    const prev = own[index - 1]!;
    const cur = own[index]!;
    if (Math.abs(cur.resetsAt - prev.resetsAt) > SAME_RESET_MS || prev.pct - cur.pct >= DROP_POINTS) start = index;
  }
  return own.slice(start);
}

export type Forecast = {
  pct: number;
  resetsAt: number;
  // 最後一筆讀數的時間。
  at: number;
  // 用來算速度的樣本筆數與跨度（回看範圍內）。
  count: number;
  spanMs: number;
  // 每小時上升的百分點；資料不足時沒有。
  ratePerHour?: number;
  // 資料不足的原因：span＝樣本太少或跨度不到 10 分鐘，flat＝沒有上升到 1 點。
  insufficient?: "span" | "flat";
  // 目前已到的門檻（0＝都沒到）。
  reached: 0 | 95 | 100;
  // 照目前速度還要幾小時到 95%／100%（已到、資料不足或已過重置時間時沒有）。
  hours95?: number;
  hours100?: number;
  // 到 95%（100%）的時間點早於重置時間。
  beforeReset?: boolean;
  beforeReset100?: boolean;
  // 最後一筆讀數的重置時間已過：讀數過期，不預測。
  isExpired: boolean;
};

// 以目前週期的樣本（可未排序）算預測；沒有樣本回傳 undefined。
export function forecastOf(cycle: Sample[], now: number): Forecast | undefined {
  const sorted = [...cycle].sort(byTime);
  const last = sorted[sorted.length - 1];
  if (last === undefined) return undefined;
  const used = sorted.filter((sample) => sample.at >= last.at - LOOKBACK_MS[last.window]);
  const first = used[0]!;
  const spanMs = last.at - first.at;
  const rise = last.pct - first.pct;
  const reached = last.pct >= FULL_PCT ? FULL_PCT : last.pct >= WARN_PCT ? WARN_PCT : 0;
  const forecast: Forecast = {
    pct: last.pct,
    resetsAt: last.resetsAt,
    at: last.at,
    count: used.length,
    spanMs,
    reached,
    isExpired: last.resetsAt <= now,
  };
  if (spanMs < MIN_SPAN_MS) forecast.insufficient = "span";
  else if (rise < MIN_RISE) forecast.insufficient = "flat";
  else forecast.ratePerHour = rise / (spanMs / HOUR_MS);

  const rate = forecast.ratePerHour;
  if (rate !== undefined && reached === 0 && !forecast.isExpired) {
    forecast.hours95 = (WARN_PCT - last.pct) / rate;
    forecast.hours100 = (FULL_PCT - last.pct) / rate;
    forecast.beforeReset = now + forecast.hours95 * HOUR_MS < last.resetsAt;
    forecast.beforeReset100 = now + forecast.hours100 * HOUR_MS < last.resetsAt;
  }
  return forecast;
}

// ---------- 歷史 ----------

// 依 (source, window, at) 去重後依時間排序；同一鍵以後者（記憶體）為準。
export function mergeHistory(fileSamples: Sample[], memSamples: Sample[]): Sample[] {
  const byKey = new Map<string, Sample>();
  for (const sample of [...fileSamples, ...memSamples]) byKey.set(keyOf(sample), sample);
  return [...byKey.values()].sort(byTime);
}

// 每個來源與視窗只留最近 7 天、最多 500 筆（較舊的丟棄）。
export function trimHistory(samples: Sample[], now: number): Sample[] {
  const groups = new Map<string, Sample[]>();
  for (const sample of [...samples].sort(byTime)) {
    if (sample.at < now - KEEP_MS) continue;
    const key = `${sample.source}|${sample.window}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [sample]);
    else group.push(sample);
  }
  const kept: Sample[] = [];
  for (const group of groups.values()) kept.push(...group.slice(-KEEP_COUNT));
  return kept.sort(byTime);
}

// 加一筆樣本：與同來源、同視窗前一筆相比，pct 相同、同一重置週期、相隔不到 5 分鐘就不重複存（回傳原陣列）。
export function addSample(history: Sample[], sample: Sample, now: number): Sample[] {
  let prev: Sample | undefined;
  for (const entry of history) {
    if (entry.source !== sample.source || entry.window !== sample.window || entry.at > sample.at) continue;
    if (prev === undefined || entry.at >= prev.at) prev = entry;
  }
  if (prev !== undefined) {
    const isSameValue =
      prev.pct === sample.pct &&
      Math.abs(prev.resetsAt - sample.resetsAt) <= SAME_RESET_MS &&
      sample.at - prev.at < SAME_VALUE_GAP_MS;
    if (isSameValue) return history;
  }
  return trimHistory(mergeHistory(history, [sample]), now);
}

function isSource(value: unknown): value is QuotaSource {
  return value === "claude" || value === "codex";
}

function isWindow(value: unknown): value is QuotaWindow {
  return value === "five_hour" || value === "seven_day";
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function sampleOf(value: unknown): Sample | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const { source, window, pct, resetsAt, at } = value as Record<string, unknown>;
  if (!isSource(source) || !isWindow(window) || !isFiniteNumber(pct) || !isFiniteNumber(resetsAt) || !isFiniteNumber(at)) {
    return undefined;
  }
  return { source, window, pct, resetsAt, at };
}

// 歷史檔格式 `{samples:[...]}`；整個檔案無法解析或格式不符回傳 undefined（呼叫端用記憶體樣本重建），單筆壞掉的略過。
export function parseHistory(text: string): Sample[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const list = (parsed as { samples?: unknown } | null)?.samples;
  if (!Array.isArray(list)) return undefined;
  return list.flatMap((item) => {
    const sample = sampleOf(item);
    return sample === undefined ? [] : [sample];
  });
}

// 只輸出 Sample 的五個欄位，不會夾帶其他東西。
export function serializeHistory(samples: Sample[]): string {
  const rows = samples.map(({ source, window, pct, resetsAt, at }) => ({ source, window, pct, resetsAt, at }));
  return `${JSON.stringify({ samples: rows })}\n`;
}

// ---------- 取樣：Claude 與 Codex ----------

// `$.session.usage().rateLimits`：只取 five_hour、seven_day 且有重置時間的（spend_limit 等不算）。
export function claudeSamples(limits: { kind: string; percentUsed: number; resetsAt?: string }[], now: number): Sample[] {
  const out: Sample[] = [];
  for (const limit of limits) {
    if (!isWindow(limit.kind) || !isFiniteNumber(limit.percentUsed) || limit.resetsAt === undefined) continue;
    const resetsAt = Date.parse(limit.resetsAt);
    if (!Number.isFinite(resetsAt)) continue;
    out.push({ source: "claude", window: limit.kind, pct: limit.percentUsed, resetsAt, at: now });
  }
  return out;
}

export type CodexWindow = { pct: number; windowMinutes: number; resetsAt: number };
export type CodexReading = { primary?: CodexWindow; secondary?: CodexWindow; observedAt: number };
export type AgyCounts = { today: number; week: number };
// 讀取腳本 stdout 的全部欄位。
export type ScriptResult = {
  codex: CodexReading | null;
  codexReason?: string;
  agy: AgyCounts | null;
  agyReason?: string;
};

// Codex 的 primary 是 5 小時、secondary 是週；observedAt（紀錄檔修改時間）當樣本的 at。
export function codexSamples(reading: CodexReading): Sample[] {
  const out: Sample[] = [];
  const pairs: [CodexWindow | undefined, QuotaWindow][] = [
    [reading.primary, "five_hour"],
    [reading.secondary, "seven_day"],
  ];
  for (const [entry, window] of pairs) {
    if (entry !== undefined) {
      out.push({ source: "codex", window, pct: entry.pct, resetsAt: entry.resetsAt, at: reading.observedAt });
    }
  }
  return out;
}

function codexWindowOf(value: unknown): CodexWindow | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const { pct, windowMinutes, resetsAt } = value as Record<string, unknown>;
  if (!isFiniteNumber(pct) || !isFiniteNumber(windowMinutes) || !isFiniteNumber(resetsAt)) return undefined;
  return { pct, windowMinutes, resetsAt };
}

// 驗證並取出腳本輸出的欄位（多餘的欄位丟掉）；格式不符回傳 undefined。
export function parseScriptOutput(text: string): ScriptResult | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object") return undefined;
  const raw = parsed as Record<string, unknown>;
  const result: ScriptResult = { codex: null, agy: null };

  const codex = raw.codex;
  if (codex !== null && codex !== undefined) {
    if (typeof codex !== "object") return undefined;
    const body = codex as Record<string, unknown>;
    const primary = codexWindowOf(body.primary);
    const secondary = codexWindowOf(body.secondary);
    if (!isFiniteNumber(body.observedAt) || (primary === undefined && secondary === undefined)) return undefined;
    result.codex = {
      ...(primary === undefined ? {} : { primary }),
      ...(secondary === undefined ? {} : { secondary }),
      observedAt: body.observedAt,
    };
  }
  if (typeof raw.codexReason === "string") result.codexReason = raw.codexReason;

  const agy = raw.agy;
  if (agy !== null && agy !== undefined) {
    if (typeof agy !== "object") return undefined;
    const { today, week } = agy as Record<string, unknown>;
    if (!isFiniteNumber(today) || !isFiniteNumber(week)) return undefined;
    result.agy = { today, week };
  }
  if (typeof raw.agyReason === "string") result.agyReason = raw.agyReason;
  return result;
}

// ---------- 顯示 ----------

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

// 本地時間：同一天只顯示 `14:30`，不同天顯示 `10/23 08:00`。
export function clockLabel(ms: number, now: number): string {
  const date = new Date(ms);
  const today = new Date(now);
  const time = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  const isSameDay =
    date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth() && date.getDate() === today.getDate();
  return isSameDay ? time : `${date.getMonth() + 1}/${date.getDate()} ${time}`;
}

export function agoLabel(at: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  if (seconds < 60) return "剛剛";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分鐘前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小時前`;
  return `${Math.floor(hours / 24)} 天前`;
}

function oneDecimal(value: number): string {
  return String(Math.round(value * 10) / 10);
}

function hoursLabel(hours: number): string {
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} 分`;
  return hours < 10 ? `${oneDecimal(hours)} 時` : `${Math.round(hours)} 時`;
}

// 進度條：「█」已用、「░」未用，95% 的位置放一格「│」當門檻標記（取代該格）。條寬含標記；標記後面至少留一格。
const BAR_MIN = 6;
const BAR_MAX = 24;

function barOf(pct: number, width: number): string {
  const filled = Math.min(width, Math.max(0, Math.round((pct / 100) * width)));
  const mark = Math.min(width - 2, Math.round((WARN_PCT / 100) * width) - 1);
  let bar = "";
  for (let index = 0; index < width; index++) bar += index === mark ? "│" : index < filled ? "█" : "░";
  return bar;
}

// 行尾的簡短狀態，依序判斷。
function statusOf(forecast: Forecast): string {
  if (forecast.isExpired) return "等新讀數";
  if (forecast.reached === FULL_PCT) return "已滿";
  if (forecast.reached === WARN_PCT) return "已達95%";
  if (forecast.ratePerHour === undefined) return "資料不足";
  if (forecast.beforeReset === true && forecast.hours95 !== undefined) {
    return `⚠${hoursLabel(forecast.hours95).replace(" ", "")}後95%`;
  }
  return "重置前安全";
}

// 一個視窗的一行：`  週用量 █████████░░░░│░ 62% ⚠15時後95%`；整行寬度不超過 columns，顏色等級依百分比（≥95 error、≥70 warning）。
export function quotaBarLine(
  label: string,
  forecast: Forecast,
  columns: number,
): { text: string; level: "success" | "warning" | "error" } {
  const head = `  ${label} `;
  const tail = ` ${oneDecimal(forecast.pct)}% ${statusOf(forecast)}`;
  const width = Math.min(BAR_MAX, Math.max(BAR_MIN, columns - textWidth(head) - textWidth(tail)));
  const level = forecast.pct >= WARN_PCT ? "error" : forecast.pct >= 70 ? "warning" : "success";
  return { text: fit(`${head}${barOf(forecast.pct, width)}${tail}`, columns), level };
}
