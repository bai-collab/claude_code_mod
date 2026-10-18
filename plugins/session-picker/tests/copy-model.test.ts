import { describe, expect, test } from "claude-code/testing";

import { copyLabelOf, extractCopyTargets, findCopyTargets, messageKeyOf } from "../hooks/copy-model";
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
