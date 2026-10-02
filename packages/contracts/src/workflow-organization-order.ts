/** Called only after schema validation of dense, nonempty canonical UUIDs. */
export function strictlyAscendingIdentifiers(ids: readonly string[]): boolean {
  let previous = '';
  for (const id of ids) {
    if (id <= previous) return false;
    previous = id;
  }
  return true;
}
