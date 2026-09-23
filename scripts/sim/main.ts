/**
 * CLI for the Diggo economy simulation.
 *
 *   npm run sim                       # the whole scenario matrix in both enforcement modes
 *   npm run sim -- --scenario baseline --days 30
 *   npm run sim -- --quick            # small population, for iterating
 *   npm run sim -- --list
 *
 * Everything is deterministic for a given seed: identical arguments produce identical CSVs.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createRiskOpsConfig, type RiskOpsConfig } from "../../shared/riskOps";
import {
  DEFAULT_SIM_OPTIONS,
  SCENARIOS,
  findScenario,
  type Scenario,
  type SimOptions,
} from "./model";
import { runScenario, type SimResult } from "./engine";
import { legacyRunwayProof, runSelfChecks, runwayProof, type CheckResult } from "./selfcheck";
import {
  discoveryCapTable,
  emissionSweepTable,
  humanImpactTable,
  mineDrainTable,
  oreTable,
  powerRatioTable,
  powerTable,
  riskTable,
  runwayProofTable,
  scenarioOverview,
  toCsv,
} from "./report";

interface Cli {
  scenario: string;
  days?: number;
  humans?: number;
  bots?: number;
  stealth?: "naive" | "stealthy";
  enforcement: "shadow" | "enforce" | "both";
  seed?: number;
  rewardPerBlock?: number;
  outDir: string;
  quick: boolean;
  selfcheck: boolean;
  selfcheckOnly: boolean;
  debugPower: boolean;
  inspect: boolean;
  list: boolean;
  quiet: boolean;
}

function parseArgs(argv: readonly string[]): Cli {
  const cli: Cli = {
    scenario: "all",
    enforcement: "both",
    outDir: "scripts/sim/out",
    quick: false,
    selfcheck: true,
    selfcheckOnly: false,
    debugPower: false,
    inspect: false,
    list: false,
    quiet: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = (): string => {
      index += 1;
      const value = argv[index];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      return value;
    };
    if (arg === "--scenario") cli.scenario = next();
    else if (arg === "--days") cli.days = Number(next());
    else if (arg === "--humans") cli.humans = Number(next());
    else if (arg === "--bots") cli.bots = Number(next());
    else if (arg === "--stealth") cli.stealth = next() === "stealthy" ? "stealthy" : "naive";
    else if (arg === "--enforcement") {
      const value = next();
      cli.enforcement = value === "enforce" || value === "shadow" ? value : "both";
    } else if (arg === "--seed") cli.seed = Number(next());
    else if (arg === "--reward-per-block") cli.rewardPerBlock = Number(next());
    else if (arg === "--out") cli.outDir = next();
    else if (arg === "--quick") cli.quick = true;
    else if (arg === "--no-selfcheck") cli.selfcheck = false;
    else if (arg === "--list") cli.list = true;
    else if (arg === "--selfcheck-only") cli.selfcheckOnly = true;
    else if (arg === "--debug-power") cli.debugPower = true;
    else if (arg === "--inspect") cli.inspect = true;
    else if (arg === "--quiet") cli.quiet = true;
    else if (arg.length > 0) throw new Error(`unknown argument ${arg}`);
  }
  return cli;
}

function resolveOptions(cli: Cli, scenario: Scenario): SimOptions {
  let options = scenario.patch({ ...DEFAULT_SIM_OPTIONS });
  if (cli.days !== undefined) options = { ...options, days: cli.days };
  if (cli.seed !== undefined) options = { ...options, seed: cli.seed };
  if (cli.bots !== undefined) options = { ...options, botFarmSizes: cli.bots > 0 ? [cli.bots] : [] };
  if (cli.stealth !== undefined) options = { ...options, botStealth: cli.stealth };
  if (cli.humans !== undefined) options = { ...options, humans: cli.humans };
  if (cli.rewardPerBlock !== undefined) {
    options = {
      ...options,
      mines: options.mines.map((mine) =>
        mine.key === "flagship" ? { ...mine, rewardPerBlock: cli.rewardPerBlock! } : mine,
      ),
    };
  }
  if (cli.quick) {
    options = {
      ...options,
      humans: Math.max(50, Math.round((cli.humans ?? options.humans) / 50)),
      botFarmSizes: options.botFarmSizes.map((size) => Math.max(10, Math.round(size / 50))),
      days: cli.days ?? Math.min(options.days, 30),
    };
  }
  if (cli.debugPower) options = { ...options, debugPower: true };
  return options;
}

function labelOf(scenario: Scenario, options: SimOptions): string {
  if (options.botFarmSizes.length === 0) return scenario.key;
  const size = options.botFarmSizes.reduce((total, entry) => total + entry, 0);
  return `${scenario.key}-${options.botStealth}-${size}`;
}

/**
 * The risk-operations config for one run. A legacy run also switches the reward hold off, which is
 * the one score-derived response the hardening made mode-independent (spec 53, 63).
 */
function riskOpsFor(mode: "shadow" | "enforce", hardening: SimOptions["hardening"] = "full"): RiskOpsConfig {
  if (hardening === "legacy") {
    return createRiskOpsConfig({ enforcement: { mode }, claimHold: { states: [], actions: [] } });
  }
  return createRiskOpsConfig({ enforcement: { mode } });
}

function writeOutputs(result: SimResult, outDir: string, label: string): void {
  mkdirSync(outDir, { recursive: true });
  const write = (name: string, rows: readonly Record<string, unknown>[]): void => {
    writeFileSync(join(outDir, name), toCsv(rows), "utf8");
  };
  write(`${label}.mines.csv`, result.mines as unknown as Record<string, unknown>[]);
  write(`${label}.daily.csv`, result.daily as unknown as Record<string, unknown>[]);
  write(`${label}.discovery.csv`, result.discovery as unknown as Record<string, unknown>[]);
  write(`${label}.cohorts.csv`, result.cohorts as unknown as Record<string, unknown>[]);
  write(`${label}.power.csv`, result.powers as unknown as Record<string, unknown>[]);
  write(`${label}.risk.csv`, result.risk as unknown as Record<string, unknown>[]);
}

function daysReport(result: SimResult): number {
  return result.summary.days;
}

function buildMarkdown(results: readonly SimResult[], checks: readonly CheckResult[]): string {
  const sections: string[] = [];
  sections.push("### Scenario overview\n");
  sections.push(scenarioOverview(results));
  const baseline = results.find((result) => result.summary.scenario === "baseline");
  if (baseline) {
    sections.push("\n### Mining Reserve drain per token (reference population, no bots)\n");
    sections.push(mineDrainTable(baseline, [7, 30, 60]));
  }
  const adversarial = results.find((result) => result.summary.scenario === "bots-10000-stealthy-nogate");
  if (adversarial) {
    sections.push("\n### Mining Reserve drain per token (10k spread-out wallets, risk gate off)\n");
    sections.push(mineDrainTable(adversarial, [7, 30, 60]));
  }
  if (results.some((result) => result.summary.scenario.startsWith("sweep-"))) {
    sections.push("\n### Emission schedule and launch parameters (flagship)\n");
    sections.push(emissionSweepTable(results));
  }
  sections.push("\n### Is the whole Mining Reserve distributable? (independent model)\n");
  sections.push(runwayProofTable(runwayProof(), legacyRunwayProof()));
  sections.push("\n### Discovery caps\n");
  sections.push(discoveryCapTable(results));
  if (baseline) {
    sections.push(`\n### ORE distribution at day ${daysReport(baseline)}\n`);
    sections.push(oreTable(baseline, daysReport(baseline)));
    sections.push("\n### Mining Power by vintage\n");
    sections.push(powerTable(baseline));
    sections.push("\n### Risk posture at the end of the run\n");
    sections.push(riskTable(baseline));
  }
  const adversarialStealthy = results.find((result) => result.summary.scenario === "bots-10000-stealthy");
  if (adversarialStealthy) {
    sections.push("\n### Risk posture with 10k spread-out wallets\n");
    sections.push(riskTable(adversarialStealthy));
  }
  sections.push("\n### Mining Power ratios\n");
  sections.push(powerRatioTable(results));
  sections.push("\n### What the hardening costs honest players\n");
  sections.push(humanImpactTable(results));
  sections.push("\n### Self-checks\n");
  sections.push(
    checks
      .map((check) => `- ${check.ok ? "PASS" : "FAIL"} — ${check.name}: ${check.detail}`)
      .join("\n"),
  );
  return sections.join("\n");
}

export async function run(argv: readonly string[]): Promise<void> {
  const cli = parseArgs(argv);
  if (cli.list) {
    for (const scenario of SCENARIOS) console.log(`${scenario.key}\t${scenario.title}`);
    return;
  }
  const selected = cli.scenario === "all" ? [...SCENARIOS] : [findScenario(cli.scenario)].filter(Boolean) as Scenario[];
  if (selected.length === 0) throw new Error(`unknown scenario ${cli.scenario}`);

  const outRoot = resolve(cli.outDir);
  if (cli.inspect) {
    const scenario = findScenario("bots-100-naive")!;
    const options = resolveOptions(
      { ...cli, quick: false, days: cli.days ?? 5, humans: cli.humans ?? 0, bots: cli.bots ?? 1, debugPower: true },
      scenario,
    );
    const result = runScenario("inspect", options, riskOpsFor("shadow", options.hardening));
    console.log(JSON.stringify(result.summary, null, 2));
    return;
  }
  if (cli.selfcheckOnly) {
    const scenario = findScenario("bots-10000-stealthy")!;
    const options = resolveOptions({ ...cli, quick: true, humans: cli.humans ?? 400, bots: cli.bots ?? 400 }, scenario);
    const result = runScenario("selfcheck-reference", options, riskOpsFor("shadow", options.hardening));
    const checks = await runSelfChecks(result, riskOpsFor("shadow", options.hardening));
    console.log(checks.map((check) => `${check.ok ? "PASS" : "FAIL"} — ${check.name}: ${check.detail}`).join("\n"));
    if (checks.some((check) => !check.ok)) process.exitCode = 1;
    return;
  }
  const modes: ("shadow" | "enforce")[] =
    cli.enforcement === "both" ? ["shadow", "enforce"] : [cli.enforcement];
  const allResults: SimResult[] = [];
  const started = Date.now();

  for (const mode of modes) {
    const outDir = modes.length > 1 ? join(outRoot, mode) : outRoot;
    for (const scenario of selected) {
      const options = resolveOptions(cli, scenario);
      // The launch-parameter sweeps are pure emission questions: enforcement cannot change them.
      if (mode === "enforce" && scenario.key.startsWith("sweep-")) continue;
      const riskOps = riskOpsFor(mode, options.hardening);
      const label = `${labelOf(scenario, options)}-${mode}`;
      const scenarioKey = mode === "shadow" ? scenario.key : `${scenario.key}#enforce`;
      const result = runScenario(scenarioKey, options, riskOps);
      writeOutputs(result, outDir, label);
      allResults.push(result);
      if (!cli.quiet) {
        const summary = result.summary;
        console.log(
          `${label}: ${summary.humans} humans + ${summary.bots} bots, distributed ${Math.round(
            summary.networkDistributedCum,
          )} tokens, bot share ${(summary.networkBotMiningShareBps / 100).toFixed(1)}%, discovery $${summary.networkDiscoveryUsd.toFixed(
            2,
          )}, digest ${summary.invariants.determinismDigest}`,
        );
      }
    }
  }

  const reference = allResults[0];
  if (!reference) throw new Error("no results produced");
  const checks = cli.selfcheck ? await runSelfChecks(reference, riskOpsFor("shadow")) : [];
  const markdown = buildMarkdown(allResults, checks);
  mkdirSync(outRoot, { recursive: true });
  writeFileSync(join(outRoot, "summary.md"), markdown + "\n", "utf8");
  writeFileSync(
    join(outRoot, "summary.json"),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        seed: reference.summary.seed,
        elapsedMs: Date.now() - started,
        scenarios: allResults.map((result) => result.summary),
        checks,
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  console.log("\n" + markdown);
  console.log(`\nwrote CSVs and summary.md/json to ${outRoot} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}
