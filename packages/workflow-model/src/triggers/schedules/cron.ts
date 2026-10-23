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

/** Only the server parses cron; both boundaries refuse the same extended operators. */
export function cronHasUnsupportedOperators(expression: string): boolean {
  return expression.split(/\s+/u).some((field, index) => {
    const names = index === 3 ? monthNames : index === 4 ? dayNames : undefined;
    const operators = field.replace(/[a-z]+/giu, (token) =>
      names?.has(token.toUpperCase()) === true ? '' : token,
    );
    return /[H?#L]/iu.test(operators);
  });
}
