/** Values serialised as-is: they carry no nested keys that could hold secrets or profit. */
function isLeaf(value: object): boolean {
  return (
    value instanceof Date ||
    value instanceof RegExp ||
    ArrayBuffer.isView(value) ||
    value instanceof ArrayBuffer
  );
}

/**
 * Rebuilds objects and arrays, calling `mapEntry` for each own enumerable key, at any depth.
 * Dates, Buffers and typed arrays are kept as-is so they still serialise correctly. Errors
 * become `{ name, message }` plus their own enumerable fields (no stack). Class instances
 * are walked like plain objects, so nothing nested in them gets past the filter.
 */
export function mapPlainDeep(
  value: unknown,
  mapEntry: (key: string, child: unknown) => [string, unknown] | null,
): unknown {
  if (Array.isArray(value)) return value.map((v) => mapPlainDeep(v, mapEntry));
  if (value === null || typeof value !== 'object' || isLeaf(value)) return value;
  const own: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  const source: Record<string, unknown> =
    value instanceof Error ? { ...own, name: value.name, message: value.message } : own;
  const entries: [string, unknown][] = [];
  for (const [k, v] of Object.entries(source)) {
    const mapped = mapEntry(k, v);
    if (mapped) entries.push([mapped[0], mapPlainDeep(mapped[1], mapEntry)]);
  }
  // fromEntries defines own properties, so a "__proto__" key is copied, not used as a prototype.
  return Object.fromEntries(entries);
}
