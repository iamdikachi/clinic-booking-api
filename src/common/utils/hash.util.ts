import { createHash } from 'node:crypto';

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      sorted[key] = sortKeysDeep(record[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Computes a deterministic SHA-256 hex digest independent of object key order.
 */
export function hashCanonicalJson(value: unknown): string {
  const canonical = JSON.stringify(sortKeysDeep(value));
  return createHash('sha256').update(canonical).digest('hex');
}
