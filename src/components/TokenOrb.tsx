import { useState } from "react";
import { Bot, botFor } from "./Bot";

/**
 * A coin's avatar: its own image when it has one, otherwise the coin's bot - a stable shape,
 * colour and outfit picked from its ticker, so the same coin always looks the same everywhere.
 */
export function TokenOrb({ symbol, imageUrl, large = false }: {
  symbol: string;
  imageUrl: string | null;
  large?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const showImage = Boolean(imageUrl) && !failed;
  return (
    <div className={"token-orb" + (large ? " token-orb-large" : "") + (showImage ? " has-image" : " is-bot")}>
      {showImage ? (
        <img src={imageUrl ?? undefined} alt="" onError={() => setFailed(true)} />
      ) : (
        <Bot {...botFor(symbol.toUpperCase())} size="100%" still />
      )}
    </div>
  );
}
