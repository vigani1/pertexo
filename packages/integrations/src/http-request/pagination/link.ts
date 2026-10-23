import { HttpPaginationFailure } from './failure.js';

/** RFC 8288: commas inside a URI or quoted parameter do not separate links. */
export function nextLink(
  header: string | undefined,
  page: number,
  {
    presenceOnly = false,
  }: Readonly<{ presenceOnly?: boolean | undefined }> = {},
): string | undefined {
  if (header === undefined || header.trim() === '') return undefined;
  const invalid = () =>
    new HttpPaginationFailure('http.pagination_invalid_navigation', page);
  const links = tokenizeLinks(header, invalid);
  let result: string | undefined;
  for (const link of links) {
    const { target, rel, anchored } = parseLink(link, invalid);
    // A link with another context is not a next page of this response.
    if (
      anchored ||
      !rel?.split(/\s+/u).some((value) => value.toLowerCase() === 'next')
    )
      continue;
    if (presenceOnly && target !== '') return target;
    if (result !== undefined && result !== target) throw invalid();
    result = target;
  }
  return result === '' ? undefined : result;
}

function tokenizeLinks(
  header: string,
  invalid: () => Error,
): readonly string[] {
  const links: string[] = [];
  let start = 0;
  let quoted = false;
  let angle = false;
  let escaped = false;
  for (let index = 0; index < header.length; index += 1) {
    const char = header[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quoted && char === '\\') {
      escaped = true;
      continue;
    }
    switch (char) {
      case '"':
        if (!angle) quoted = !quoted;
        break;
      case '<':
        if (!quoted) angle = true;
        break;
      case '>':
        if (!quoted) angle = false;
        break;
      case ',':
        if (!quoted && !angle) {
          links.push(header.slice(start, index));
          start = index + 1;
        }
        break;
      case undefined:
      default:
        break;
    }
  }
  if (quoted || angle || escaped) throw invalid();
  links.push(header.slice(start));
  return links;
}

function parseLink(link: string, invalid: () => Error) {
  const match = /^\s*<([^<>]*)>(.*)$/u.exec(link);
  if (match === null) throw invalid();
  const target = match[1];
  let rest = match[2] ?? '';
  let rel: string | undefined;
  let anchored = false;
  while (rest.trim() !== '') {
    const parameter =
      /^\s*;\s*([!#$%&'*+.^_`|~0-9A-Za-z-]+)\s*(?:=\s*(?:"((?:[^"\\]|\\.)*)"|([!#$%&'*+.^_`|~0-9A-Za-z:/-]+)))?/u.exec(
        rest,
      );
    if (parameter === null) throw invalid();
    const name = parameter[1]?.toLowerCase();
    const value = (parameter[2] ?? parameter[3] ?? '').replace(/\\(.)/gu, '$1');
    if (name === 'rel' && rel === undefined) rel = value;
    if (name === 'anchor') anchored = true;
    rest = rest.slice(parameter[0].length);
  }
  return { target, rel, anchored };
}
