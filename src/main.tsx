import React from "react";
import ReactDOM from "react-dom/client";
import { ClientProvider } from "@solana/react";
import "./styles.css";
import App from "./App";
import { loadPublicConfig } from "./api";
import { solanaClient } from "./solana";

void loadPublicConfig();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ClientProvider client={solanaClient}>
      <App />
    </ClientProvider>
  </React.StrictMode>,
);
