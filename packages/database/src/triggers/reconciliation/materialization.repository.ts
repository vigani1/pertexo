import { and, eq, exists, ne, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/node-postgres';
import { workflowTriggers } from '../../schema/authoring/workflows.js';
import { webhookTriggerEndpoints as endpoints } from '../../schema/triggers/endpoints.js';
import { triggerSchedules as schedules } from '../../schema/triggers/schedules.js';
import { rethrowQueryFailure } from '../../platform/query-errors.js';
import type { WorkflowTriggerStatus } from '@pertexo/workflow-model';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import {
  parseScheduleRecurrence,
  resolveScheduleObservation,
  type ScheduleRecurrence,
} from '../schedules/recurrence.js';
import { WorkflowTriggerReconciliationMismatchError } from './errors.js';

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
  await retirePreviousResources(client, scope);
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
  const oldEndpoint = db
    .select({ one: sql`1` })
    .from(workflowTriggers)
    .where(
      and(
        eq(workflowTriggers.workspaceId, endpoints.workspaceId),
        eq(workflowTriggers.id, endpoints.triggerId),
        eq(workflowTriggers.workflowId, workflowId),
        ne(workflowTriggers.workflowVersionId, versionId),
      ),
    );
  await db
    .update(endpoints)
    .set({ status: 'disabled', updatedAt: sql`clock_timestamp()` })
    .where(and(eq(endpoints.workspaceId, workspaceId), exists(oldEndpoint)))
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
      status: 'disabled',
      healthStatus: 'disabled',
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
        ne(schedules.status, 'disabled'),
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
  const desired = desiredScheduleConfig(row.desiredConfig);
  if (row.persistedFingerprint === null) {
    const nextAt = resolveScheduleObservation(
      desired.recurrence,
      observedAt,
      observedAt,
    ).nextAt;
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
          desired.recurrence.kind === 'cron'
            ? desired.recurrence.timezone
            : null,
        intervalMinutes:
          desired.recurrence.kind === 'interval'
            ? desired.recurrence.intervalMinutes
            : null,
        misfirePolicy: desired.misfirePolicy,
        configFingerprint: row.configFingerprint,
        anchorAt: observedAt,
        nextFireAt: nextAt,
      })
      .catch(rethrowQueryFailure);
  } else if (row.persistedFingerprint !== row.configFingerprint) {
    throw new WorkflowTriggerReconciliationMismatchError(
      'Materialized schedule configuration does not match its immutable trigger',
    );
  }
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
          eq(endpoints.triggerId, trigger.id),
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
      when ${exists(endpointWithStatus('active'))} then 'active'
      when ${exists(scheduleWithStatus('disabled'))} or ${exists(endpointWithStatus('disabled'))} then 'disabled'
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
