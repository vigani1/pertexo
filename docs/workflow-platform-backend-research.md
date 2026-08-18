# Workflow Automation Backend Research

Last reviewed: 2026-08-18

## Purpose

This document compares the publicly documented execution architecture of large
workflow automation products. It focuses on the decisions that matter for our
new backend: workflow storage, execution granularity, queues, workers, scaling,
durability, node definitions, and live run visibility.

Vendor internals that are not publicly documented are marked as unknown. Product
behavior is not treated as proof of a specific backend implementation.

## Executive Findings

The products converge on the same high-level split:

1. A control plane owns users, workspaces, workflow drafts, versions,
   credentials, triggers, and execution history.
2. A data plane accepts run requests through a durable queue and executes them
   on workers.
3. The database is the durable source of truth. The queue transports work; it
   is not the only record that a run exists.
4. Workers scale independently from the web application.
5. Published workflow versions are immutable or otherwise pinned to each run.
6. Large outputs and binary files do not travel through the queue payload.
7. Node definitions are versioned contracts. They are not React components and
   they are not stored as arbitrary per-workflow code.

The major disagreement is the **unit of dispatch**:

- Zapier publicly described queueing every workflow step.
- n8n queues an execution ID and a worker runs the workflow.
- Windmill queues every step as a job and can run parallel branches on separate
  workers.
- Temporal durably schedules orchestration tasks and side-effecting activities.

There is no universally correct choice. Per-step dispatch gives excellent
isolation and parallel scaling but adds queue, persistence, and coordination
overhead. Whole-run dispatch is simpler and faster for ordinary I/O workflows,
but needs checkpoints to recover without replaying completed side effects.

## Platform Comparison

| Platform  | Definition model                                           | Dispatch unit                                                        | Durable state                                                                 | Worker and scaling model                                                         |
| --------- | ---------------------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Zapier    | Published Zap version composed of steps and Paths          | Public engineering material says one RabbitMQ message per Zap step   | Private implementation; product exposes versions and run history              | Python/Celery workers on Kubernetes; KEDA scales from RabbitMQ backlog           |
| n8n       | Workflow graph with versioned node types                   | One execution ID is queued; a worker loads and executes the workflow | SQL database for workflows and results; Redis for queue coordination          | Main/API process, optional webhook processors, and horizontally scalable workers |
| Make      | Scenario made of modules, routes, filters, and bundles     | Not publicly documented                                              | Product exposes scenario state, queued webhooks, bundles, and run history     | Internal server topology is not publicly documented                              |
| Windmill  | JSON-serializable OpenFlow definition                      | Each step is an individual job                                       | PostgreSQL queue and completed-job records; optional S3 logs                  | Workers pull one job at a time; tags route jobs to worker groups                 |
| Pipedream | Trigger plus ordered source/action/code steps              | One event invokes a workflow execution environment                   | Managed platform; workflow-specific queues support concurrency and throttling | Ephemeral execution VMs with optional dedicated pre-warmed workers               |
| Temporal  | Deterministic workflow code plus side-effecting activities | Workflow tasks and activity tasks                                    | Durable event history and task queues owned by Temporal                       | Application workers long-poll task queues; queues distribute load across workers |

## Zapier

### What is public

Zapier states that RabbitMQ is central to Zap processing and that it enqueues a
message for each step. Backend workers consume those messages on Kubernetes.
Zapier moved from CPU-only autoscaling to KEDA because blocking I/O could leave
CPU low while the message backlog grew. This is a strong argument for scaling
workers from queue depth and schedule-to-start latency rather than CPU alone.

Zapier also publicly describes a large Python/Celery worker fleet. Its current
edge uses Envoy Gateway, but the scale of Zapier's ingress platform is not a
reasonable starting requirement for our backend.

Sources:

- [How Zapier uses KEDA](https://zapier.com/blog/keda-at-zapier/)
- [Zapier engineering articles](https://zapier.com/blog/categories/engineering/)
- [Zapier's ingress architecture](https://zapier.com/blog/zapier-journey-beyond-ingress-nginx/)

### Product behavior worth copying

- A published version is immutable.
- Editing creates a draft and does not mutate the running version.
- Each run can be traced to the version that executed.
- Run history and replay are first-class user surfaces.

Source: [Zap drafts and versions](https://help.zapier.com/hc/en-us/articles/9693520498445-Create-Zap-drafts-and-versions)

### What not to assume

Zapier does not publish a complete current schema, transaction model, or run
state machine. Its per-step RabbitMQ description is useful evidence, but not a
blueprint to reproduce every internal service.

## n8n

### Execution topology

n8n documents its queue mode clearly:

1. A main instance receives timers and webhooks and creates an execution.
2. It sends the execution ID to Redis.
3. A worker takes the job and loads workflow data from the database.
4. The worker executes the workflow and writes results to the database.
5. Redis informs the main instance that execution finished.

Production deployments can add dedicated webhook processors. Workers and
webhook processors are stateless and horizontally scalable; PostgreSQL and
Redis are shared. n8n recommends external object storage for binary data in
queue mode.

Sources:

- [n8n queue mode](https://docs.n8n.io/deploy/host-n8n/configure-n8n/scaling/enable-queue-mode/)
- [n8n production Helm architecture](https://github.com/n8n-io/n8n-hosting/tree/main/charts/n8n)
- [n8n external binary storage](https://docs.n8n.io/hosting/scaling/external-storage/)

### Node architecture

n8n separates shared workflow contracts, the execution engine, the API server,
the editor, and built-in nodes into packages. A node definition includes
metadata and UI configuration plus one of several runtime forms: `execute`,
polling, trigger, webhook lifecycle, or declarative request routing. Node types
and credentials are versioned independently from workflow instances.

Sources:

- [n8n repository architecture](https://github.com/n8n-io/n8n/blob/master/AGENTS.md)
- [n8n node structure](https://github.com/n8n-io/n8n/blob/master/packages/nodes-base/AGENTS.md)

### Important lesson

n8n is close to our existing runtime: one queued workflow run, one worker, one
shared engine. It is operationally simpler than dispatching every node, but a
large workflow can occupy a worker and requires careful concurrency, memory,
and crash-recovery design. n8n also exposes a setting to offload manual runs to
workers, which supports keeping production execution out of the web process.

## Make

### What is public

Make documents the runtime semantics users observe:

- A trigger produces one or more bundles.
- Bundles move through modules and routes.
- A completed module exposes its input and output operations.
- Instant webhooks run in parallel by default.
- A workflow can instead process incoming events in order.
- Scheduled webhook events can accumulate in a queue.
- Previous trigger data can be replayed through the current scenario.

Sources:

- [Make scenario execution flow](https://help.make.com/scenario-execution-flow)
- [Make webhooks and ordering](https://help.make.com/webhooks)
- [Make scenario run replay](https://help.make.com/scenario-run-replay)

### What is not public

Make does not publicly document enough of its server topology to state which
broker, database, load balancer, or worker scheduler executes a module. We can
copy its observable product behavior, especially operation-level inspection,
without pretending to know its internal deployment.

## Windmill

Windmill uses a JSON-serializable workflow definition and queues each workflow
step as an individual job. Sequential jobs run one after another; parallel
branches are queued together and can execute on different workers; a join is
queued only after its branches finish. Workers atomically claim jobs, stream
logs, and persist results. Worker tags route database, language, or specialized
jobs to different pools.

This architecture has excellent isolation and horizontal parallelism. Its cost
is higher database and queue traffic, more coordination records, and more
complex cancellation and join semantics.

Sources:

- [Windmill flow architecture](https://www.windmill.dev/docs/flows/architecture)
- [Windmill workers and worker groups](https://www.windmill.dev/docs/core_concepts/worker_groups)
- [Windmill jobs](https://www.windmill.dev/docs/core_concepts/jobs)

Windmill's checkpoint/replay model is especially useful for waits and approvals:
the workflow persists completed step results and releases the worker while it
is suspended. A long wait consumes no worker slot.

Source: [Windmill workflows as code](https://www.windmill.dev/docs/core_concepts/workflows_as_code)

## Pipedream

Pipedream separates event sources from workflow actions. Sources have trigger
lifecycle and deduplication behavior; actions accept typed props and return
JSON-serializable output. Components run in managed execution environments.
Workflow-specific queues implement concurrency and throttling. Dedicated
pre-warmed virtual machines are available when low latency matters.

Sources:

- [Pipedream component model](https://pipedream.com/docs/components)
- [Pipedream concurrency and throttling](https://pipedream.com/docs/workflows/building-workflows/settings/concurrency-and-throttling)
- [Pipedream execution workers](https://pipedream.com/docs/workflows/building-workflows/settings)

The useful idea for us is not one VM per ordinary run. It is capability-based
isolation: custom code, browser automation, GPU work, and ordinary HTTP actions
should not all share one unrestricted worker pool.

## Temporal As A Runtime Option

Temporal is not a visual automation product, but it is a mature durable
execution substrate. The Temporal service owns event history and task queues;
application workers poll those queues and execute workflow or activity code.
Workers can disappear and another worker can continue from durable history.
Task queues also provide a clean way to isolate workloads and scale them
independently.

Sources:

- [Temporal worker and task queue model](https://temporal.io/changelog/announcing-auto-tuning-for-workers-in-pre-release)
- [Temporal durable execution guide](https://assets.temporal.io/durable-execution.pdf)

Temporal would remove much of the durability machinery we otherwise build, but
it introduces a substantial platform dependency and deterministic replay rules.
A dynamic user-authored graph would still need our own interpreter, node
registry, persistence model, authorization, and product APIs. It is a viable
future engine choice, not a substitute for our backend.

## Architecture Lessons For Our Product

### Adopt

- A control-plane/data-plane split.
- Stateless API and webhook instances behind a load balancer.
- Workers that pull work; workers are not HTTP targets behind the load balancer.
- Immutable published graph versions referenced by every run.
- Durable run rows created before queue publication.
- Queue messages containing identifiers rather than complete graphs or secrets.
- Queue-depth and schedule-to-start metrics for autoscaling.
- Separate worker pools only for genuinely different resource or trust needs.
- Checkpointed waits and approvals that release worker capacity.
- Bounded node input/output previews and object storage for files or large data.
- Explicit concurrency, rate, ordering, retry, and idempotency policies.

### Avoid

- Executing production workflows inside Next.js request handlers.
- Treating Redis or BullMQ as the only durable record of a run.
- One database row per arbitrary UI field.
- One queue or deployment per node type.
- Automatic retries of non-idempotent external actions.
- Passing raw secrets, files, or entire workflow graphs in queue jobs.
- Per-node microservices before workload isolation proves they are necessary.
- Re-validating an unchanged published graph in full before every run.

## Recommended Execution Granularity

For our first owned backend, use a **checkpointed whole-run coordinator with
capability jobs**, rather than either extreme:

- An ordinary run is claimed by one workflow worker.
- The worker interprets the immutable graph and executes ordinary integration
  nodes with bounded concurrency.
- Each completed node attempt and scheduler checkpoint is persisted.
- Waits, approvals, and delayed retries suspend the run and release the worker.
- Heavy or untrusted work is delegated to a capability queue and resumes the
  coordinator when complete.
- A worker crash resumes from the last committed checkpoint.

This preserves n8n's operational simplicity for common workflows, Windmill's
ability to suspend and isolate special work, and Zapier's durable per-step
visibility without forcing every lightweight node through a separate broker
round trip.
