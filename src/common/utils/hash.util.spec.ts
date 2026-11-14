import { hashCanonicalJson } from './hash.util';

describe('hashCanonicalJson', () => {
  it('produces identical hashes for objects with reordered keys', () => {
    const a = { slot_id: 's1', name: 'Alice', email: 'alice@example.com' };
    const b = { email: 'alice@example.com', slot_id: 's1', name: 'Alice' };

    expect(hashCanonicalJson(a)).toBe(hashCanonicalJson(b));
  });

  it('produces different hashes when values differ', () => {
    const a = { slot_id: 's1', name: 'Alice', email: 'alice@example.com' };
    const b = { slot_id: 's1', name: 'Bob', email: 'alice@example.com' };

    expect(hashCanonicalJson(a)).not.toBe(hashCanonicalJson(b));
  });
});
