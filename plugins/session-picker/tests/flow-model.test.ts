import { describe, expect, test } from "claude-code/testing";

import {
  activityLines,
  addEvent,
  currentIndexOf,
  dirnameOf,
  displayPath,
  dropEvent,
  emptyActivity,
  fileNameOf,
  fit,
  formatTokens,
  maskSecrets,
  parseNodeLine,
  parsePlan,
  patchEvent,
  planHeader,
  planLines,
  startTurn,
  targetOf,
} from "../hooks/flow-model";
import type { ActivityState, FlowEvent } from "../hooks/flow-model";

const FENCE = "```";

const EXAMPLE_LINES = [
  "[P2] 實作探針 projects/claude-session-picker/｜Codex exec（gpt-6-luna max）→ 改派 subagent（executor, Sonnet 5.5 high）｜已執行",
  "  ├─ 切換成功 ──▶ [P4] AGY 外審（併入 S2 後一起送，見下）｜外部 AGY｜已執行",
  "  └─ /resume 被拒或無效 ──▶ [W2] 回報並請使用者決定（改方案 b 須升 🔴）｜主 agent｜未執行（分支未觸發：W1 實測切換成功）",
];

describe("計畫書節點解析", () => {
  test("三種真實格式的節點行：ID、名稱、agent、狀態（含前導樹狀符號與分支標籤）", () => {
    const nodes = EXAMPLE_LINES.map((line) => parseNodeLine(line));

    expect(nodes[0]).toEqual({
      id: "P2",
      name: "實作探針 projects/claude-session-picker/",
      agent: "Codex exec（gpt-6-luna max）→ 改派 subagent（executor, Sonnet 5.5 high）",
      status: "done",
      skipped: false,
    });
    expect(nodes[1]).toMatchObject({ id: "P4", name: "AGY 外審（併入 S2 後一起送，見下）", agent: "外部 AGY", status: "done" });
    expect(nodes[2]).toMatchObject({ id: "W2", agent: "主 agent", status: "todo", skipped: true });
  });

  test("多個區塊依檔案順序收集；沒有節點的區塊、區塊外的文字都忽略", () => {
    const text = [
      "# 計畫",
      "[X1] 這行在區塊外｜主 agent｜已執行",
      `${FENCE}text`,
      "[S1-P0] 第一個｜主 agent｜已執行",
      "  │",
      "  ▼",
      "[S1-P1] 第二個｜subagent（executor）｜有問題：原因",
      FENCE,
      "",
      `${FENCE}bash`,
      "echo 沒有節點",
      FENCE,
      "",
      `${FENCE}text`,
      "[S2-P0] 第三個｜主 agent｜未執行",
      FENCE,
    ].join("\n");

    const nodes = parsePlan(text);

    expect(nodes.map((node) => [node.id, node.status])).toEqual([
      ["S1-P0", "done"],
      ["S1-P1", "problem"],
      ["S2-P0", "todo"],
    ]);
  });

  test("格式不全的行被忽略：缺欄位、狀態不是三個關鍵字、ID 含空白或空的方括號", () => {
    const text = [
      FENCE + "text",
      "[P1] 只有名稱｜主 agent",
      "[P2] 狀態亂寫｜主 agent｜完成了",
      "[P 3] ID 有空白｜主 agent｜已執行",
      "[] 沒有 ID｜主 agent｜已執行",
      "沒有方括號｜主 agent｜已執行",
      "[OK] 這行是好的｜主 agent｜未執行",
      FENCE,
    ].join("\n");

    expect(parsePlan(text).map((node) => node.id)).toEqual(["OK"]);
  });

  test("CRLF 換行也能解析", () => {
    const text = `${FENCE}text\r\n[A] 名稱｜主 agent｜已執行\r\n${FENCE}\r\n`;

    expect(parsePlan(text).map((node) => node.id)).toEqual(["A"]);
  });

  test("目前節點＝第一個未執行且不是「未觸發」分支的節點；符號與後綴", () => {
    const nodes = parsePlan(
      [
        FENCE + "text",
        "[A] 完成的｜主 agent｜已執行",
        "[B] 有問題的｜主 agent｜有問題：缺證據",
        "[C] 未觸發的分支｜主 agent｜未執行（分支未觸發：沒走到）",
        "[D] 目前這個｜subagent（executor, Sonnet 5.5 high）｜未執行",
        "[E] 後面的｜主 agent｜未執行",
        FENCE,
      ].join("\n"),
    );

    expect(currentIndexOf(nodes)).toBe(3);
    const lines = planLines(nodes, 80);
    expect(lines.map((line) => line.head)).toEqual([
      "✔ A 完成的",
      "✘ B 有問題的（有問題）",
      "· C 未觸發的分支（未觸發）",
      "▶ D 目前這個 ← 目前",
      "○ E 後面的",
    ]);
    expect(lines[3]?.agent).toBe("｜subagent（executor, Sonnet 5.5 high）");
    expect(lines[2]?.isMuted).toBe(true);
  });

  test("太窄時名稱先縮、固定後綴保留，agent 只用剩下的欄寬，整行不超過 columns", () => {
    const nodes = parsePlan(
      [FENCE + "text", "[D] " + "很長的名稱".repeat(8) + "｜subagent（executor, Sonnet 5.5 high）｜未執行", FENCE].join("\n"),
    );

    const [line] = planLines(nodes, 44);

    expect(line?.head.endsWith("… ← 目前")).toBe(true);
    expect((line?.agent ?? "") === "" || (line?.agent ?? "").startsWith("｜")).toBe(true);
    const total = [...`${line?.head}${line?.agent}`].reduce((sum, char) => sum + ((char.codePointAt(0) ?? 0) > 0x2e80 ? 2 : 1), 0);
    expect(total).toBeLessThanOrEqual(46);
  });

  test("標題「計畫：檔名  已執行 a／共 n」；放不下時縮檔名、保留計數", () => {
    const nodes = parsePlan([FENCE + "text", "[A] a｜主 agent｜已執行", "[B] b｜主 agent｜未執行", FENCE].join("\n"));

    expect(planHeader("x-plan.md", nodes, 80)).toBe("計畫：x-plan.md  已執行 1／共 2");
    const narrow = planHeader("26-10-18-claude-session-picker-plan.md", nodes, 30);
    expect(narrow.endsWith("  已執行 1／共 2")).toBe(true);
    expect(narrow.includes("…")).toBe(true);
  });
});

describe("目標摘要（不保存輸入全文）", () => {
  test("檔案取檔名、網址取主機、指令取第一行、pattern／query／description 原文", () => {
    expect(targetOf({ file_path: "C:\\a\\b\\register.tsx", content: "不該被讀" })).toBe("register.tsx");
    expect(targetOf({ notebook_path: "/x/y/n.ipynb" })).toBe("n.ipynb");
    expect(targetOf({ url: "https://example.com:8080/path?q=1" })).toBe("example.com");
    expect(targetOf({ command: "node a.mjs\nsecond line" })).toBe("node a.mjs second line");
    expect(targetOf({ pattern: "foo.*bar" })).toBe("foo.*bar");
    expect(targetOf({ query: "天氣" })).toBe("天氣");
    expect(targetOf({ description: "做事" })).toBe("做事");
    expect(targetOf({ prompt: "只有 prompt" })).toBe("");
  });

  test("控制字元（含 ANSI 跳脫）去掉、超過 60 欄截斷加省略號", () => {
    expect(targetOf({ command: "echo \u001b[31mred\u001b[0m" })).not.toContain("\u001b");
    const long = targetOf({ command: `echo ${"a".repeat(80)} sk-test-SECRET` });
    expect(long.endsWith("…")).toBe(true);
    expect(long.includes("sk-test-SECRET")).toBe(false);
    expect([...long].length).toBeLessThanOrEqual(60);
  });
});

function tool(partial: Partial<FlowEvent> & Pick<FlowEvent, "id" | "name">): FlowEvent {
  return { kind: "tool", turn: 12, target: "", model: "", startedAt: 0, durationMs: 100, ok: true, ...partial };
}

describe("活動文字樹", () => {
  test("規格範例：每輪一棵樹，agent 底下掛它自己的工具，MCP 與失敗標示", () => {
    const events: FlowEvent[] = [
      tool({ id: "1", name: "Bash", target: "node scripts/review-check.mjs", durationMs: 3200 }),
      { id: "2", kind: "agent", turn: 12, name: "executor", target: "寫程式", agentId: "a1", model: "sonnet", startedAt: 0 },
      tool({ id: "3", name: "Read", target: "register.tsx", agentId: "a1", durationMs: 40 }),
      tool({ id: "4", name: "Bash", target: "claude plugin test", agentId: "a1", durationMs: 2500 }),
      tool({ id: "5", name: "mcp__brave-search__brave_web_search", durationMs: 1100, ok: false }),
    ];

    expect(activityLines(events, 100)).toEqual([
      "第 12 輪 ─┬─ Bash  node scripts/review-check.mjs  3.2s",
      "          ├─ Agent executor（sonnet）─┬─ Read  register.tsx  40ms",
      "          │                           └─ Bash  claude plugin test  2.5s",
      "          └─ MCP brave-search › brave_web_search  1.1s ✘",
    ]);
  });

  test("只有一個項目用 ──；執行中顯示 …；沒有 agent 紀錄的 subagent 工具平放在頂層", () => {
    const events: FlowEvent[] = [
      { ...tool({ id: "1", name: "Grep", target: "foo" }), turn: 3, durationMs: undefined, ok: undefined },
      { ...tool({ id: "2", name: "Read", target: "x.ts", agentId: "unknown-agent" }), turn: 4 },
    ];

    expect(activityLines(events, 100)).toEqual([
      "第 3 輪 ─── Grep  foo  …",
      "第 4 輪 ─── Read  x.ts  100ms",
    ]);
  });

  test("只顯示最近 5 輪；載入前的活動（第 0 輪）有專屬標示；插件名稱 plugin_x_y 轉成 plugin:x:y", () => {
    const events: FlowEvent[] = [
      tool({ id: "0", name: "Bash", target: "early", turn: 0 }),
      ...[1, 2, 3, 4, 5, 6].map((turn) => tool({ id: `t${turn}`, name: "Read", target: `f${turn}`, turn })),
      tool({ id: "m", name: "mcp__plugin_demo_srv__go", turn: 6 }),
    ];

    const lines = activityLines(events, 100);

    expect(lines.filter((line) => line.startsWith("第 ")).map((line) => line.split(" ─")[0])).toEqual([
      "第 2 輪",
      "第 3 輪",
      "第 4 輪",
      "第 5 輪",
      "第 6 輪",
    ]);
    expect(lines.some((line) => line.includes("載入前"))).toBe(false);
    expect(lines.some((line) => line.includes("MCP plugin:demo:srv › go"))).toBe(true);
    expect(activityLines(events.slice(0, 2), 100)[0]?.startsWith("載入前起算的一輪")).toBe(true);
  });

  test("窄欄寬時耗時與 ✘ 保留，目標被截短；整行不超過欄寬", () => {
    const events: FlowEvent[] = [
      tool({ id: "1", name: "Bash", target: "node " + "x".repeat(50), durationMs: 3200, ok: false }),
    ];

    const [line] = activityLines(events, 30);

    expect(line?.endsWith("3.2s ✘")).toBe(true);
    expect(line?.includes("…")).toBe(true);
    expect([...(line ?? "")].length).toBeLessThanOrEqual(30);
  });
});

describe("活動狀態紀錄", () => {
  const base = (): ActivityState => startTurn(emptyActivity());

  test("最多保留 200 筆，計數不隨丟棄減少；finish 補耗時與成敗；drop 拿掉未真正開始的 agent", () => {
    let state = base();
    for (let i = 0; i < 205; i++) {
      state = addEvent(state, { id: `c${i}`, kind: "tool", name: i === 0 ? "mcp__s__t" : "Bash", target: `n${i}`, model: "", startedAt: i });
    }
    state = addEvent(state, { id: "ag", kind: "agent", name: "x", target: "", model: "", startedAt: 0 });

    expect(state.events).toHaveLength(200);
    expect(state.events[0]?.id).toBe("c6");
    expect(state.tools).toBe(205);
    expect(state.mcp).toBe(1);
    expect(state.agents).toBe(1);
    expect(state.events.at(-1)?.turn).toBe(1);

    state = patchEvent(state, "c204", { durationMs: 9, ok: false });
    expect(state.events.find((event) => event.id === "c204")).toMatchObject({ durationMs: 9, ok: false });

    state = dropEvent(state, "ag");
    expect(state.agents).toBe(0);
    expect(state.events.some((event) => event.id === "ag")).toBe(false);
    expect(dropEvent(state, "missing")).toBe(state);
  });

  test("fit：放得下原樣，放不下才截", () => {
    expect(fit("abc", 3)).toBe("abc");
    expect(fit("abcd", 3)).toBe("ab…");
  });
});

// 以下都是假的測試字串，不是真實金鑰。
const GH_36 = "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";

describe("秘密遮罩 maskSecrets", () => {
  test("sk- 系列（含 sk-ant-、sk-proj-）換成 sk-***，保留前綴", () => {
    expect(maskSecrets("echo sk-ant-api03-ABCDEFGHIJKLMNOP")).toBe("echo sk-***");
    expect(maskSecrets("sk-proj-abc_DEF-12345678 done")).toBe("sk-*** done");
    expect(maskSecrets("sk-12345678")).toBe("sk-***");
  });

  test("GitHub 權杖：ghp_／gho_／ghu_／ghs_／ghr_ 與 github_pat_", () => {
    expect(maskSecrets(`git clone https://x:ghp_${GH_36}@github.com/a/b`)).toBe("git clone https://x:ghp_***@github.com/a/b");
    expect(maskSecrets(`gho_${GH_36}`)).toBe("gho_***");
    expect(maskSecrets(`ghu_${GH_36} ghs_${GH_36} ghr_${GH_36}`)).toBe("ghu_*** ghs_*** ghr_***");
    expect(maskSecrets(`github_pat_${GH_36}_x`)).toBe("github_pat_***");
  });

  test("Slack、AWS、Google 金鑰", () => {
    expect(maskSecrets("curl -d token=1 xoxb-1234567890-abcdefghij")).toBe("curl -d token=*** xoxb-***");
    expect(maskSecrets("xoxp-1234567890-abcdefghij")).toBe("xoxp-***");
    expect(maskSecrets("AWS AKIAABCDEFGHIJKLMNOP end")).toBe("AWS AKIA*** end");
    expect(maskSecrets(`key AIza${"Sy0123456789abcdefghijklmnopqrstu".slice(0, 35)} end`)).toBe("key AIza*** end");
  });

  test("Bearer（不分大小寫）與 Authorization 標頭", () => {
    expect(maskSecrets("Bearer abcdef123456")).toBe("Bearer ***");
    expect(maskSecrets("bearer abc.def-123_456")).toBe("bearer ***");
    expect(maskSecrets('curl -H "Authorization: Bearer abcdef123456" url')).toBe('curl -H "Authorization: ***" url');
    expect(maskSecrets("Authorization: Basic dXNlcjpwYXNz")).toBe("Authorization: ***");
    expect(maskSecrets("authorization:abc")).toBe("authorization:***");
  });

  test("key=value、key: value、--key value 與 JSON 形式（api_key／token／secret／password／passwd／pwd／auth）", () => {
    expect(maskSecrets("API_KEY=abc123 node a.mjs")).toBe("API_KEY=*** node a.mjs");
    expect(maskSecrets("GITHUB_TOKEN=abc123")).toBe("GITHUB_TOKEN=***");
    expect(maskSecrets("password: hunter2")).toBe("password: ***");
    expect(maskSecrets("PGPASSWORD=x psql")).toBe("PGPASSWORD=*** psql");
    expect(maskSecrets("passwd=a pwd=b auth=c secret=d")).toBe("passwd=*** pwd=*** auth=*** secret=***");
    expect(maskSecrets("--api-key=abc")).toBe("--api-key=***");
    expect(maskSecrets("--api_key abc")).toBe("--api_key ***");
    expect(maskSecrets("run --token abc123def456 --verbose")).toBe("run --token *** --verbose");
    expect(maskSecrets("--client-secret s3cr3t")).toBe("--client-secret ***");
    expect(maskSecrets("token=abc&page=2")).toBe("token=***");
    expect(maskSecrets('{"token": "abc 123", "n": 1}')).toBe('{"token": "***", "n": 1}');
    expect(maskSecrets("secret='a b c' next")).toBe("secret='***' next");
    expect(maskSecrets('password="p w" next')).toBe('password="***" next');
  });

  test("一般指令、路徑與字詞不被遮罩（含容易誤判的 task-、tokens、author、pwd 指令）", () => {
    for (const text of [
      "node scripts/review-check.mjs",
      "git status",
      "git commit -m 'fix auth flow'",
      "claude plugin test .",
      "F:\\vibeCode.v.2026.8.2\\projects\\auth\\login.ts",
      "cat /etc/passwd",
      "cd $(pwd)",
      "task-management-tool risk-assessment-plan",
      "sk-short",
      "ghp_short",
      "Bearer short",
      "AKIA123",
      "npm run build --max-tokens 4096",
      "echo author=bob tokenizer=fast secretary",
      "grep -rn token src/",
      "git log --author bob",
    ]) {
      expect(maskSecrets(text)).toBe(text);
    }
  });

  test("重複套用結果不變（idempotent）", () => {
    const text = "x sk-ant-api03-ABCDEFGHIJKLMNOP --token abc123def456 Authorization: Bearer abcdef123456 password=hunter2";
    expect(maskSecrets(maskSecrets(text))).toBe(maskSecrets(text));
    expect(maskSecrets(text)).toBe("x sk-*** --token *** Authorization: *** password=***");
  });

  test("targetOf 先遮罩再截短：跨過 60 欄邊界的秘密也不會露出前綴", () => {
    const early = targetOf({ command: `echo ${"a".repeat(30)} sk-ant-api03-ABCDEFGHIJKLMNOP` });
    expect(early).toBe(`echo ${"a".repeat(30)} sk-***`);
    const edge = targetOf({ command: `${"a".repeat(54)} sk-ant-api03-ABCDEFGHIJKLMNOP` });
    expect(edge.includes("sk-ant")).toBe(false);
    expect(edge.includes("ABCDEF")).toBe(false);
    expect(targetOf({ command: "curl --token abc123def456 url" })).toBe("curl --token *** url");
  });
});

describe("記憶分頁的路徑與數字顯示", () => {
  test("displayPath：只有磁碟代號開頭才把 / 換成反斜線", () => {
    expect(displayPath("C:/Users/u/.claude/CLAUDE.md")).toBe("C:\\Users\\u\\.claude\\CLAUDE.md");
    expect(displayPath("F:\\a/b\\c.md")).toBe("F:\\a\\b\\c.md");
    expect(displayPath("/home/u/CLAUDE.md")).toBe("/home/u/CLAUDE.md");
    expect(displayPath("relative/a.md")).toBe("relative/a.md");
  });

  test("formatTokens、dirnameOf、fileNameOf", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1000)).toBe("1k");
    expect(formatTokens(1234)).toBe("1.2k");
    expect(formatTokens(15600)).toBe("15.6k");
    expect(dirnameOf("C:/a/b/MEMORY.md")).toBe("C:/a/b");
    expect(dirnameOf("C:\\a\\b\\MEMORY.md")).toBe("C:\\a\\b");
    expect(dirnameOf("/x.md")).toBe("/");
    expect(fileNameOf("C:\\a\\b\\MEMORY.md")).toBe("MEMORY.md");
    expect(fileNameOf("/a/b.md")).toBe("b.md");
  });
});
