export function escapeCsvValue(value: unknown): string {
  let text: string;
  if (typeof value === 'string') text = value;
  else if (value === null) text = '';
  else text = JSON.stringify(value);
  if (typeof value === 'string' && /^(?:[=+\-@\t\r\n]|\s+[=+\-@])/u.test(text))
    text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
