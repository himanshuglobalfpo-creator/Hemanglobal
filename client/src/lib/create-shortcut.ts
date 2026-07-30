// ============================================================================
// Create shortcut helper (QBO "+ Create" menu)
// ============================================================================
// The global Create menu can drop the user straight into a create dialog on
// another page — exactly like QBO, where picking "Invoice" opens a new invoice.
//
// We hand the intent off via sessionStorage (router-agnostic: no query string
// in the hash route, which wouter's hash matcher would otherwise choke on) plus
// a custom event so the same page already being open still opens its dialog.
// A create-capable page calls useOpenOnCreateParam(open); it fires once when the
// pending path matches the page, then clears the flag so a refresh/Back won't
// re-open the dialog.

import { useEffect, useRef } from "react";

const KEY = "ll:create-pending";
const EVENT = "ll:create-request";

// Current hash route path without the leading "#" or any query string.
function currentPath(): string {
  return window.location.hash.replace(/^#/, "").split("?")[0] || "/";
}

// Called by the Create menu before navigating to `path`.
export function requestCreate(path: string): void {
  sessionStorage.setItem(KEY, path);
  // For the "already on this page" case, notify listeners synchronously.
  window.dispatchEvent(new CustomEvent(EVENT, { detail: path }));
}

export function useOpenOnCreateParam(open: () => void): void {
  // Keep the latest callback without making it an effect dependency.
  const openRef = useRef(open);
  openRef.current = open;

  useEffect(() => {
    const tryOpen = () => {
      const pending = sessionStorage.getItem(KEY);
      if (pending && pending === currentPath()) {
        sessionStorage.removeItem(KEY);
        openRef.current();
      }
    };
    tryOpen(); // navigation case: the flag was set just before we mounted
    window.addEventListener(EVENT, tryOpen); // same-page case
    return () => window.removeEventListener(EVENT, tryOpen);
  }, []);
}
