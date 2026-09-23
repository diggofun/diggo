/**
 * CSV and Markdown rendering for simulation results. Numbers are rendered with fixed precision so
 * a regenerated report is byte-identical for the same seed.
 */
import type { SimResult } from "./engine";
import { analyticFor, type RunwayProofRow } from "./selfcheck";

export function toCsv(rows: readonly Record<string, unknown>[]): string {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]);
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(
      headers
        .map((header) => {
          const value = row[header];
          if (value === null || value === undefined) return "";
          if (typeof value === "number") return Number.isFinite(value) ? String(Math.round(value * 1e6) / 1e6) : "";
          const text = String(value);
          return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
        })
        .join(","),
    );
  }
  return lines.join("\n") + "\n";
}

export function n0(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

export function n2(value: number): string {
  return (Math.round(value * 100) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function bpsPct(value: number, digits = 1): string {
  return `${(value / 100).toFixed(digits)}%`;
}

export function usd(value: number): string {
  return "$" + n2(value);
}

export function mdTable(headers: readonly string[], rows: readonly (readonly (string | number)[])[]): string {
  const head = `| ${headers.join(" | ")} |`;
  const rule = `| ${headers.map(() => "---").join(" | ")} |`;
  const body = rows.map((row) => `| ${row.join(" | ")} |`);
  return [head, rule, ...body].join("\n");
}

function mineAt(result: SimResult, mineKey: string, day: number) {
  return result.mines.find((row) => row.mineKey === mineKey && row.day === day);
}

/** Column days for the drain table: the requested snapshots plus the last day, deduplicated. */
function drainDays(result: SimResult, requested: readonly number[]): number[] {
  const days = new Set(requested.filter((day) => day <= result.summary.days));
  days.add(result.summary.days);
  return [...days].sort((left, right) => left - right);
}

/** One line per scenario: what the run did and what it cost. */
export function scenarioOverview(results: readonly SimResult[]): string {
  const rows = results.map((result) => {
    const summary = result.summary;
    const flagship = summary.mines.find((mine) => mine.mineKey === "flagship") ?? summary.mines[0];
    return [
      summary.scenario,
      n0(summary.humans),
      n0(summary.bots),
      summary.bots > 0 ? summary.botStealth : "-",
      flagship.fullyMinedDay === null ? "not mined out" : `day ${flagship.fullyMinedDay}`,
      n0(summary.networkDistributedCum),
      bpsPct(summary.networkBotMiningShareBps),
      bpsPct(summary.networkBotReleasedShareBps),
      n0(summary.networkHeldTokens),
      usd(summary.networkDiscoveryUsd),
      bpsPct(summary.networkDiscoveryBotShareBps),
      n0(summary.strandedTokens),
    ];
  });
  return mdTable(
    [
      "Scenario",
      "Humans",
      "Bots",
      "Style",
      "Flagship FULLY_MINED",
      "Tokens distributed (90d)",
      "Bot share of mined",
      "Bot share released",
      "Held tokens",
      "Discovery spent",
      "Bot share of discovery",
      "Stranded tokens",
    ],
    rows,
  );
}

/** Reserve drain per mine over time, for one scenario. */
export function mineDrainTable(result: SimResult, days: readonly number[]): string {
  const columns = drainDays(result, days);
  const rows = result.summary.mines.map((mine) => {
    const cells = columns.map((day) => {
      const row = mineAt(result, mine.mineKey, day);
      return row ? n0(row.remainingReserve) : "-";
    });
    return [
      `${mine.symbol} (${mine.mineKey})`,
      n0(mine.initialReserve),
      `${mine.lifetimeDays} days`,
      n0(mine.rewardPerBlock),
      n0(mine.rewardPerBlockAtEnd),
      ...cells,
      n0(mine.reserveRemainingEnd),
      mine.fullyMinedDay === null ? "not mined out" : `day ${mine.fullyMinedDay}`,
      bpsPct(mine.botMiningShareBps),
      bpsPct(mine.botReleasedShareBps),
    ];
  });
  return mdTable(
    [
      "Mine",
      "Reserve",
      "Target lifetime",
      "Launch reward/block",
      "Reward/block at end",
      ...columns.map((day) => `day ${day}`),
      "Reserve at end",
      "FULLY_MINED",
      "Bot share of mined",
      "Bot share released",
    ],
    rows,
  );
}

/**
 * What the launch parameters do to the reserve runway. Every sweep row is cross-checked against the
 * independent model in selfcheck.ts, so "the whole reserve can be distributed" is a measured claim
 * rather than a reading of the schedule code.
 */
export function emissionSweepTable(results: readonly SimResult[]): string {
  const rows = results
    .filter((result) => result.summary.scenario.startsWith("sweep-"))
    .map((result) => {
      const spec = result.options.mines.find((mine) => mine.key === "flagship");
      const flagship = result.summary.mines.find((mine) => mine.mineKey === "flagship");
      if (!spec || !flagship) return null;
      const analytic = analyticFor(result.options, spec);
      return [
        result.summary.scenario.replace("sweep-", ""),
        n0(spec.rewardPerBlock),
        `${spec.lifetimeDays} days`,
        n0(flagship.rewardPerBlockAtEnd),
        flagship.fullyMinedDay === null ? "not mined out" : `day ${flagship.fullyMinedDay}`,
        analytic.fullyMinedDay === null ? "never" : `day ${analytic.fullyMinedDay}`,
        bpsPct(flagship.reserveDrainedBps),
        bpsPct(flagship.botReleasedShareBps),
      ];
    })
    .filter((row): row is string[] => row !== null);
  return mdTable(
    [
      "Flagship launch parameters",
      "Launch reward/block",
      "Target lifetime",
      "Reward/block at day 90",
      "FULLY_MINED (simulated)",
      "FULLY_MINED (analytic)",
      "Reserve distributed (90d)",
      "Bot share released",
    ],
    rows,
  );
}

/** The whole-reserve guarantee, before and after, across launch parameters (spec 20, 21). */
export function runwayProofTable(
  rows: readonly RunwayProofRow[],
  legacy: readonly { fullyMinedDay: number | null; shareOfReserve: number }[],
): string {
  const table = rows.map((row, index) => {
    const before = legacy[index];
    return [
      row.label,
      n0(row.reserve),
      n0(row.launchRewardPerBlock),
      `${row.targetLifetimeDays} days`,
      before === undefined || before.fullyMinedDay === null
        ? `${bpsPct(Math.round((before?.shareOfReserve ?? 0) * 10_000))} locked forever`
        : `${bpsPct(Math.round(before.shareOfReserve * 10_000))}, day ${before.fullyMinedDay}`,
      row.fullyMinedDay === null
        ? "NO - tokens stay locked"
        : `100.0%, day ${row.fullyMinedDay}`,
    ];
  });
  return mdTable(
    [
      "Launch parameters",
      "Reserve",
      "Launch reward/block",
      "Target lifetime",
      "BEFORE (fixed reduction)",
      "AFTER (reserve runway)",
    ],
    table,
  );
}

/** What the hardening costs the honest population (spec 63: a false positive has to stay cheap). */
export function humanImpactTable(results: readonly SimResult[]): string {
  const keys = ["baseline", "bots-10000-stealthy", "baseline-legacy", "bots-10000-stealthy-legacy"];
  const rows = results
    .filter((result) => keys.includes(result.summary.scenario))
    .map((result) => {
      const summary = result.summary;
      const day = summary.days;
      const humans = result.risk.find((row) => row.day === day && row.cohort === "human");
      const cohort = result.cohorts.find((row) => row.day === day && row.cohort === "human");
      const humanReleased = summary.mines.reduce((total, mine) => total + mine.humanPaidTokens, 0);
      const humanHeld = summary.mines.reduce((total, mine) => total + mine.humanHeldTokens, 0);
      return [
        summary.scenario,
        n0(summary.humansRetainedEnd),
        n2(SummaryPerPlayer(humanReleased, summary.humansRetainedEnd)),
        n2(SummaryPerPlayer(humanHeld, summary.humansRetainedEnd)),
        cohort ? n0(cohort.oreEarnedP50) : "-",
        cohort ? n0(cohort.powerP50) : "-",
        cohort ? n0(cohort.effectivePowerP50) : "-",
        n0(humans ? humans.underReview + humans.held + humans.blocked : 0),
        n0(humans ? humans.normal : 0),
      ];
    });
  return mdTable(
    [
      "Scenario",
      "Humans retained",
      "Tokens released per human",
      "Tokens held per human",
      "ORE earned p50",
      "Power p50",
      "Effective power p50",
      "Humans held/reviewed/blocked",
      "Humans NORMAL",
    ],
    rows,
  );
}

function SummaryPerPlayer(total: number, players: number): number {
  return players > 0 ? total / players : 0;
}


/** What the discovery caps did, and what removing them would cost. */
function releasedBotShareBps(summary: SimResult["summary"]): number {
  const total = summary.mines.reduce(
    (sum, mine) => sum + mine.discoveryHumanReleasedTokens + mine.discoveryBotReleasedTokens,
    0,
  );
  const bots = summary.mines.reduce((sum, mine) => sum + mine.discoveryBotReleasedTokens, 0);
  return total > 0 ? Math.round((bots / total) * 10_000) : 0;
}

export function discoveryCapTable(results: readonly SimResult[]): string {
  const keys = ["bots-10000-stealthy", "bots-10000-stealthy-caps-5x", "bots-10000-stealthy-caps-off", "baseline"];
  const rows = results
    .filter((result) => keys.includes(result.summary.scenario))
    .map((result) => {
      const summary = result.summary;
      const hits = result.discovery.reduce((total, row) => total + row.hits, 0);
      const denials = Object.entries(summary.capDenials)
        .sort((left, right) => right[1] - left[1])
        .slice(0, 3)
        .map(([reason, count]) => `${reason}: ${n0(count)}`)
        .join(", ");
      const usedBps = summary.mines.reduce((total, mine) => total + mine.discoveryReserveUsedBps, 0) / summary.mines.length;
      return [
        summary.scenario,
        usd(summary.networkDiscoveryUsd),
        bpsPct(summary.networkDiscoveryBotShareBps),
        bpsPct(releasedBotShareBps(summary)),
        n0(summary.mines.reduce((total, mine) => total + mine.discoveryHeldTokens, 0)),
        bpsPct(usedBps),
        n0(hits),
        denials.length > 0 ? denials : "-",
      ];
    });
  return mdTable(
    [
      "Scenario",
      "Discovery paid out (90d)",
      "Bot share committed",
      "Bot share released",
      "Held discovery tokens",
      "Avg Discovery Reserve used",
      "Discovery hits",
      "Top cap refusals",
    ],
    rows,
  );
}

/** ORE distribution percentiles per cohort. */
export function oreTable(result: SimResult, day: number): string {
  const rows = result.cohorts
    .filter((row) => row.day === day)
    .map((row) => [
      row.cohort === "human" ? `Humans (${n0(row.players)})` : `Bots (${n0(row.players)})`,
      n0(row.oreBalanceP10),
      n0(row.oreBalanceP50),
      n0(row.oreBalanceP90),
      n0(row.oreBalanceP99),
      n0(row.oreBalanceMean),
      n0(row.oreEarnedP50),
      n0(row.oreEarnedP90),
      n0(row.oreOverflowMean),
      n0(row.powerP50),
      n0(row.effectivePowerP50),
      n0(row.streakP50),
    ]);
  return mdTable(
    [
      "Cohort",
      "ORE p10",
      "ORE p50",
      "ORE p90",
      "ORE p99",
      "ORE mean",
      "Earned p50",
      "Earned p90",
      "Overflow mean",
      "Power p50",
      "Effective power p50",
      "Streak p50",
    ],
    rows,
  );
}

/** Mining Power by vintage: veterans versus day-1 and day-7 players. */
export function powerTable(result: SimResult): string {
  const days = [...new Set(result.powers.map((row) => row.day))].sort((a, b) => a - b);
  const labels: Readonly<Record<string, string>> = {
    day1: "Joined day 1 (veterans)",
    day7: "Joined day 7",
    "day2-6": "Joined day 2-6",
    "day8-30": "Joined day 8-30",
    "day31+": "Joined day 31+",
    bot: "Scripted wallets",
  };
  const rows: (string | number)[][] = [];
  for (const [vintage, label] of Object.entries(labels)) {
    if (!result.powers.some((row) => row.vintage === vintage)) continue;
    rows.push([
      label,
      ...days.map((day) => {
        const row = result.powers.find((entry) => entry.day === day && entry.vintage === vintage);
        return row ? n0(row.powerP50) : "-";
      }),
    ]);
  }
  return mdTable(["Vintage", ...days.map((day) => `day ${day}`)], rows);
}

/** Risk posture at the end of the run. */
export function riskTable(result: SimResult): string {
  const day = result.summary.days;
  const rows = result.risk
    .filter((row) => row.day === day)
    .map((row) => [
      row.cohort === "human" ? `Humans (${n0(row.players)})` : `Bots (${n0(row.players)})`,
      n0(row.scoreP50),
      n0(row.scoreP90),
      n0(row.normal),
      n0(row.underReview),
      n0(row.held),
      n0(row.blocked),
      n0(row.claimsAllowed),
      n0(row.discoveriesAllowed),
      n0(row.trustP50),
    ]);
  return mdTable(
    [
      "Cohort",
      "Score p50",
      "Score p90",
      "NORMAL",
      "UNDER_REVIEW",
      "HELD",
      "BLOCKED",
      "Claims allowed",
      "Discoveries allowed",
      "Trust p50",
    ],
    rows,
  );
}

export function powerRatioTable(results: readonly SimResult[]): string {
  const rows = results
    .filter((result) => result.summary.scenario === "baseline" || result.summary.scenario === "bots-10000-stealthy")
    .map((result) => {
      const ratios = result.summary.powerRatios;
      return [
        result.summary.scenario,
        n0(ratios.starterPower),
        n0(ratios.day1P50),
        n0(ratios.day7P50),
        n0(ratios.veteranP50),
        n0(ratios.veteranEffectiveP50),
        n2(ratios.veteranVsDay1) + "x",
        n2(ratios.veteranVsDay7) + "x",
        n0(ratios.lateEntrantDay7At14P50),
        n2(ratios.theoreticalMaxRatio) + "x",
      ];
    });
  return mdTable(
    [
      "Scenario",
      "Starter",
      "Day-1 p50",
      "Day-7 p50",
      "Day-90 veteran p50",
      "Day-90 veteran effective p50",
      "Veteran vs day-1",
      "Veteran vs day-7",
      "Day-7 joiner at day 14",
      "Theoretical max",
    ],
    rows,
  );
}
