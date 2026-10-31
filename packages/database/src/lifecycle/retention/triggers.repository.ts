import {
  webhookTriggerReplayRecords,
  webhookTriggerDeliveries,
} from '../../schema/triggers/deliveries.js';
import {
  triggerCoordinatedEvents,
  triggerEventWindows,
} from '../../schema/event-coordination/records.js';
import { triggerScheduleOccurrences } from '../../schema/triggers/schedules.js';
import { and, eq, lte, ne, notExists, sql } from 'drizzle-orm';
import { QueryBuilder } from 'drizzle-orm/pg-core';
import { deletionRule } from './rows.repository.js';

const query = new QueryBuilder();
// Webhook replay records keep their own expiry.
export const webhookReplays = deletionRule('webhook_replay_records', {
  table: webhookTriggerReplayRecords,
  keys: [
    webhookTriggerReplayRecords.endpointId,
    webhookTriggerReplayRecords.dedupeKeyHash,
  ],
  condition: lte(webhookTriggerReplayRecords.expiresAt, sql`clock_timestamp()`),
  orderBy: [
    webhookTriggerReplayRecords.expiresAt,
    webhookTriggerReplayRecords.endpointId,
  ],
});
export const webhookDeliveries = deletionRule('webhook_deliveries', {
  table: webhookTriggerDeliveries,
  keys: [webhookTriggerDeliveries.id],
  condition: and(
    lte(webhookTriggerDeliveries.expiresAt, sql`clock_timestamp()`),
    notExists(
      query
        .select({ one: sql`1` })
        .from(webhookTriggerReplayRecords)
        .where(
          and(
            eq(
              webhookTriggerReplayRecords.workspaceId,
              webhookTriggerDeliveries.workspaceId,
            ),
            eq(
              webhookTriggerReplayRecords.deliveryId,
              webhookTriggerDeliveries.id,
            ),
          ),
        ),
    ),
  ),
  orderBy: [webhookTriggerDeliveries.expiresAt, webhookTriggerDeliveries.id],
});
const eventExpired = and(
  ne(triggerCoordinatedEvents.status, 'pending'),
  lte(triggerCoordinatedEvents.expiresAt, sql`clock_timestamp()`),
);
export const coordinatedEvents = deletionRule('coordinated_events', {
  table: triggerCoordinatedEvents,
  keys: [triggerCoordinatedEvents.id],
  condition: and(
    eventExpired,
    notExists(
      query
        .select({ one: sql`1` })
        .from(webhookTriggerDeliveries)
        .where(
          and(
            eq(
              webhookTriggerDeliveries.workspaceId,
              triggerCoordinatedEvents.workspaceId,
            ),
            eq(
              webhookTriggerDeliveries.coordinationEventId,
              triggerCoordinatedEvents.id,
            ),
          ),
        ),
    ),
    notExists(
      query
        .select({ one: sql`1` })
        .from(webhookTriggerReplayRecords)
        .where(
          and(
            eq(
              webhookTriggerReplayRecords.workspaceId,
              triggerCoordinatedEvents.workspaceId,
            ),
            eq(
              webhookTriggerReplayRecords.coordinationEventId,
              triggerCoordinatedEvents.id,
            ),
          ),
        ),
    ),
  ),
  orderBy: [triggerCoordinatedEvents.expiresAt, triggerCoordinatedEvents.id],
  recheck: eventExpired,
});
const unusedWindow = and(
  lte(triggerEventWindows.expiresAt, sql`clock_timestamp()`),
  notExists(
    query
      .select({ one: sql`1` })
      .from(triggerCoordinatedEvents)
      .where(
        and(
          eq(
            triggerCoordinatedEvents.workspaceId,
            triggerEventWindows.workspaceId,
          ),
          eq(triggerCoordinatedEvents.keyId, triggerEventWindows.id),
        ),
      ),
  ),
);
export const eventWindows = deletionRule('event_windows', {
  table: triggerEventWindows,
  keys: [triggerEventWindows.id],
  condition: unusedWindow,
  orderBy: [triggerEventWindows.expiresAt, triggerEventWindows.id],
  recheck: unusedWindow,
});
export const scheduleOccurrences = deletionRule('schedule_occurrences', {
  table: triggerScheduleOccurrences,
  keys: [triggerScheduleOccurrences.id],
  condition: sql`${triggerScheduleOccurrences.scheduledAt}<=clock_timestamp()-interval '90 days'`,
  orderBy: [
    triggerScheduleOccurrences.scheduledAt,
    triggerScheduleOccurrences.id,
  ],
});
