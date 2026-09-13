import { useState } from "react";

const SYMBOLS: Record<string, string> = {
  DRILL: "D",
  STONE: "S",
  MOLE: "M",
  BYTE: "B",
};

export function TokenOrb({ symbol, imageUrl, large = false }: {
  symbol: string;
  imageUrl: string | null;
  large?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  return (
    <div className={`token-orb orb-${symbol.toLowerCase()} ${large ? "token-orb-large" : ""}`}>
      {imageUrl && !failed ? (
        <img src={imageUrl} alt="" onError={() => setFailed(true)} />
      ) : (
        <span>{SYMBOLS[symbol] ?? symbol.slice(0, 1)}</span>
      )}
    </div>
  );
}
