/**
 * `s` capped at `max` characters, with an ellipsis standing in for what was
 * dropped. The ellipsis is counted against the cap rather than added past it, so
 * a caller that says 500 gets no more than 500.
 */
export function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 3) + '...' : s;
}
