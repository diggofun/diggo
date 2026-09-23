import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ICON_ASSET_NAMES } from "../icons";

const OWNED_FILES = [
  "HomeSections.tsx",
  "LaunchModal.tsx",
  "LeaderboardsScreen.tsx",
  "MineInfoPanel.tsx",
  "MiningReportModal.tsx",
  "NotificationsBell.tsx",
  "PlayerOnboarding.tsx",
  "PushToggle.tsx",
  "RentReclaimPanel.tsx",
] as const;

describe("owned component raster icons", () => {
const componentSourceFiles: ReadonlyArray<readonly [string, URL]> = OWNED_FILES.map(
  (file) => [file, new URL(file, import.meta.url)] as const,
);

const sourceFiles: ReadonlyArray<readonly [string, URL]> = [
  ...componentSourceFiles,
  ["PendingTransactionProvider.tsx", new URL("../onchain/PendingTransactionProvider.tsx", import.meta.url)],
];

  it("uses no Lucide imports", () => {
    for (const [file, url] of sourceFiles) {
      const source = readFileSync(fileURLToPath(url), "utf8");
      expect(source, file).not.toContain("lucide-react");
    }
  });

  it("references only icons with shipped PNG assets", () => {
    for (const [file, url] of sourceFiles) {
      const source = readFileSync(fileURLToPath(url), "utf8");
      const names = new Set(
        [...source.matchAll(/\bIcon[A-Z][A-Za-z0-9]*\b/g)].map((match) => match[0]),
      );

      for (const name of names) {
        const assetName = name.slice("Icon".length);
        const assetStem = assetName.charAt(0).toLowerCase() + assetName.slice(1);
        expect(ICON_ASSET_NAMES.has(assetStem as never), `${file}: ${name}`).toBe(true);
      }
    }
  });
});
