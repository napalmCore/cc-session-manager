/** Each announcement stays in the live region at least this long (BUG-16). */
export const MIN_SHOWN_MS = 1000;
/** The region is cleared this long before new text, so repeated text still counts as new. */
export const CLEAR_MS = 100;

export interface Announcer {
  /**
   * Queues a message. An empty one clears the region, once what's shown has had its second,
   * unless something else is queued by then.
   */
  announce: (message: string) => void;
  dispose: () => void;
}

/**
 * Queues announcements, so one arriving while another is being read waits its turn instead of
 * replacing it. Messages queued together are read together.
 */
export function createAnnouncer(
  show: (text: string) => void,
  now: () => number = Date.now,
): Announcer {
  let queued: string[] = [];
  let shownAt: number | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let clearTimer: ReturnType<typeof setTimeout> | undefined;

  /** How long until what's shown has had its second. */
  const remaining = () =>
    shownAt === null ? 0 : Math.max(0, shownAt + MIN_SHOWN_MS - now());

  const cancelClear = () => {
    clearTimeout(clearTimer);
    clearTimer = undefined;
  };

  const schedule = () => {
    if (timer !== undefined) return;
    timer = setTimeout(() => {
      show("");
      timer = setTimeout(() => {
        timer = undefined;
        if (queued.length === 0) return;
        show(queued.join(" "));
        queued = [];
        shownAt = now();
      }, CLEAR_MS);
    }, remaining());
  };

  return {
    announce(message) {
      if (message === "") {
        if (
          queued.length > 0 ||
          timer !== undefined ||
          clearTimer !== undefined
        ) {
          return;
        }
        const wait = remaining();
        if (wait === 0) {
          show("");
          return;
        }
        clearTimer = setTimeout(() => {
          clearTimer = undefined;
          if (queued.length === 0 && timer === undefined) show("");
        }, wait);
        return;
      }
      cancelClear();
      queued.push(message);
      schedule();
    },
    dispose() {
      clearTimeout(timer);
      cancelClear();
      timer = undefined;
    },
  };
}
