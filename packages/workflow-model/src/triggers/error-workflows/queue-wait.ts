/**
 * How long a failed run's error workflow waits for queue capacity before it
 * is refused. Core holds the delivery that long; the run page says it.
 */
export const ERROR_WORKFLOW_QUEUE_WAIT_SECONDS = 15 * 60;
