import { useEffect, useRef } from "react";

export function TurnstileBox({ siteKey, onToken }: { siteKey: string; onToken(token: string): void }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (location.hostname === "localhost" || location.hostname === "127.0.0.1") {
      onToken("dev-bypass");
      return;
    }
    const render = () => {
      if (!containerRef.current || !window.turnstile) return undefined;
      return window.turnstile.render(containerRef.current, {
        sitekey: siteKey,
        theme: "light",
        size: "flexible",
        callback: onToken,
        "expired-callback": () => onToken(""),
      });
    };
    let widgetId = render();
    let timer: number | undefined;
    if (!widgetId) {
      let script = document.querySelector<HTMLScriptElement>("script[data-diggo-turnstile]");
      if (!script) {
        script = document.createElement("script");
        script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
        script.async = true;
        script.defer = true;
        script.dataset.diggoTurnstile = "true";
        document.head.appendChild(script);
      }
      timer = window.setInterval(() => {
        widgetId = render();
        if (widgetId && timer) window.clearInterval(timer);
      }, 100);
    }
    return () => {
      if (timer) window.clearInterval(timer);
      if (widgetId) window.turnstile?.remove(widgetId);
    };
  }, [onToken, siteKey]);

  return <div className="turnstile-box" ref={containerRef} />;
}
