const STORAGE_KEY = "cc-session-manager-page-key";
const KEY = /^[0-9a-f]{64}$/;

let cached: string | null = null;

/**
 * The page key proves a request comes from this dashboard's own page. Sign-in delivers it in the
 * address's fragment, which browsers never send to a server. It's kept in this origin's storage,
 * which, unlike a cookie, is separate for each port, so other tabs and reloads can use it.
 */
export function readPageKey(): string | null {
  if (cached !== null) return cached;
  const match = /^#key=([0-9a-f]{64})$/.exec(window.location.hash);
  if (match?.[1] !== undefined) {
    cached = match[1];
    try {
      localStorage.setItem(STORAGE_KEY, cached);
    } catch {
      // This tab still has it in memory.
    }
    // Keeps the key out of the address bar, history, and anything copied from it.
    history.replaceState(
      null,
      "",
      window.location.pathname + window.location.search,
    );
    return cached;
  }
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored !== null && KEY.test(stored)) cached = stored;
  } catch {
    // Storage can be blocked, and then only the tab that signed in has the key.
  }
  return cached;
}
