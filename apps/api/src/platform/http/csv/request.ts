import {
  applicationError,
  throwApplicationError,
} from '../application-error.js';

export function decodeCsvDownloadRequest<T>(
  body: unknown,
  contentType: string | undefined,
  parse: (value: unknown) => T,
) {
  if (
    contentType?.split(';', 1)[0]?.trim().toLowerCase() !==
    'application/x-www-form-urlencoded'
  )
    return {
      query: parse(body),
      csrfToken: undefined,
    };
  if (!Buffer.isBuffer(body) && typeof body !== 'string')
    return throwApplicationError(applicationError('request.invalid'));
  const form = new URLSearchParams(body.toString());
  if (
    form.size !== 2 ||
    form.getAll('payload').length !== 1 ||
    form.getAll('csrfToken').length !== 1
  )
    return throwApplicationError(applicationError('request.invalid'));
  let value: unknown;
  try {
    value = JSON.parse(form.get('payload') ?? '');
  } catch {
    return throwApplicationError(applicationError('request.invalid'));
  }
  return {
    query: parse(value),
    csrfToken: form.get('csrfToken') ?? undefined,
  };
}
