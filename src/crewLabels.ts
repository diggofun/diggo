/**
 * Presentation metadata for the five Crew branches (spec 72).
 *
 * The strategic role of each branch is fixed and documented in shared/crew.ts: Miners are base
 * Mining Power, Drills are an efficiency multiplier on Miners, Carts are ORE logistics, Foreman
 * organises the crew (cheaper upgrades, more ORE) and Storage buys offline capacity. This file
 * only names those roles for the UI; it never redefines them.
 */
import type { CrewComponent } from "../shared/config";

export const CREW_COMPONENTS: readonly CrewComponent[] = ["miners", "drills", "carts", "foreman", "storage"];

export const CREW_COMPONENT_LABELS: Record<CrewComponent, string> = {
  miners: "Miners",
  drills: "Drills",
  carts: "Carts",
  foreman: "Foreman",
  storage: "Storage",
};

export interface CrewRole {
  /** One line: what this branch does. */
  role: string;
  /** What upgrading it actually moves. Used for the delta preview label. */
  deltaLabel: string;
}

export const CREW_ROLES: Record<CrewComponent, CrewRole> = {
  miners: {
    role: "Base Mining Power. Every miner you add raises the crew's raw output.",
    deltaLabel: "Mining Power",
  },
  drills: {
    role: "Efficiency. Drills multiply what your Miners dig instead of adding flat power.",
    deltaLabel: "Mining Power",
  },
  carts: {
    role: "ORE logistics. Carts move more ore per active hour and add a little storage.",
    deltaLabel: "ORE per hour",
  },
  foreman: {
    role: "Organisation. A Foreman discounts every upgrade and lifts ORE efficiency.",
    deltaLabel: "Upgrade cost",
  },
  storage: {
    role: "Offline capacity. Storage holds more ORE and extends how long the crew digs unattended.",
    deltaLabel: "ORE capacity",
  },
};

/** Glyph used in the compact level strip on the dashboard and crew screen. */
export const CREW_COMPONENT_GLYPHS: Record<CrewComponent, string> = {
  miners: "M",
  drills: "D",
  carts: "C",
  foreman: "F",
  storage: "S",
};
