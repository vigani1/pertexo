const monthNames = new Set([
  'JAN',
  'FEB',
  'MAR',
  'APR',
  'MAY',
  'JUN',
  'JUL',
  'AUG',
  'SEP',
  'OCT',
  'NOV',
  'DEC',
]);
const dayNames = new Set(['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']);

const fieldNames: Readonly<Partial<Record<number, ReadonlySet<string>>>> = {
  3: monthNames,
  4: dayNames,
};

/** Only the server parses cron; both boundaries refuse the same extended operators. */
export function cronHasUnsupportedOperators(expression: string): boolean {
  return expression.split(/\s+/u).some((field, index) => {
    const names = fieldNames[index];
    const operators = field.replace(/[a-z]+/giu, (token) =>
      (names?.has(token.toUpperCase()) ?? false) ? '' : token,
    );
    return /[H?#L]/iu.test(operators);
  });
}
