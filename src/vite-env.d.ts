/// <reference types="vite/client" />

interface TurnstileApi {
  render(container: HTMLElement, options: {
    sitekey: string;
    theme?: "light" | "dark" | "auto";
    size?: "normal" | "compact" | "flexible";
    callback(token: string): void;
    "expired-callback"?(): void;
  }): string;
  remove(widgetId: string): void;
}

interface Window {
  turnstile?: TurnstileApi;
}
