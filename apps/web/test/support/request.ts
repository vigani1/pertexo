export function getRequestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

export function readRequestJson({
  body,
  missingMessage,
}: Readonly<{
  body: BodyInit | null | undefined;
  missingMessage: string;
}>): unknown {
  if (typeof body !== 'string') throw new Error(missingMessage);
  return JSON.parse(body) as unknown;
}
