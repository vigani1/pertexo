import { ApiError } from './api-error';

type CursorPage = Readonly<{ nextCursor: string | null }>;

/** The query text for parsed search parameters, e.g. "limit=50&after=…". */
export function searchParams(
  values: Readonly<Record<string, string | number | boolean | undefined>>,
): string {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(values))
    if (value !== undefined) query.set(name, String(value));
  return query.toString();
}

/**
 * Every page of a cursor-paginated collection, in order. A cursor the
 * server repeats, or more than `maxPages` pages, is a protocol failure, so a
 * broken cursor never loops forever.
 */
export async function* cursorPages<Page extends CursorPage>(
  readPage: (after: string | undefined) => Promise<Page>,
  options: Readonly<{
    /** Names the read in failures, e.g. "Connection discovery". */
    read: string;
    maxPages?: number;
    signal?: AbortSignal | undefined;
  }>,
): AsyncGenerator<Page, void> {
  const { read, maxPages = 40, signal } = options;
  const seen = new Set<string>();
  let after: string | undefined;
  for (let page = 0; page < maxPages; page += 1) {
    signal?.throwIfAborted();
    const response = await readPage(after);
    yield response;
    if (response.nextCursor === null) return;
    if (seen.has(response.nextCursor))
      throw new ApiError({
        kind: 'protocol',
        message: `${read} returned an invalid cursor sequence.`,
      });
    seen.add(response.nextCursor);
    after = response.nextCursor;
  }
  throw new ApiError({
    kind: 'protocol',
    message: `${read} exceeded its bounded page limit.`,
  });
}

/** Every item of a cursor-paginated collection (see `cursorPages`). */
export async function collectPages<Item>(
  readPage: (
    after: string | undefined,
  ) => Promise<Readonly<{ items: readonly Item[]; nextCursor: string | null }>>,
  options: Parameters<typeof cursorPages>[1],
): Promise<readonly Item[]> {
  const items: Item[] = [];
  for await (const page of cursorPages(readPage, options))
    items.push(...page.items);
  return items;
}
