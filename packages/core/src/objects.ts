/** True for `{}` literals and `Object.create(null)` — not Dates, Buffers or class instances. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Rebuilds plain objects and arrays, calling `mapEntry` for each key. Anything else (Date,
 * Buffer, class instances, primitives) is returned untouched, so it still serialises correctly.
 */
export function mapPlainDeep(
  value: unknown,
  mapEntry: (key: string, child: unknown) => [string, unknown] | null,
): unknown {
  if (Array.isArray(value)) return value.map((v) => mapPlainDeep(v, mapEntry));
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    const mapped = mapEntry(k, v);
    if (mapped) out[mapped[0]] = mapPlainDeep(mapped[1], mapEntry);
  }
  return out;
}
