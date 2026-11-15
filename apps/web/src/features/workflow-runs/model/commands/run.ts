import { IDEMPOTENCY_KEY_RETENTION_HOURS } from '@pertexo/contracts';
export const RUN_COMMAND_EXPIRED_MESSAGE = `The original request’s ${String(IDEMPOTENCY_KEY_RETENTION_HOURS)}-hour retry window has ended. Check run history before starting another run.`;
