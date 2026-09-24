/** Document title for a page: "Runs · Northwind Ops — Pertexo". */
export function pageTitle(...parts: readonly (string | undefined)[]): string {
  const named = parts.filter((part): part is string => Boolean(part));
  return named.length === 0 ? 'Pertexo' : `${named.join(' · ')} — Pertexo`;
}
