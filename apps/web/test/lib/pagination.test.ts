import { describe, expect, it } from 'vitest';
import { isApiError } from '../../src/lib/api/api-error';
import {
  collectPages,
  cursorPages,
  searchParams,
} from '../../src/lib/api/pagination';

function pages(cursors: readonly (string | null)[]): (
  after: string | undefined,
) => Promise<{
  items: readonly string[];
  nextCursor: string | null;
}> {
  let index = 0;
  return (after) => {
    const nextCursor = cursors[index] ?? null;
    index += 1;
    return Promise.resolve({ items: [after ?? 'first'], nextCursor });
  };
}

describe('pagination', () => {
  it('writes parsed parameters as query text', () => {
    expect(searchParams({ limit: 50, after: undefined, order: 'asc' })).toBe(
      'limit=50&order=asc',
    );
  });

  it('collects every page until the cursor ends', async () => {
    await expect(
      collectPages(pages(['b', 'c', null]), { read: 'Test discovery' }),
    ).resolves.toEqual(['first', 'b', 'c']);
  });

  it('treats a repeated cursor or too many pages as a protocol failure', async () => {
    const repeated = collectPages(pages(['b', 'b']), {
      read: 'Test discovery',
    });
    // `rejects.toThrow` breaks under jest-dom's matchers with vitest 4.1.11.
    await expect(repeated).rejects.toMatchObject({
      message: 'Test discovery returned an invalid cursor sequence.',
    });
    const unbounded = collectPages(pages(['b', 'c', 'd']), {
      read: 'Test discovery',
      maxPages: 2,
    });
    await expect(unbounded).rejects.toSatisfy(
      (error) => isApiError(error) && error.kind === 'protocol',
    );
  });

  it('stops early when the caller has what it needs', async () => {
    const seen: string[] = [];
    for await (const page of cursorPages(pages(['b', 'c', null]), {
      read: 'Test lookup',
    })) {
      seen.push(...page.items);
      if (page.items.includes('b')) break;
    }
    expect(seen).toEqual(['first', 'b']);
  });
});
