import "./polyfills";
import React from "react";
import ReactDOM from "react-dom/client";
import { ClientProvider } from "@solana/react";
import "./styles.css";
import App from "./App";
import { solanaClient } from "./solana";
import { PendingTransactionProvider } from "./onchain";
import { useDiggoWallet } from "./wallet";

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
