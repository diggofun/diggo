import React from "react";
import ReactDOM from "react-dom/client";
import { ClientProvider } from "@solana/react";
import "./styles.css";
import App from "./App";
import { solanaClient } from "./solana";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ClientProvider client={solanaClient}>
      <App />
    </ClientProvider>
  </React.StrictMode>,
);
