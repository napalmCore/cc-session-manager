const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function formatDuration(ms: number): string {
  if (ms < MINUTE) return "under 1m";
  if (ms < HOUR) return `${String(Math.floor(ms / MINUTE))}m`;
  if (ms < DAY) {
    const hours = Math.floor(ms / HOUR);
    const minutes = Math.floor((ms % HOUR) / MINUTE);
    return `${String(hours)}h ${String(minutes)}m`;
  }
  const days = Math.floor(ms / DAY);
  const hours = Math.floor((ms % DAY) / HOUR);
  return `${String(days)}d ${String(hours)}h`;
}
