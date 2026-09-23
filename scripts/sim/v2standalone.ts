/**
 * The v2 section on its own, with no dependency on the v4 harness (WS-G).
 *
 * The full report (scripts/sim/main.ts) pulls in engine.ts and therefore every shared/ module. The
 * v2 rules are the economy the program will actually have, and they have to stay runnable while
 * WS-A, B, C, D and E are rewriting those shared modules underneath the v4 harness - so the rules,
 * the runner and the report are imported here and nowhere else.
 *
 *   node scripts/sim/run-v2.mjs
 */
import { DEFAULT_V2_OPTIONS, runV2, type V2Options } from "./v2";
import { v2Checks, v2Section, v2Table } from "./v2report";

export function runV2Section(options: V2Options = DEFAULT_V2_OPTIONS): {
  markdown: string;
  checks: { ok: boolean; name: string; detail: string }[];
} {
  const result = runV2(options);
  return { markdown: v2Section(result), checks: v2Checks(result) };
}

export function run(): void {
  const result = runV2();
  const checks = v2Checks(result);
  console.log(v2Table(result));
  console.log(v2Section(result));
  console.log(
    "\n" +
      checks
        .map(
          (check) =>
            (check.ok ? "PASS" : "FAIL") + " - " + check.name + ": " + check.detail,
        )
        .join("\n"),
  );
  if (checks.some((check) => !check.ok)) process.exitCode = 1;
}
