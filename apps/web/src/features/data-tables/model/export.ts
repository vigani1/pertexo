export function downloadTableCsv(name: string, csv: string): void {
  const url = URL.createObjectURL(
    new Blob([csv], { type: 'text/csv;charset=utf-8' }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = `${name}-rows.csv`;
  link.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 0);
}
