import { hashCanonicalJson, hashNormalizedJson } from './hash.util';

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

describe('hashNormalizedJson', () => {
  it('ignores key order, outer whitespace, and string casing', () => {
    const a = {
      slot_id: 'SLOT-1',
      name: 'Alice Smith',
      email: 'Alice@Example.COM',
    };
    const b = {
      email: '  alice@example.com ',
      name: '  alice smith  ',
      slot_id: ' slot-1 ',
    };

    expect(hashNormalizedJson(a)).toBe(hashNormalizedJson(b));
  });

  it('distinguishes values and value types', () => {
    expect(
      hashNormalizedJson({ slot_id: 123, name: 'Alice', email: 'a@b.com' }),
    ).not.toBe(
      hashNormalizedJson({ slot_id: '123', name: 'Alice', email: 'a@b.com' }),
    );
  });
});
