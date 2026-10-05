import "./polyfills";
import React from "react";
import ReactDOM from "react-dom/client";
import { ClientProvider } from "@solana/react";
import "./styles.css";
import "./design.css";
import App from "./App";
import { solanaClient } from "./solana";
import { PendingTransactionProvider } from "./onchain";
import { useDiggoWallet } from "./wallet";
import { startTheme } from "./preferences";
import { captureAcquisition } from "./acquisition";
import { captureMineLink } from "./mineLink";
import { startTelegram } from "./telegram";

startTheme();
captureAcquisition();
// Before the app reads the path: /m/<mint> becomes the mine page.
captureMineLink();
// Inside Telegram: its WebApp script, and ?startapp=m_<mint> / r_<code> launch parameters.
startTelegram();

function PendingScope() {
  const wallet = useDiggoWallet();
  return (
    <PendingTransactionProvider walletAddress={wallet?.address ?? null}>
      <App />
    </PendingTransactionProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ClientProvider client={solanaClient}>
      <PendingScope />
    </ClientProvider>
  </React.StrictMode>,
);
