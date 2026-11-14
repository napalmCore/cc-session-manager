import { useEffect, useRef, useState } from "react";

export const VIEWS = ["sessions", "history", "search"] as const;
export type View = (typeof VIEWS)[number];

/** The view in the address, such as `#history`; anything else is Sessions. */
export function viewOf(hash: string): View {
  const name = hash.replace(/^#/, "");
  return (VIEWS as readonly string[]).includes(name)
    ? (name as View)
    : "sessions";
}

/**
 * The view the address names. Each view has its own address, so Back and reload keep it. The
 * page key's own fragment is taken out of the address before the page renders.
 */
export function useView(): View {
  const [view, setView] = useState(() => viewOf(window.location.hash));
  const shown = useRef(view);
  useEffect(() => {
    const update = () => {
      const next = viewOf(window.location.hash);
      if (next === shown.current) return;
      shown.current = next;
      setView(next);
      // The new view's heading takes focus, so it's announced and Tab starts there.
      window.setTimeout(() => {
        const heading =
          document.getElementById(`${next}-title`) ??
          document.querySelector<HTMLElement>("h1");
        heading?.focus();
      }, 0);
    };
    window.addEventListener("hashchange", update);
    window.addEventListener("popstate", update);
    return () => {
      window.removeEventListener("hashchange", update);
      window.removeEventListener("popstate", update);
    };
  }, []);
  return view;
}
