import { utf8ByteLength } from '@pertexo/workflow-model';
import { HttpPaginationFailure } from './failure.js';
import type { JsonValue } from '@pertexo/node-sdk/server';
import { resolveJsonPath } from '@pertexo/workflow-model';
import type { HttpPagination } from './validation.js';
import { nextLink } from './link.js';

function scalar(
  value: JsonValue | undefined,
  page: number,
  { numeric = false }: Readonly<{ numeric?: boolean | undefined }> = {},
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
/** Preserve unrelated query bytes: signed URLs may depend on their encoding. */
export function setPaginationParameter(
  url: URL,
  parameter: string,
  value: string,
): void {
  const replacement = new URLSearchParams([[parameter, value]]).toString();
  let replaced = false;
  const parts: string[] = [];
  for (const part of url.search.slice(1).split('&')) {
    if (new URLSearchParams(part).has(parameter)) {
      if (!replaced) parts.push(replacement);
      replaced = true;
    } else if (part !== '' || url.search !== '') parts.push(part);
  }
  if (!replaced) parts.push(replacement);
  url.search = parts.join('&');
}

/** A capped request needs presence, not URL resolution, origin or cycle checks. */
export function hasNextPage(
  pagination: HttpPagination,
  current: Readonly<{ value: JsonValue; link?: string }>,
  page: number,
): boolean {
  const value = nextPageValue(pagination, current, page);
  return value !== undefined && value !== null && value !== '';
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
      const cursor = scalar(at(current.value, pagination.cursorPath), page, {
        numeric: true,
      });
      if (cursor === undefined) return undefined;
      setPaginationParameter(url, pagination.parameter, cursor);
      identity = cursor;
    } else {
      const counter =
        pagination.start +
        page * (pagination.mode === 'page' ? 1 : pagination.step);
      setPaginationParameter(url, pagination.parameter, String(counter));
      identity = url.toString();
    }
    target = url.toString();
  }
  const url = new URL(target);
  if (url.origin !== first.origin)
    throw new HttpPaginationFailure('http.pagination_origin_changed', page);
  const unsafeTarget =
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== '' ||
    utf8ByteLength(target) > 2048;
  if (unsafeTarget)
    throw new HttpPaginationFailure('http.pagination_invalid_navigation', page);
  if (seen.has(identity)) return undefined;
  seen.add(identity);
  return target;
}

function nextPageValue(
  pagination: HttpPagination,
  current: Readonly<{ value: JsonValue; link?: string }>,
  page: number,
) {
  switch (pagination.mode) {
    case 'cursor':
      return at(current.value, pagination.cursorPath);
    case 'next_link':
      if (pagination.source.kind === 'body')
        return at(current.value, pagination.source.path);
      return nextLink(current.link, page, { presenceOnly: true });
    case 'page':
    case 'offset':
    default:
      return true;
  }
}
