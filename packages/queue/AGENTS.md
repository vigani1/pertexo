# @pertexo/queue

Follow the [root rules](../../AGENTS.md); this file only adds to them.

## Purpose and boundary

The Redis transport for work PostgreSQL already decided: BullMQ queues and
their job envelopes, the producer the outbox publishes through, the consumer
the worker runs, and the small pub/sub hints (live run events, inbox changes)
the API listens for. Node only (`@pertexo/queue/server`), used by the API and
the worker.

It never owns a business decision: retries, ordering and state live in
PostgreSQL (`core`, `workflow-engine`); BullMQ redelivery only covers
transport loss. It never reads the environment (callers pass the Redis URL and
timeouts) and never logs (it reports through observers).

## Layout

- `src/server.ts`: the entry.
- `jobs/`: queue and job names, the job envelope schemas
  (`queue-job.schemas.ts`), job ids, per-queue defaults and delivery
  admission.
- `publication/`: the producer runtime (`bullmq-producer.runtime.ts`), its
  options, types and errors.
- `consumption/`: the consumer runtime (`bullmq-consumer.runtime.ts`), its
  options, types and errors, and the observer guard.
- `pubsub/`: the bounded hint publisher and the run-event and inbox channels.
- `redis/`: shared Redis plumbing: endpoint normalisation, bounded
  operations, command instrumentation and metrics.

## Where new code goes

- A new job: its name in `jobs/names.ts`, its schema and registry entry in
  `jobs/queue-job.schemas.ts`, and a case in `test/fixtures/queue-jobs.json`
  so the compatibility test pins its wire shape.
- A new queue: `QUEUE_NAME`, `QUEUE_FOR_JOB`, `QUEUE_CLASS_DEFAULTS` and the
  producer's queue map.
- A new hint channel: a file in `pubsub/` built on `BoundedRedisPublisher`.
- A new Redis client role: `RedisClientRole` in `redis/redis-instrumentation.ts`.

## Defaults and config

- Per-queue attempts, backoff, locks, timeouts, concurrency and retention:
  `QUEUE_CLASS_DEFAULTS` in `jobs/defaults.ts`.
- Producer and consumer timeouts and their bounds: `producer-options.ts` and
  `consumer-options.ts`; runtime poll intervals: constants at the top of
  each runtime; the consumer's forced-teardown budget:
  `consumption/close-consumer-connections.ts`.
- Hint sizes and publish timeouts: constants at the top of each `pubsub/` file.

## Rules

- Every job crosses Redis as a schema-checked envelope; consumers admit it
  with `admitQueueDelivery` before running a handler.
- Every Redis call is bounded (`redis/bounded-operation.ts` or the client's
  own timeout) and observed through `redis/redis-instrumentation.ts`.
- Redis URL failures use `REDIS_ENDPOINT_ERROR_MESSAGE`. Errors live in their
  area's errors file: `jobs/queue-job.errors.ts`, `publication/` and
  `consumption/` (delivery admission is the consumer's), `pubsub/pubsub.errors.ts`.
  A generic `Error` only wraps a rejection value that isn't an `Error`.

## Exceptions

- None.

## What guards it

- `pnpm --filter @pertexo/queue test`: envelopes, defaults, both runtimes
  against mocked BullMQ and Redis, and the hint channels.
- `pnpm --filter @pertexo/queue test:integration` needs a real Redis
  (`REDIS_URL`): stopped-consumer and metrics behaviour.
- `pnpm check`: package structure, naming, environment and backend-limits
  checks.
