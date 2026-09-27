/** UTC ISO-8601 timestamp, e.g. 2026-09-27T12:34:56.789Z */
export function nowIso(): string {
  return new Date().toISOString();
}

/** ISO-8601 timestamp `hours` from now. */
export function hoursFromNowIso(hours: number): string {
  return new Date(Date.now() + hours * 3600_000).toISOString();
}
