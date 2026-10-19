import { isSerializableHttpHeaderValue } from '../http/header-value.js';

/** `{orderId}` in the address after its origin, or in a header value. */
const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9_]{0,63})\}/gu;
export const HTTP_PLACEHOLDER_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u;
export const HTTP_PLACEHOLDER_LIMIT = 32;

export type HttpPlaceholderValue = string | number | boolean;

type Template = Readonly<{
  url: string;
  headers: Readonly<Record<string, string>>;
}>;

/** Where the origin ends: scheme, host and port never take run data. */
function splitOrigin(url: string): Readonly<{ origin: string; rest: string }> {
  const start = url.indexOf('//') + 2;
  const end = url.slice(start).search(/[/?#]/u);
  const cut = end === -1 ? url.length : start + end;
  return { origin: url.slice(0, cut), rest: url.slice(cut) };
}

function namesIn(text: string): readonly string[] {
  return [...text.matchAll(PLACEHOLDER)].map((match) => String(match[1]));
}

/** The values a request reads from run data, in first-use order. */
export function httpPlaceholders(template: Template): readonly string[] {
  return [
    ...new Set([
      ...namesIn(splitOrigin(template.url).rest),
      ...Object.values(template.headers).flatMap(namesIn),
    ]),
  ];
}

/** Settings-time rule: braces only after the origin, within the limit. */
export function httpTemplateProblem(template: Template): string | undefined {
  if (splitOrigin(template.url).origin.includes('{'))
    return 'Put {placeholders} in the path or query; the address origin stays fixed.';
  if (httpPlaceholders(template).length > HTTP_PLACEHOLDER_LIMIT)
    return `Use at most ${String(HTTP_PLACEHOLDER_LIMIT)} different {placeholders}.`;
  return undefined;
}

export class HttpPlaceholderError extends Error {
  public override readonly name = 'HttpPlaceholderError';
}

/**
 * Fill each `{name}` from run data: percent-encoded in the address, so a value
 * can't add a path segment or query parameter, and checked as a header value.
 */
export function fillHttpTemplate(
  template: Template,
  values: Readonly<Record<string, HttpPlaceholderValue>>,
): Template {
  const value = (name: string): string => {
    const found = values[name];
    if (found === undefined)
      throw new HttpPlaceholderError(`Map a value for {${name}}.`);
    if (typeof found === 'number' && !Number.isFinite(found))
      throw new HttpPlaceholderError(`Use a finite number for {${name}}.`);
    return String(found);
  };
  const { origin, rest } = splitOrigin(template.url);
  const url = `${origin}${rest.replace(PLACEHOLDER, (_, name: string) =>
    encodeURIComponent(value(name)),
  )}`;
  const headers = Object.fromEntries(
    Object.entries(template.headers).map(([name, text]) => {
      const filled = text.replace(PLACEHOLDER, (_, key: string) => value(key));
      if (
        filled.length === 0 ||
        filled.length > 8_192 ||
        !isSerializableHttpHeaderValue(filled)
      )
        throw new HttpPlaceholderError(
          `The value for header ${name} can't be sent; remove line breaks and control characters.`,
        );
      return [name, filled];
    }),
  );
  return { url, headers };
}
