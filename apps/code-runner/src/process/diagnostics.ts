/** PostgreSQL text cannot retain NUL or lone surrogates. Show a visible escape. */
export function retainCodeText(value: string, maximum: number) {
  const printable = value.toWellFormed().replaceAll('\0', '\\u0000');
  return {
    message: printable.slice(0, maximum).toWellFormed(),
    truncated: printable.length > maximum,
  };
}
