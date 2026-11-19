const PRODUCT = 'Pertexo';
const PRODUCT_SUFFIX = ` — ${PRODUCT}`;

/** Document title for a page: "Runs · Northwind Ops — Pertexo". */
export function pageTitle(...parts: readonly (string | undefined)[]): string {
  const named = parts.filter((part): part is string => Boolean(part));
  return named.length === 0 ? PRODUCT : `${named.join(' · ')}${PRODUCT_SUFFIX}`;
}

/** A page's own name, read back from its document title without the product. */
export function pageName(title: string): string {
  return title.endsWith(PRODUCT_SUFFIX)
    ? title.slice(0, -PRODUCT_SUFFIX.length)
    : title;
}
