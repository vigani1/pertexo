import { COMMAND_RETRY_WINDOW_HOURS } from '@/lib/api/commands/command-retry';
export const RUN_COMMAND_EXPIRED_MESSAGE = `The original request’s ${String(COMMAND_RETRY_WINDOW_HOURS)}-hour retry window has ended. Check run history before starting another run.`;
