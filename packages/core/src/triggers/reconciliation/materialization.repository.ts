import { decodeStoredValue } from '../../shared/stored-values.js';
import { and, desc, eq, exists, isNull, ne, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  workflowTriggers,
  webhookTriggerEndpoints as endpoints,
  triggerSchedules as schedules,
} from '@pertexo/database/schema';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import type { WorkflowTriggerStatus } from '@pertexo/workflow-model';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import {
  parseScheduleRecurrence,
  resolveScheduleObservation,
  type ScheduleRecurrence,
} from '../schedules/recurrence.js';
import { WorkflowTriggerReconciliationMismatchError } from './trigger-reconciliation.errors.js';

function desiredScheduleConfig(value: unknown): Readonly<{
  recurrence: ScheduleRecurrence;
  misfirePolicy: 'catch_up_once' | 'skip';
}> {
  const config = z.record(z.string(), z.unknown()).parse(value);
  const kind = z.enum(['cron', 'interval']).parse(config.kind);
  return Object.freeze({
    recurrence: parseScheduleRecurrence(
      kind === 'cron'
        ? {
            kind,
            expression: config.expression,
            timezone: config.timezone,
          }
        : { kind, intervalMinutes: config.intervalMinutes },
    ),
    misfirePolicy: z
      .enum(['catch_up_once', 'skip'])
      .default('catch_up_once')
      .parse(config.misfirePolicy),
  });
}

type ReconciliationScope = Readonly<{
  workspaceId: string;
  workflowId: string;
  versionId: string;
}>;

/** Apply immutable publication configuration without re-enabling disabled resources. */
export async function reconcileActiveWorkflowTriggers(
  client: PoolClient,
  scope: ReconciliationScope,
): Promise<void> {
  const observation = await drizzle(client)
    .execute<{ observedAt: string }>(sql`select clock_timestamp() "observedAt"`)
    .catch(rethrowQueryFailure);
  const observedAt = observation.rows[0]?.observedAt;
  if (observedAt === undefined)
    throw new Error('Schedule database observation is unavailable');
  const desired = await readDesiredSchedules(client, scope);
  for (const row of desired)
    await materializeSchedule(client, scope.workspaceId, {
      row,
      observedAt: new Date(observedAt),
    });
  await retirePreviousResources(client, scope);
  await applyResourceDispositions(client, scope);
}

async function retirePreviousResources(
  client: PoolClient,
  { workspaceId, workflowId, versionId }: ReconciliationScope,
): Promise<void> {
  const db = drizzle(client);
  await db
    .update(workflowTriggers)
    .set({
      status: 'disabled',
      healthStatus: 'disabled',
      lastErrorCode: null,
      reconciledAt: sql`clock_timestamp()`,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(workflowTriggers.workspaceId, workspaceId),
        eq(workflowTriggers.workflowId, workflowId),
        ne(workflowTriggers.workflowVersionId, versionId),
        ne(workflowTriggers.status, 'disabled'),
      ),
    )
    .catch(rethrowQueryFailure);
  const oldSchedule = db
    .select({ one: sql`1` })
    .from(workflowTriggers)
    .where(
      and(
        eq(workflowTriggers.id, schedules.triggerId),
        eq(workflowTriggers.workflowId, workflowId),
        ne(workflowTriggers.workflowVersionId, versionId),
      ),
    );
  await db
    .update(schedules)
    .set({
      retiredAt: sql`clock_timestamp()`,
      leaseOwner: null,
      leaseToken: null,
      leaseAcquiredAt: null,
      leaseExpiresAt: null,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(schedules.workspaceId, workspaceId),
        exists(oldSchedule),
        isNull(schedules.retiredAt),
      ),
    )
    .catch(rethrowQueryFailure);
}

function readDesiredSchedules(
  client: PoolClient,
  { workspaceId, workflowId, versionId }: ReconciliationScope,
) {
  const trigger = alias(workflowTriggers, 'trigger');
  return drizzle(client)
    .select({
      id: trigger.id,
      nodeId: trigger.nodeId,
      workflowId: trigger.workflowId,
      versionId: trigger.workflowVersionId,
      desiredConfig: trigger.desiredConfig,
      configFingerprint: trigger.configFingerprint,
      persistedFingerprint: schedules.configFingerprint,
    })
    .from(trigger)
    .leftJoin(schedules, eq(schedules.triggerId, trigger.id))
    .where(
      and(
        eq(trigger.workspaceId, workspaceId),
        eq(trigger.workflowId, workflowId),
        eq(trigger.workflowVersionId, versionId),
        eq(trigger.kind, 'schedule'),
      ),
    )
    .orderBy(trigger.id)
    .for('update', { of: trigger })
    .catch(rethrowQueryFailure);
}

async function materializeSchedule(
  client: PoolClient,
  workspaceId: string,
  {
    row,
    observedAt,
  }: Readonly<{
    row: Awaited<ReturnType<typeof readDesiredSchedules>>[number];
    observedAt: Date;
  }>,
): Promise<void> {
  const desired = decodeStoredValue(() =>
    desiredScheduleConfig(row.desiredConfig),
  );
  if (
    row.persistedFingerprint !== null &&
    row.persistedFingerprint !== row.configFingerprint
  )
    throw new WorkflowTriggerReconciliationMismatchError(
      'Materialized schedule configuration does not match its immutable trigger',
    );
  const predecessor = alias(schedules, 'predecessor');
  const [previous] = await drizzle(client)
    .select({ schedule: predecessor })
    .from(predecessor)
    .innerJoin(workflowTriggers, eq(workflowTriggers.id, predecessor.triggerId))
    .where(
      and(
        eq(predecessor.workspaceId, workspaceId),
        eq(workflowTriggers.workflowId, row.workflowId),
        eq(workflowTriggers.nodeId, row.nodeId),
      ),
    )
    .orderBy(
      sql`${predecessor.retiredAt} desc nulls first`,
      desc(predecessor.createdAt),
    )
    .limit(1)
    .for('update', { of: predecessor })
    .catch(rethrowQueryFailure);
  const prior = previous?.schedule;
  // Reconciliation of the serving instance must not reset its cursor or lease.
  if (prior?.triggerId === row.id && prior.retiredAt === null) return;
  await drizzle(client)
    .insert(schedules)
    .values({
      triggerId: row.id,
      workspaceId,
      recurrenceKind: desired.recurrence.kind,
      cronExpression:
        desired.recurrence.kind === 'cron'
          ? desired.recurrence.expression
          : null,
      timezone:
        desired.recurrence.kind === 'cron' ? desired.recurrence.timezone : null,
      intervalMinutes:
        desired.recurrence.kind === 'interval'
          ? desired.recurrence.intervalMinutes
          : null,
      misfirePolicy: desired.misfirePolicy,
      configFingerprint: row.configFingerprint,
      ...scheduleOperationalState(prior, desired.recurrence, observedAt),
      retiredAt: null,
    })
    .onConflictDoUpdate({
      target: schedules.triggerId,
      set: {
        ...scheduleOperationalState(prior, desired.recurrence, observedAt),
        retiredAt: null,
        leaseOwner: null,
        leaseToken: null,
        leaseAcquiredAt: null,
        leaseExpiresAt: null,
        updatedAt: sql`clock_timestamp()`,
      },
    })
    .catch(rethrowQueryFailure);
}

function scheduleOperationalState(
  prior: typeof schedules.$inferSelect | undefined,
  recurrence: ScheduleRecurrence,
  observedAt: Date,
): Pick<
  typeof schedules.$inferSelect,
  | 'status'
  | 'anchorAt'
  | 'nextFireAt'
  | 'lastFireAt'
  | 'admissionDeferredUntil'
  | 'healthStatus'
  | 'lastErrorCode'
> {
  const unchanged =
    prior !== undefined &&
    (recurrence.kind === 'interval'
      ? prior.recurrenceKind === 'interval' &&
        prior.intervalMinutes === recurrence.intervalMinutes
      : prior.recurrenceKind === 'cron' &&
        prior.cronExpression === recurrence.expression &&
        prior.timezone === recurrence.timezone);
  if (unchanged)
    return {
      status: prior.status,
      anchorAt: prior.anchorAt,
      nextFireAt: prior.nextFireAt,
      lastFireAt: prior.lastFireAt,
      admissionDeferredUntil: prior.admissionDeferredUntil,
      healthStatus: prior.healthStatus,
      lastErrorCode: prior.lastErrorCode,
    };
  const disabled = prior?.status === 'disabled';
  return {
    status: disabled ? 'disabled' : 'enabled',
    anchorAt: observedAt,
    nextFireAt: resolveScheduleObservation(recurrence, observedAt, observedAt)
      .nextAt,
    lastFireAt: null,
    admissionDeferredUntil: null,
    healthStatus: disabled ? 'disabled' : 'healthy',
    lastErrorCode: null,
  };
}

async function applyResourceDispositions(
  client: PoolClient,
  { workspaceId, workflowId, versionId }: ReconciliationScope,
): Promise<void> {
  const db = drizzle(client);
  const trigger = alias(workflowTriggers, 'trigger');
  const scheduleWithStatus = (status: 'enabled' | 'disabled') =>
    db
      .select({ one: sql`1` })
      .from(schedules)
      .where(
        and(eq(schedules.triggerId, trigger.id), eq(schedules.status, status)),
      );
  const endpointWithStatus = (status: 'active' | 'disabled') =>
    db
      .select({ one: sql`1` })
      .from(endpoints)
      .where(
        and(
          eq(endpoints.workspaceId, trigger.workspaceId),
          eq(endpoints.workflowId, trigger.workflowId),
          eq(endpoints.nodeId, trigger.nodeId),
          eq(endpoints.status, status),
        ),
      );
  const dispositions = db.$with('resource_dispositions').as(
    db
      .select({
        workspaceId: trigger.workspaceId,
        id: trigger.id,
        disposition: sql<WorkflowTriggerStatus>`case
      when ${trigger.kind}='schedule' and ${exists(scheduleWithStatus('enabled'))} then 'active'
      when ${trigger.kind}='webhook' and ${exists(endpointWithStatus('active'))} then 'active'
      when ${exists(scheduleWithStatus('disabled'))} or (${trigger.kind}='webhook' and ${exists(endpointWithStatus('disabled'))}) then 'disabled'
      else 'configuration_required' end`.as('disposition'),
      })
      .from(trigger)
      .where(
        and(
          eq(trigger.workspaceId, workspaceId),
          eq(trigger.workflowId, workflowId),
          eq(trigger.workflowVersionId, versionId),
        ),
      ),
  );
  await db
    .with(dispositions)
    .update(workflowTriggers)
    .set({
      status: sql`${dispositions.disposition}`,
      healthStatus: sql`case ${dispositions.disposition} when 'active' then 'healthy' when 'disabled' then 'disabled' else 'pending' end`,
      lastErrorCode: null,
      reconciledAt: sql`clock_timestamp()`,
      updatedAt: sql`clock_timestamp()`,
    })
    .from(dispositions)
    .where(
      and(
        eq(workflowTriggers.workspaceId, dispositions.workspaceId),
        eq(workflowTriggers.id, dispositions.id),
      ),
    )
    .catch(rethrowQueryFailure);
}
