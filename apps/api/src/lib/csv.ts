// RFC-4180 CSV cells + spreadsheet-formula neutralization (M-13).
// Excel/Sheets execute a cell that starts with =, +, -, @, tab, or CR.

export function csvCell(v: unknown): string {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\n\r']/.test(s) || s.startsWith("'")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function toCSV(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return '';
  const headers = Object.keys(rows[0]!);
  return [
    headers.join(','),
    ...rows.map((r) => headers.map((h) => csvCell(r[h])).join(',')),
  ].join('\n');
}

export function csvRow(values: unknown[]): string {
  return values.map(csvCell).join(',');
}
