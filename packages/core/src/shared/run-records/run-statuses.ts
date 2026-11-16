/** Runs executing or waiting for work, excluding queued and terminal runs. */
export const EXECUTING_RUN_STATUSES = ['running', 'waiting'] as const;
