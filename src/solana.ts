import { createClient } from "@solana/kit";
import { walletSigner } from "@solana/kit-plugin-wallet";

export const solanaClient = createClient().use(walletSigner({ chain: "solana:devnet" }));
export type DiggoSolanaClient = Awaited<typeof solanaClient>;
