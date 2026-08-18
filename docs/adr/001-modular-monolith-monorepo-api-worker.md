# ADR 001: Modular monolith, monorepo, and API/worker deployment roles

- **Status:** accepted
- **Date:** 2026-08-18

## Context

The platform has one evolving workflow domain, but it has two materially
different runtime responsibilities. Product HTTP traffic, authentication,
webhooks, control-plane commands, queries, and SSE belong at the API edge.
Workflow coordination, node-attempt execution, due work, schedules, and
transactional-outbox dispatch must not run in an API process. Both sides need
the same workflow model, node contracts, event contracts, and application
capabilities while those contracts are still changing.

Starting with networked microservices would introduce service contracts,
deployment coordination, and operational failure modes before the domain
boundaries or scale require them. Conversely, running execution in the API
would couple user-facing availability and latency to long-running or
side-effecting work and would violate the platform's execution boundary.

## Decision

Build the backend as a TypeScript modular monolith in one workspace monorepo.
The monolith is modular in code and package ownership, not a collection of
networked services. Product capabilities are organized as explicit modules;
modules do not import one another's repositories. Cross-module work goes
through a narrow application capability or a domain/outbox event.

The repository contains the existing web application plus these backend
roles and packages:

- `apps/api`: a NestJS application using the Fastify adapter for REST, auth,
  webhooks, control-plane operations, and SSE. It may enqueue work, but it
  never executes production workflow nodes.
- `apps/worker`: a Nest standalone application context with no HTTP server.
  Thin consumers validate jobs, establish tracing, and call application
  use cases for workflow coordination, node-attempt execution, due work,
  schedule control, maintenance, and outbox dispatch.
- Shared packages for public contracts, database adapters, workflow modeling,
  the framework-independent execution engine, node SDK/definitions,
  integrations, queue contracts/adapters, and observability.

`apps/api` and `apps/worker` are independently deployable process roles built
from the same release. They may scale, drain, restart, and receive distinct
resource and health-check settings. In V1, scheduler and dispatcher duties
are worker profiles protected by PostgreSQL leases; they are not separate
services. Webhook ingress remains an API route. A later deployment split is
allowed when scaling or failure isolation justifies it, without duplicating
domain logic.

The monorepo uses workspace package boundaries (the repository conversion may
realize these with pnpm workspaces). Package direction is explicit:

- `api` can depend on public contracts, database/application capabilities,
  workflow modeling, and queue producers.
- `worker` can depend on application capabilities, the database, queue
  consumers/adapters, the workflow engine, and node executors.
- `workflow-model`, `workflow-engine`, and node definitions remain free of
  NestJS, Drizzle, Redis, BullMQ, HTTP, and browser imports.
- Queue messages carry identifiers and bounded contract data, never workflow
  graphs, files, or secrets.

## Consequences

Positive consequences:

- API availability and latency are isolated from workflow execution and
  worker backlogs.
- API and worker scale independently while consuming the exact same checked
  workflow and event contracts.
- Shared package changes are reviewable and deployable together without
  publishing private packages or coordinating version drift.
- Capability modules and package rules provide seams for future extraction
  when a real process, persistence, external-system, or scaling boundary is
  demonstrated.
- PostgreSQL remains the durable authority while workers use queue transport;
  this keeps recovery and scheduling semantics in the domain rather than in
  deployment topology.

Costs and obligations:

- The monorepo requires strict package export maps, dependency checks, and
  ownership discipline to prevent a generic shared-code or repository bucket.
- A release must preserve compatible API, worker, queue, and event contracts
  across a rolling deployment.
- Separate process roles require distinct commands, health checks, resource
  settings, graceful shutdown, and operational dashboards.
- A modular monolith does not provide independent service fault domains; a
  later extraction must be justified and designed as a new ADR.

## Rejected alternatives

### Networked microservices from the start

Rejected for V1. The plan does not establish stable service boundaries or a
need for dozens of independently released services. Premature RPC boundaries
would add coordination and failure modes without improving the required API
/ worker separation.

### One combined API-and-worker deployment

Rejected. It would allow execution load, blocking I/O, and worker memory
pressure to affect product HTTP traffic, and it would make independent scaling
and draining impossible. No production container runs both roles together.

### Separate repositories for API and worker

Rejected for the current phase. Separate repositories would require publishing
and coordinating private workflow, node, and event packages while the domain
is evolving, increasing version drift without a demonstrated benefit.

## Implementation constraints

This decision does not authorize speculative services, deployment pools, or
infrastructure. Implement the repository shape and two process roles in the
authoritative backend plan. The execution engine remains framework-independent;
API and worker integrations enter through application ports and explicit
adapters. Any future service extraction, dedicated worker pool, or additional
deployment role requires evidence of a real scaling, security, or failure
isolation boundary and a superseding or follow-up ADR.
