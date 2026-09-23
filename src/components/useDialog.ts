import { useEffect, useRef } from "react";

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * Shared modal behaviour: Escape closes, focus moves into the dialog when it opens, Tab stays
 * inside it, and focus returns to whatever opened it. Attach the returned ref to the dialog node.
 */
export function useDialog<T extends HTMLElement>(onClose?: () => void) {
  const ref = useRef<T | null>(null);
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const node = ref.current;
    const first = node?.querySelector<HTMLElement>("[data-autofocus]") ?? node?.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus({ preventScroll: true });
    document.body.classList.add("has-modal");

    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape" && closeRef.current) {
        event.stopPropagation();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab" || !ref.current) return;
      const items = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((item) => item.offsetParent !== null);
      if (items.length === 0) return;
      const firstItem = items[0];
      const lastItem = items[items.length - 1];
      if (event.shiftKey && document.activeElement === firstItem) {
        event.preventDefault();
        lastItem.focus();
      } else if (!event.shiftKey && document.activeElement === lastItem) {
        event.preventDefault();
        firstItem.focus();
      }
    }

    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.classList.remove("has-modal");
      opener?.focus({ preventScroll: true });
    };
  }, []);

  return ref;
}
