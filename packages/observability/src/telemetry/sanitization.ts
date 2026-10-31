import type {
  Attributes,
  Exception,
  Span,
  SpanOptions,
} from '@opentelemetry/api';
import type { IncomingMessage, RequestOptions } from 'node:http';

import type { UndiciRequest } from '@opentelemetry/instrumentation-undici';

const REDACTED_EXCEPTION = '[Redacted exception]';

function safePath(value: unknown): string {
  const candidate = typeof value === 'string' && value.length > 0 ? value : '/';

  try {
    return (new URL(candidate, 'http://localhost').pathname || '/').replace(
      /(\/hooks\/)[^/]+/gu,
      '$1[Redacted]',
    );
  } catch {
    return '/';
  }
}

function safeAuthority(
  value: unknown,
  protocol: 'http:' | 'https:' = 'http:',
): { readonly hostname: string; readonly port: string | undefined } {
  if (typeof value !== 'string' || value.length === 0) {
    return { hostname: 'localhost', port: undefined };
  }

  try {
    const parsed = new URL(`${protocol}//${value}`);
    return {
      hostname: parsed.hostname,
      port: parsed.port || undefined,
    };
  } catch {
    return { hostname: 'localhost', port: undefined };
  }
}

function safeOrigin(
  value: unknown,
  fallbackProtocol: 'http:' | 'https:' = 'http:',
): string {
  if (typeof value !== 'string' || value.length === 0) {
    return `${fallbackProtocol}//localhost`;
  }

  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return `${fallbackProtocol}//localhost`;
    }
    return parsed.origin;
  } catch {
    return `${fallbackProtocol}//localhost`;
  }
}

function safePort(value: unknown): string | undefined {
  let port: string | undefined;
  if (typeof value === 'number') {
    port = Number.isInteger(value) ? String(value) : undefined;
  } else if (typeof value === 'string') {
    port = value;
  }

  if (port === undefined || !/^\d{1,5}$/u.test(port)) {
    return undefined;
  }

  const numericPort = Number(port);
  return numericPort <= 65_535 ? port : undefined;
}

function sanitizeException(exception: unknown): Exception {
  if (typeof exception === 'string') {
    return REDACTED_EXCEPTION;
  }

  try {
    return exception instanceof Error
      ? { name: 'Error' }
      : { name: 'NonError' };
  } catch {
    return { name: 'NonError' };
  }
}

const sanitizedSpans = new WeakSet<Span>();

export function installErrorSanitizer(span: Span): void {
  if (sanitizedSpans.has(span)) {
    return;
  }
  sanitizedSpans.add(span);

  const recordException = span.recordException.bind(span);
  span.recordException = (exception, time) => {
    recordException(sanitizeException(exception), time);
  };

  const setStatus = span.setStatus.bind(span);
  span.setStatus = (status) => {
    if (status.message === undefined) {
      return setStatus(status);
    }
    return setStatus({ code: status.code });
  };
}

function undefinedUrlAttributes(): Attributes {
  return {
    'http.target': undefined,
    'http.url': undefined,
    'url.query': undefined,
  };
}

export function sanitizeIncomingHttpRequest(
  request: IncomingMessage,
): Attributes {
  const attributes = undefinedUrlAttributes();
  const host = request.headers.host;
  const authority = safeAuthority(host);

  return {
    ...attributes,
    'server.address': authority.hostname,
    'server.port':
      authority.port === undefined ? undefined : Number(authority.port),
    'url.path': safePath(request.url),
  };
}

export function sanitizeOutgoingHttpRequest(
  request: RequestOptions,
): Attributes {
  const protocol = request.protocol === 'https:' ? 'https:' : 'http:';
  const authority = safeAuthority(request.hostname ?? request.host, protocol);
  const port = safePort(request.port) ?? authority.port;
  const defaultPort = protocol === 'https:' ? '443' : '80';
  const portSuffix =
    port === undefined || port === defaultPort ? '' : `:${port}`;
  const origin = `${protocol}//${authority.hostname}${portSuffix}`;

  return {
    ...undefinedUrlAttributes(),
    'url.full': `${origin}${safePath(request.path)}`,
    'url.path': safePath(request.path),
  };
}

export function sanitizeUndiciRequest(request: UndiciRequest): Attributes {
  return {
    ...undefinedUrlAttributes(),
    'url.full': `${safeOrigin(request.origin)}${safePath(request.path)}`,
    'url.path': safePath(request.path),
  };
}

/**
 * Nest's request span records the address as sent. A query can hold what a
 * request carries in the open, like an OAuth2 callback's code and state.
 */
export function sanitizeNestSpanOptions(options?: SpanOptions): SpanOptions {
  const address = options?.attributes?.['url.full'];
  return address === undefined
    ? (options ?? {})
    : {
        ...options,
        attributes: { ...options?.attributes, 'url.full': safePath(address) },
      };
}

export function sanitizeHttpSpan(span: Span): void {
  installErrorSanitizer(span);
}
