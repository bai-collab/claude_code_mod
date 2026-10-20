import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const checks = [
  ["claude", ["plugin", "validate", "."]],
  ["claude", ["plugin", "test", "."]],
  ["node", ["--test", "scripts/list-sessions.test.mjs"]],
  ["node", ["--test", "scripts/read-quota.test.mjs"]],
];
let failed = false;

for (const [command, args] of checks) {
  process.stdout.write(`執行：${command} ${args.join(" ")}\n`);
  const result = spawnSync(command, args, {
    cwd: pluginRoot,
    shell: process.platform === "win32",
    stdio: "inherit",
  });

  if (result.error) {
    process.stderr.write(`無法啟動檢查命令：${result.error.message}\n`);
    failed = true;
  } else if (result.status !== 0) {
    process.stderr.write(`檢查命令失敗，結束碼：${result.status ?? "未知"}\n`);
    failed = true;
  }
}

process.exitCode = failed ? 1 : 0;
