/** Normalize the two pg query forms used by failure-injection fixtures. */
export function requestText(request: unknown): string {
  if (typeof request === 'string') return request;
  const configHasText =
    typeof request === 'object' && request !== null && 'text' in request;
  if (configHasText && typeof request.text === 'string') return request.text;
  return '';
}
