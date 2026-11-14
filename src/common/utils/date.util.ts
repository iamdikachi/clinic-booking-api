/**
 * Formats a Date or timestamp string as a UTC ISO-8601 string, omitting `.000`
 * milliseconds (e.g. `2026-12-10T09:00:00Z`).
 */
export function formatIsoUtc(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString().replace(/\.000Z$/, 'Z');
}
