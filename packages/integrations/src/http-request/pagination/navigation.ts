import { HttpPaginationFailure } from './failure.js';
import type { JsonValue } from '@pertexo/node-sdk/server';
import { resolveJsonPath } from '@pertexo/workflow-model';
import type { HttpPagination } from './validation.js';
import { nextLink } from './link.js';

function scalar(
  value: JsonValue | undefined,
  page: number,
  numeric = false,
): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'string' || (numeric && typeof value === 'number'))
    return String(value);
  throw new HttpPaginationFailure('http.pagination_invalid_navigation', page);
}
function at(value: JsonValue, path: string): JsonValue | undefined {
  const found = resolveJsonPath(value, path);
  return found.kind === 'value' ? found.value : undefined;
}
export function nextPage(
  input: Readonly<{
    pagination: HttpPagination;
    first: URL;
    current: Readonly<{ value: JsonValue; url: string; link?: string }>;
    page: number;
    seen: Set<string>;
  }>,
): string | undefined {
  const { pagination, first, current, page, seen } = input;
  let target: string | undefined;
  let identity: string;
  if (pagination.mode === 'next_link') {
    const link =
      pagination.source.kind === 'body'
        ? scalar(at(current.value, pagination.source.path), page)
        : nextLink(current.link, page);
    if (link === undefined) return undefined;
    try {
      target = new URL(link, current.url).toString();
    } catch {
      throw new HttpPaginationFailure(
        'http.pagination_invalid_navigation',
        page,
      );
    }
    identity = target;
  } else {
    const url = new URL(first);
    if (pagination.mode === 'cursor') {
      const cursor = scalar(
        at(current.value, pagination.cursorPath),
        page,
        true,
      );
      if (cursor === undefined) return undefined;
      url.searchParams.set(pagination.parameter, cursor);
      identity = cursor;
    } else {
      const counter =
        pagination.start +
        page * (pagination.mode === 'page' ? 1 : pagination.step);
      url.searchParams.set(pagination.parameter, String(counter));
      identity = url.toString();
    }
    target = url.toString();
  }
  const url = new URL(target);
  if (url.origin !== first.origin)
    throw new HttpPaginationFailure('http.pagination_origin_changed', page);
  if (
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== '' ||
    new TextEncoder().encode(target).byteLength > 2048
  )
    throw new HttpPaginationFailure('http.pagination_invalid_navigation', page);
  if (seen.has(identity)) return undefined;
  seen.add(identity);
  return target;
}
