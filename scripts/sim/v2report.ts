/**
 * The report section for the v2 arms (WS-G).
 *
 * The checks here are the same properties the Rust suite pins against the program itself, checked
 * against the model so a change to the model cannot quietly break them: the starter tranche cap,
 * starter mode's zero capital and zero discovery, and the fact that bonding buys a larger share
 * than starter mode while the cap still holds the farm below what the v4 economy gave it.
 */
import { BPS, STARTER_TRANCHE_BPS } from "./v2rules";
import type { ArmResult, V2Result } from "./v2";

export interface V2Check {
  ok: boolean;
  name: string;
  detail: string;
}

function whole(value: bigint): string {
  return value.toLocaleString("en-US");
}

/** Lamports as SOL with three decimals, without a float. */
export function sol(lamports: bigint): string {
  const wholeSol = lamports / 1_000_000_000n;
  const fraction = (lamports % 1_000_000_000n).toString().padStart(9, "0");
  return whole(wholeSol) + "." + fraction.slice(0, 3);
}

function percent(bps: number): string {
  return (bps / 100).toFixed(2) + "%";
}

function row(arm: ArmResult): string {
  const cells = [
    arm.title,
    percent(arm.botShareBps),
    whole(arm.botTokens),
    whole(arm.humanTokens),
    whole(arm.reserveRemainderTokens),
    percent(arm.peakStarterBlockShareBps),
    sol(arm.botBondLamports) + " SOL",
    sol(arm.botDiscoveryLamports) + " SOL",
    sol(arm.humanDiscoveryLamports) + " SOL",
    sol(arm.refusedByCapLamports) + " SOL",
  ];
  return "| " + cells.join(" | ") + " |";
}

/** The markdown table for the three arms. */
export function v2Table(result: V2Result): string {
  const header =
    "| Arm | Farm share of mined tokens | Farm tokens | Human tokens | Unassigned, left in the reserve | Peak starter share of a block | Farm bonds locked | Farm discovery | Human discovery | Refused by the caps |\n" +
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n";
  return header + result.arms.map(row).join("\n");
}

export function v2Checks(result: V2Result): V2Check[] {
  const starter = result.arms.find((arm) => arm.key === "starter-bots");
  const bonded = result.arms.find((arm) => arm.key === "bonded-bots");
  const v4 = result.arms.find((arm) => arm.key === "v4-arm");
  if (!starter || !bonded || !v4) {
    return [{ ok: false, name: "v2 arms present", detail: "an arm is missing" }];
  }
  const capBps = Number(STARTER_TRANCHE_BPS);
  return [
    {
      ok: starter.peakStarterBlockShareBps <= capBps,
      name: "v2: the starter tranche never takes more than its share of a block",
      detail:
        "peak " +
        percent(starter.peakStarterBlockShareBps) +
        " of one block, cap " +
        percent(capBps),
    },
    {
      ok: starter.botBondLamports === 0n,
      name: "v2: starter mode costs the farm no capital",
      detail: "a starter-mode farm parks " + sol(starter.botBondLamports) + " SOL",
    },
    {
      ok: starter.botDiscoveryLamports === 0n,
      name: "v2: starter mode is not eligible for discovery",
      detail: "a starter-mode farm was paid " + sol(starter.botDiscoveryLamports) + " SOL",
    },
    {
      ok: starter.botShareBps <= capBps,
      name: "v2: a starter-mode farm captures at most the tranche cap",
      detail: "farm share " + percent(starter.botShareBps),
    },
    {
      ok: bonded.botShareBps > starter.botShareBps,
      name: "v2: bonding buys the farm a larger share than starter mode",
      detail:
        "bonded " + percent(bonded.botShareBps) + " against starter " + percent(starter.botShareBps),
    },
    {
      ok: starter.botShareBps < v4.botShareBps,
      name: "v2: refusing to bond costs the farm its v4 share",
      detail:
        "starter " + percent(starter.botShareBps) + " against v4 " + percent(v4.botShareBps),
    },
    {
      ok: v4.reserveRemainderTokens === 0n,
      name: "v4: the single index assigned every block it could pay",
      detail: "unassigned " + whole(v4.reserveRemainderTokens) + " tokens",
    },
  ];
}

/** The whole v2 section: the question, the table, and what the numbers say. */
export function v2Section(result: V2Result): string {
  const starter = result.arms.find((arm) => arm.key === "starter-bots");
  const bonded = result.arms.find((arm) => arm.key === "bonded-bots");
  const options = result.options;
  const lines: string[] = [];
  lines.push("\n### The on-chain v2 rules: bond, starter mode, tranche cap, SOL caps\n");
  lines.push(
    "A " +
      whole(BigInt(options.bots)) +
      "-wallet farm against " +
      whole(BigInt(options.humans)) +
      " bonded humans, over " +
      whole(BigInt(options.blocks)) +
      " blocks of " +
      whole(options.blockReward) +
      " tokens each, at a pool TWAP of " +
      whole(options.priceLamportsPerToken) +
      " lamports per token. Every arm plays the same population on the same rewards; only the " +
      "rules differ. The unassigned column is what a block could not hand to anybody and left in " +
      "the Mining Reserve, which is the amendment's whole point.",
  );
  lines.push("");
  lines.push(v2Table(result));
  lines.push("");
  if (starter && bonded) {
    lines.push(
      "A starter-mode farm captures " +
        percent(starter.botShareBps) +
        " of the mined tokens for no capital at all, because the tranche cap bounds it at " +
        percent(Number(STARTER_TRANCHE_BPS)) +
        " of every block whatever its power is. Bonding the same " +
        whole(BigInt(options.bots)) +
        " wallets takes its share to " +
        percent(bonded.botShareBps) +
        " and costs " +
        sol(bonded.botBondLamports) +
        " SOL of locked capital for a week, which is " +
        sol(bonded.capitalPerShareBps) +
        " SOL per basis point of share. That is the price the bond puts on a farm, and it is the " +
        "number to hold the 0.07 SOL default against.",
    );
    lines.push("");
    lines.push(
      "The farm's discovery income is bounded by the caps rather than by the seed: the seed is " +
        "public before settlement, so the model lets the farm settle only the outcomes it likes, " +
        "and the per-wallet day and week caps, the coin's per-epoch budget and the protocol-wide " +
        "daily cap are what stop it. Starter-mode wallets cannot roll at all.",
    );
  }
  return lines.join("\n");
}
