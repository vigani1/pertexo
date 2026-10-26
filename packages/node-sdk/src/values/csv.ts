/** Text a spreadsheet could read as a formula; CSV and Excel files both protect it. */
export function looksLikeFormula(text: string): boolean {
  return /^(?:[=+\-@\t\r\n]|\s+[=+\-@])/u.test(text);
}

export function escapeCsvValue(value: unknown): string {
  let text: string;
  if (typeof value === 'string') text = value;
  else if (value === null) text = '';
  else text = JSON.stringify(value);
  if (typeof value === 'string' && looksLikeFormula(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
