/**
 * Local calendar date as YYYY-MM-DD.
 *
 * Deliberately NOT `toISOString().slice(0, 10)`: on a runner with
 * TZ=Asia/Kolkata, 04:00 IST is still the previous UTC day. Using the local
 * date keeps the digest subject, the file name, and the "already sent?"
 * lookup on the same day the user is living in.
 */
export function localDate(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
