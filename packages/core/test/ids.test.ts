import { describe, expect, it } from 'vitest';
import { assertId, isUuid } from '../src/index.js';

describe('ids', () => {
  it('accepts UUIDs and answers 404 for anything else', () => {
    const id = '0b6f1c2e-6d1a-4c1f-9c55-3f7a3d1b2c4e';
    expect(isUuid(id)).toBe(true);
    expect(assertId(id)).toBe(id);
    expect(() => assertId('abc', 'User')).toThrow(
      expect.objectContaining({ status: 404, message: 'User not found.' }),
    );
    expect(isUuid(42)).toBe(false);
  });
});
