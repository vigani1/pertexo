export function escapeCsvValue(value: unknown): string {
  let text =
    typeof value === 'string'
      ? value
      : value === null
        ? ''
        : JSON.stringify(value);
  if (typeof value === 'string' && /^(?:[=+\-@\t\r\n]|\s+[=+\-@])/u.test(text))
    text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
