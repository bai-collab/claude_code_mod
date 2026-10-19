import { describe, expect, test } from "claude-code/testing";

import { copyLabelOf, copyShownOf, extractCopyTargets, findCopyTargets, messageKeyOf } from "../hooks/copy-model";
import { textWidth } from "../hooks/flow-model";

const FENCE = "```";

// Windows 路徑一律用 String.raw 寫，避免反斜線被跳脫。
function rawsOf(text: string): string[] {
  return findCopyTargets(text).map((target) => target.raw);
}

describe("回覆內路徑與網址的抽取", () => {
  test("Windows 絕對路徑：反斜線與斜線都認，原樣保留（不轉換斜線）", () => {
    const text = String.raw`改了 F:\vibeCode.v.2026.8.2\projects\claude-session-picker\README.md 和 C:/Users/u/notes.txt 兩個檔`;

    expect(findCopyTargets(text)).toEqual([
      { raw: String.raw`F:\vibeCode.v.2026.8.2\projects\claude-session-picker\README.md`, kind: "path" },
      { raw: "C:/Users/u/notes.txt", kind: "path" },
    ]);
  });

  test("路徑後面接中文標點或全形括號、引號時在標點處停下，標點不進路徑", () => {
    const text = String.raw`檔案在F:\a\b.txt，還有 F:\c\d。以及（F:\e\f）和「F:\g\h」！再來『F:\i\j』、F:\k\l；F:\m\n：結束`;

    expect(rawsOf(text)).toEqual([
      String.raw`F:\a\b.txt`,
      String.raw`F:\c\d`,
      String.raw`F:\e\f`,
      String.raw`F:\g\h`,
      String.raw`F:\i\j`,
      String.raw`F:\k\l`,
      String.raw`F:\m\n`,
    ]);
  });

  test("``` 圍欄裡的路徑與行內反引號裡的路徑都抓得到（反引號是終止字元）", () => {
    const text = [
      `${FENCE}text`,
      String.raw`F:\work\out.log`,
      FENCE,
      "輸出在 `" + String.raw`C:\x\y.md` + "` 這裡，另一個 `" + "D:/data/z.csv" + "`。",
    ].join("\n");

    expect(rawsOf(text)).toEqual([String.raw`F:\work\out.log`, String.raw`C:\x\y.md`, "D:/data/z.csv"]);
  });

  test("網址：埠、查詢字串、片段都保留；結尾的標點與 > ) 剝掉", () => {
    const text = [
      "開 http://127.0.0.1:5181/n5.html?x=1&y=2#top, 與 (https://github.com/paneline).",
      "還有 <https://x.test/a> 和 https://example.com/path/，結束",
    ].join("\n");

    expect(rawsOf(text)).toEqual([
      "http://127.0.0.1:5181/n5.html?x=1&y=2#top",
      "https://github.com/paneline",
      "https://x.test/a",
      "https://example.com/path/",
    ]);
  });

  test("結尾標點 . , ; : ) ] } 與全形標點都剝掉（路徑與網址一樣）", () => {
    const text = String.raw`見 F:\a\b.txt. 也看 F:\c\d; 或 [F:\e\f] 以及 {F:\g\h} 和 F:\i\j: 還有 https://x.test/p); 最後 https://y.test/q。`;

    expect(rawsOf(text)).toEqual([
      String.raw`F:\a\b.txt`,
      String.raw`F:\c\d`,
      String.raw`F:\e\f`,
      String.raw`F:\g\h`,
      String.raw`F:\i\j`,
      "https://x.test/p",
      "https://y.test/q",
    ]);
  });

  test("去重，依第一次出現的順序", () => {
    const text = String.raw`F:\a\b.txt 然後 https://x.test/a 再來 F:\c\d 又是 F:\a\b.txt 和 https://x.test/a`;

    expect(rawsOf(text)).toEqual([String.raw`F:\a\b.txt`, "https://x.test/a", String.raw`F:\c\d`]);
  });

  test("字中間的磁碟代號不算（xF:\\foo）；單獨的 F:、時間 12:30、數字開頭都不誤判", () => {
    expect(rawsOf(String.raw`看 xF:\foo 和 a1:\bar 與 9C:\baz`)).toEqual([]);
    expect(rawsOf("磁碟 F: 的空間，時間 12:30 開會，比例 3:1，key:value，a:b")).toEqual([]);
    // 磁碟代號前面是空白、括號、中文字都算起頭
    expect(rawsOf(String.raw`(F:\a) 在F:\b 與\F:\c`)).toEqual([String.raw`F:\a`, String.raw`F:\b`, String.raw`F:\c`]);
  });

  test("網址裡的 C:/… 不會另外被當成路徑；只有 http:// 與 https:// 才算網址", () => {
    expect(rawsOf("看 https://x.test/path?file=C:/foo/bar.txt 吧")).toEqual(["https://x.test/path?file=C:/foo/bar.txt"]);
    expect(rawsOf("ftp://x.test/a 和 https:// 單獨 與 mailto:a@b.test")).toEqual([]);
  });

  test("最多 8 顆，超過的回報還剩幾個；剛好 8 個不顯示剩餘", () => {
    const paths = Array.from({ length: 10 }, (_, index) => String.raw`F:\dir\file${index}.txt`);

    const ten = extractCopyTargets(paths.join(" "));
    expect(ten.shown.map((target) => target.raw)).toEqual(paths.slice(0, 8));
    expect(ten.more).toBe(2);

    const eight = extractCopyTargets(paths.slice(0, 8).join(" "));
    expect(eight.shown).toHaveLength(8);
    expect(eight.more).toBe(0);

    expect(extractCopyTargets("沒有任何路徑")).toEqual({ shown: [], more: 0 });
  });
});

describe("按鈕標籤", () => {
  test("路徑：檔案名稱、資料夾名稱（含結尾斜線）、磁碟根目錄", () => {
    expect(copyLabelOf(String.raw`C:\a\b\report.md`, "path")).toBe("⧉ report.md");
    expect(copyLabelOf("C:/a/b/report.md", "path")).toBe("⧉ report.md");
    expect(copyLabelOf("F:\\proj\\docs\\", "path")).toBe("⧉ docs");
    expect(copyLabelOf("F:/proj/docs/", "path")).toBe("⧉ docs");
    expect(copyLabelOf("F:\\", "path")).toBe("⧉ F:\\");
  });

  test("網址：主機[:埠]＋最後一個非空路徑區段；查詢字串、片段、帳密不進標籤", () => {
    expect(copyLabelOf("http://127.0.0.1:5181/n5.html", "url")).toBe("⧉ 127.0.0.1:5181/n5.html");
    expect(copyLabelOf("https://github.com/paneline", "url")).toBe("⧉ github.com/paneline");
    expect(copyLabelOf("https://github.com/a/b/", "url")).toBe("⧉ github.com/b");
    expect(copyLabelOf("https://example.com/", "url")).toBe("⧉ example.com");
    expect(copyLabelOf("https://example.com", "url")).toBe("⧉ example.com");
    expect(copyLabelOf("https://user:pw@host.test:8080/a/f.html?x=1#s", "url")).toBe("⧉ host.test:8080/f.html");
  });

  test("標籤套 maskSecrets，但複製的原文（raw）不遮罩", () => {
    const url = "https://x.test/cb?token=abc123def456";
    const [target] = extractCopyTargets(`請開 ${url} 完成`).shown;
    expect(target?.raw).toBe(url);
    expect(target?.label).toBe("⧉ x.test/cb");
    expect(target?.label.includes("abc123def456")).toBe(false);

    const inPath = extractCopyTargets("看 https://x.test/token=abc123def456 吧").shown[0];
    expect(inPath?.raw).toBe("https://x.test/token=abc123def456");
    expect(inPath?.label).toBe("⧉ x.test/token=***");

    const key = extractCopyTargets(String.raw`金鑰檔 C:\keys\sk-abcdefghij123456.txt`).shown[0];
    expect(key?.raw).toBe(String.raw`C:\keys\sk-abcdefghij123456.txt`);
    expect(key?.label).toBe("⧉ sk-***.txt");
  });

  test("標籤超過 28 欄時截斷並加省略號（前綴不算在 28 欄內）", () => {
    const long = copyLabelOf("F:\\x\\" + "a".repeat(60) + ".txt", "path");
    expect(long.startsWith("⧉ ")).toBe(true);
    expect(long.endsWith("…")).toBe(true);
    expect(textWidth(long.slice(2))).toBeLessThanOrEqual(28);

    const wide = copyLabelOf("F:\\x\\" + "很長的檔名".repeat(10) + ".md", "path");
    expect(wide.endsWith("…")).toBe(true);
    expect(textWidth(wide.slice(2))).toBeLessThanOrEqual(28);

    // 剛好放得下就原樣
    const exact = "e".repeat(28);
    expect(copyLabelOf(`F:\\x\\${exact}`, "path")).toBe(`⧉ ${exact}`);
  });
});

// 把幾行包成 ``` 圍欄區塊。
function fenced(...lines: string[]): string {
  return [`${FENCE}text`, ...lines, FENCE].join("\n");
}

function summaryOf(text: string): { kind: string; raw: string; label: string }[] {
  return extractCopyTargets(text).shown.map(({ kind, raw, label }) => ({ kind, raw, label }));
}

describe("圍欄裡的指令按鈕", () => {
  test("單行以 / 開頭：標籤是不含斜線的指令名稱，複製整行原文", () => {
    expect(summaryOf(fenced("/rename 結案 | x｜y"))).toEqual([
      { kind: "command", raw: "/rename 結案 | x｜y", label: "⧉ rename" },
    ]);
    expect(summaryOf(fenced("/copy 2"))).toEqual([{ kind: "command", raw: "/copy 2", label: "⧉ copy" }]);
    // 斜線後沒有名稱時退回那個字本身
    expect(summaryOf(fenced("/"))).toEqual([{ kind: "command", raw: "/", label: "⧉ /" }]);
  });

  test("其他單行：標籤取前兩個字，含 \\ 或 / 的字只留最後一段", () => {
    expect(summaryOf(fenced("node harness/cli/review-loop.mjs a.json"))).toEqual([
      { kind: "command", raw: "node harness/cli/review-loop.mjs a.json", label: "⧉ node review-loop.mjs" },
    ]);
    expect(summaryOf(fenced("npm.cmd test"))[0]?.label).toBe("⧉ npm.cmd test");
    expect(summaryOf(fenced("ls"))[0]?.label).toBe("⧉ ls");
    expect(summaryOf(fenced("git status -s"))[0]?.label).toBe("⧉ git status");
    expect(summaryOf(fenced(String.raw`cd F:\work\proj`))[0]?.label).toBe("⧉ cd proj");
  });

  test("多行且沒有標題：標籤是「指令（N 行）」，複製整段內容（含中間的空白行）", () => {
    expect(summaryOf(fenced("cd /work", "", "npm.cmd test"))).toEqual([
      { kind: "command", raw: "cd /work\n\nnpm.cmd test", label: "⧉ 指令（3 行）" },
    ]);
  });

  test("# 標題開頭：標題當標籤、其餘（去掉標題後緊接的空白行）當複製內容，先於單行規則判斷", () => {
    expect(summaryOf(fenced("# 結案指令", "", "", "npm.cmd test", "npm.cmd run lint"))).toEqual([
      { kind: "command", raw: "npm.cmd test\nnpm.cmd run lint", label: "⧉ 結案指令" },
    ]);
    // 其餘只有一行也用標題（不會落到「前兩個字」規則）
    expect(summaryOf(fenced("# 跑測試", "/copy 2"))).toEqual([{ kind: "command", raw: "/copy 2", label: "⧉ 跑測試" }]);
  });

  test("只有標題的區塊、空區塊、只有空白行的區塊：沒有按鈕", () => {
    expect(extractCopyTargets(fenced("# 只有標題"))).toEqual({ shown: [], more: 0 });
    expect(extractCopyTargets(fenced("# 只有標題", "", ""))).toEqual({ shown: [], more: 0 });
    expect(extractCopyTargets(fenced())).toEqual({ shown: [], more: 0 });
    expect(extractCopyTargets(fenced("", "   ", ""))).toEqual({ shown: [], more: 0 });
  });

  test("CRLF 換行：照樣認得圍欄，複製內容不含 \\r", () => {
    const text = ["說明", "```bash", "cd /work", "npm.cmd test", "```", ""].join("\r\n");

    expect(summaryOf(text)).toEqual([{ kind: "command", raw: "cd /work\nnpm.cmd test", label: "⧉ 指令（2 行）" }]);
  });

  test("縮排的圍欄：去掉非空白行共同的最小縮排，其餘縮排保留", () => {
    const text = ["  ```bash", "    git status", "      -s", "", "    git diff", "  ```"].join("\n");

    expect(summaryOf(text)).toEqual([
      { kind: "command", raw: "git status\n  -s\n\ngit diff", label: "⧉ 指令（4 行）" },
    ]);
  });

  test("沒有結尾的圍欄忽略、維持一般文字：不出指令按鈕，裡面的路徑照舊抓", () => {
    expect(extractCopyTargets(["```bash", "npm.cmd test"].join("\n"))).toEqual({ shown: [], more: 0 });

    const withPath = ["```text", String.raw`看 F:\work\out.log`].join("\n");
    expect(summaryOf(withPath)).toEqual([{ kind: "path", raw: String.raw`F:\work\out.log`, label: "⧉ out.log" }]);
  });

  test("區塊內容剛好是一個路徑或一個網址：不出指令按鈕，仍當一般文字抓成路徑／網址按鈕", () => {
    expect(summaryOf(fenced(String.raw`F:\work\out.log`))).toEqual([
      { kind: "path", raw: String.raw`F:\work\out.log`, label: "⧉ out.log" },
    ]);
    expect(summaryOf(fenced("https://x.test/a/b.html"))).toEqual([
      { kind: "url", raw: "https://x.test/a/b.html", label: "⧉ x.test/b.html" },
    ]);
  });

  test("指令區塊裡的路徑與網址不另外出按鈕；區塊外的照常", () => {
    const text = [
      String.raw`先看 F:\before\a.txt`,
      fenced(String.raw`cd F:\work && node run.mjs https://x.test/in-block`),
      String.raw`再看 F:\after\b.txt`,
    ].join("\n");

    expect(summaryOf(text)).toEqual([
      { kind: "path", raw: String.raw`F:\before\a.txt`, label: "⧉ a.txt" },
      { kind: "command", raw: String.raw`cd F:\work && node run.mjs https://x.test/in-block`, label: "⧉ cd work" },
      { kind: "path", raw: String.raw`F:\after\b.txt`, label: "⧉ b.txt" },
    ]);
  });

  test("沒產生按鈕的圍欄區塊結尾不會被當成下一個圍欄的開頭", () => {
    const text = [fenced(String.raw`F:\a\one.txt`), "中間文字", fenced("npm.cmd test")].join("\n");

    expect(summaryOf(text)).toEqual([
      { kind: "path", raw: String.raw`F:\a\one.txt`, label: "⧉ one.txt" },
      { kind: "command", raw: "npm.cmd test", label: "⧉ npm.cmd test" },
    ]);
  });

  test("混合順序依第一次出現；同種同原文去重（指令以整段原文比對）", () => {
    const text = [
      String.raw`改了 F:\a\x.txt`,
      fenced("npm.cmd test"),
      "開 https://x.test/p",
      fenced("npm.cmd test"),
      String.raw`又是 F:\a\x.txt 與 https://x.test/p`,
      fenced("npm.cmd  test"),
    ].join("\n");

    expect(summaryOf(text).map((target) => `${target.kind}:${target.raw}`)).toEqual([
      String.raw`path:F:\a\x.txt`,
      "command:npm.cmd test",
      "url:https://x.test/p",
      "command:npm.cmd  test",
    ]);
  });

  test("8 顆上限橫跨三種按鈕：依出現順序取前 8，超出的回報 more", () => {
    const text = [
      ...Array.from({ length: 4 }, (_, index) => String.raw`F:\dir\file${index}.txt`),
      fenced("npm.cmd run a"),
      "https://x.test/u1 https://x.test/u2",
      fenced("npm.cmd run b"),
      fenced("npm.cmd run c"),
      fenced("npm.cmd run d"),
    ].join("\n");

    const { shown, more } = extractCopyTargets(text);

    expect(shown.map((target) => target.kind)).toEqual([
      "path",
      "path",
      "path",
      "path",
      "command",
      "url",
      "url",
      "command",
    ]);
    expect(shown[7]?.raw).toBe("npm.cmd run b");
    expect(more).toBe(2);
    expect(extractCopyTargets(text, 3).more).toBe(7);
  });

  test("標籤遮罩秘密、複製的 raw 一字不改（含標題行以外的秘密）", () => {
    const secret = "abc123def456";
    const [target] = extractCopyTargets(fenced(`# 設定 token=${secret}`, `curl --token ${secret} https://x.test`)).shown;

    expect(target?.kind).toBe("command");
    expect(target?.raw).toBe(`curl --token ${secret} https://x.test`);
    expect(target?.label).toBe("⧉ 設定 token=***");
    expect(target?.label.includes(secret)).toBe(false);

    const single = extractCopyTargets(fenced(`export API_KEY=${secret}`)).shown[0];
    expect(single?.raw).toBe(`export API_KEY=${secret}`);
    expect(single?.label.includes(secret)).toBe(false);
  });

  test("標籤超過 28 欄時截斷並加省略號", () => {
    const label = extractCopyTargets(fenced("# " + "很長的標題".repeat(10), "npm.cmd test")).shown[0]?.label ?? "";

    expect(label.startsWith("⧉ ")).toBe(true);
    expect(label.endsWith("…")).toBe(true);
    expect(textWidth(label.slice(2))).toBeLessThanOrEqual(28);
  });
});

describe("狀態列顯示文字", () => {
  test("單行：去控制字元並遮罩", () => {
    expect(copyShownOf(String.raw`F:\a\b.txt`)).toBe(String.raw`F:\a\b.txt`);
    expect(copyShownOf("https://x.test/cb?token=abc123def456")).toBe("https://x.test/cb?token=***");
  });

  test("多行：遮罩後的第一個非空行加「…（共 N 行）」，只有一行", () => {
    const shown = copyShownOf("\ncurl --token abc123def456 https://x.test\nnpm.cmd test\n");

    expect(shown).toBe("curl --token *** https://x.test…（共 4 行）");
    expect(shown.includes("\n")).toBe(false);
    expect(shown.includes("abc123def456")).toBe(false);
  });
});

describe("訊息鍵", () => {
  test("FNV-1a 32 位元：已知向量、固定 8 位十六進位、內容不同鍵不同", () => {
    expect(messageKeyOf("")).toBe("811c9dc5");
    expect(messageKeyOf("a")).toBe("e40c292c");
    expect(messageKeyOf("foobar")).toBe("bf9cf968");
    expect(messageKeyOf("同一段文字")).toBe(messageKeyOf("同一段文字"));
    expect(messageKeyOf("訊息 A")).not.toBe(messageKeyOf("訊息 B"));
    expect(messageKeyOf("訊息 A")).toMatch(/^[0-9a-f]{8}$/);
  });
});
