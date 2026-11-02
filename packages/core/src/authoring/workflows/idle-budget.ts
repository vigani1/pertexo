import { AUTHORING_VALIDATION_BUDGET } from '@pertexo/workflow-model/server';

const parserWaitMs =
  AUTHORING_VALIDATION_BUDGET.queueMs +
  AUTHORING_VALIDATION_BUDGET.startupMs +
  AUTHORING_VALIDATION_BUDGET.parseMs +
  AUTHORING_VALIDATION_BUDGET.terminationMs;

/** pg_settings exposes the effective connection setting in its declared unit. */
export function authoringIdleBudgetIsSafe(
  setting: unknown,
  unit: unknown,
): boolean {
  if (typeof setting !== 'string' || !/^[0-9]+$/u.test(setting)) return false;
  const multipliers: Readonly<Record<string, number>> = {
    us: 0.001,
    ms: 1,
    s: 1000,
    min: 60000,
    h: 3600000,
  };
  if (typeof unit !== 'string') return false;
  const multiplier = multipliers[unit];
  if (multiplier === undefined) return false;
  const duration = Number(setting) * multiplier;
  // Zero means unlimited, not evidence of a bounded effective deadline.
  return (
    Number.isSafeInteger(Number(setting)) &&
    Number.isFinite(duration) &&
    duration > parserWaitMs
  );
}
