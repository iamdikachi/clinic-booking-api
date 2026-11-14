import { createHash } from 'node:crypto';

function canonicalizeValue(value: unknown, normalizeStrings: boolean): unknown {
  if (typeof value === 'string') {
    return normalizeStrings ? value.trim().toLowerCase() : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeValue(item, normalizeStrings));
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      sorted[key] = canonicalizeValue(record[key], normalizeStrings);
    }
    return sorted;
  }
  return value;
}

/**
 * Computes a deterministic SHA-256 hex digest independent of object key order.
 */
export function hashCanonicalJson(value: unknown): string {
  const canonical = JSON.stringify(
    canonicalizeValue(value ?? null, false),
  );
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Computes a SHA-256 hex digest after sorting keys and trimming/lowercasing strings.
 */
export function hashNormalizedJson(value: unknown): string {
  const canonical = JSON.stringify(
    canonicalizeValue(value ?? null, true),
  );
  return createHash('sha256').update(canonical).digest('hex');
}
