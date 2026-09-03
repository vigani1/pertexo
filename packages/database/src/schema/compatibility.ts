import {
  boolean,
  foreignKey,
  integer,
  jsonb,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { appSchema } from './app-schema.js';

export const nodeCompatibilityReleases = appSchema.table(
  'node_compatibility_releases',
  {
    epoch: integer('epoch').primaryKey(),
    schemaVersion: integer('schema_version').notNull(),
    fingerprint: varchar('fingerprint', { length: 128 }).notNull(),
    catalogJson: jsonb('catalog_json').notNull(),
    predecessorEpoch: integer('predecessor_epoch'),
    preparedByKind: varchar('prepared_by_kind', { length: 32 }).notNull(),
    preparedBy: varchar('prepared_by', { length: 128 }).notNull(),
    reason: varchar('reason', { length: 500 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.predecessorEpoch],
      foreignColumns: [table.epoch],
      name: 'node_compatibility_releases_predecessor_fk',
    }),
    uniqueIndex('node_compatibility_releases_epoch_fingerprint_unique').on(
      table.epoch,
      table.fingerprint,
    ),
  ],
);
export const nodeCompatibilityPreactivationChecks = appSchema.table(
  'node_compatibility_preactivation_checks',
  {
    checkId: uuid('check_id').primaryKey(),
    deploymentId: varchar('deployment_id', { length: 128 }).notNull(),
    epoch: integer('epoch').notNull(),
    fingerprint: varchar('fingerprint', { length: 128 }).notNull(),
    roleKind: varchar('role_kind', { length: 16 }).notNull(),
    artifactId: varchar('artifact_id', { length: 128 }).notNull(),
    observedCatalog: jsonb('observed_catalog').notNull(),
    checkedAt: timestamp('checked_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.epoch, table.fingerprint],
      foreignColumns: [
        nodeCompatibilityReleases.epoch,
        nodeCompatibilityReleases.fingerprint,
      ],
      name: 'node_compatibility_preactivation_release_fk',
    }),
    uniqueIndex('node_compatibility_preactivation_unique_artifact').on(
      table.deploymentId,
      table.epoch,
      table.fingerprint,
      table.roleKind,
      table.artifactId,
    ),
  ],
);
export const nodeCompatibilityActivationApprovals = appSchema.table(
  'node_compatibility_activation_approvals',
  {
    approvalId: uuid('approval_id').primaryKey(),
    deploymentId: varchar('deployment_id', { length: 128 }).notNull(),
    epoch: integer('epoch').notNull(),
    fingerprint: varchar('fingerprint', { length: 128 }).notNull(),
    requiredApiArtifacts: jsonb('required_api_artifacts').notNull(),
    requiredWorkerArtifacts: jsonb('required_worker_artifacts').notNull(),
    approvedBy: varchar('approved_by', { length: 128 }).notNull(),
    reason: varchar('reason', { length: 500 }).notNull(),
    approvedAt: timestamp('approved_at', {
      withTimezone: true,
      mode: 'date',
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.epoch, table.fingerprint],
      foreignColumns: [
        nodeCompatibilityReleases.epoch,
        nodeCompatibilityReleases.fingerprint,
      ],
      name: 'node_compatibility_activation_approvals_release_fk',
    }),
    uniqueIndex('node_compatibility_activation_approvals_deployment_unique').on(
      table.deploymentId,
      table.epoch,
      table.fingerprint,
    ),
  ],
);
export const nodeCompatibilityCurrent = appSchema.table(
  'node_compatibility_current',
  {
    singleton: boolean('singleton').default(true).primaryKey(),
    epoch: integer('epoch').notNull(),
    fingerprint: varchar('fingerprint', { length: 128 }).notNull(),
    activatedByKind: varchar('activated_by_kind', { length: 32 }).notNull(),
    activatedBy: varchar('activated_by', { length: 128 }).notNull(),
    activatedAt: timestamp('activated_at', {
      withTimezone: true,
      mode: 'date',
    })
      .defaultNow()
      .notNull(),
    activationApprovalId: uuid('activation_approval_id'),
  },
  (table) => [
    foreignKey({
      columns: [table.epoch, table.fingerprint],
      foreignColumns: [
        nodeCompatibilityReleases.epoch,
        nodeCompatibilityReleases.fingerprint,
      ],
      name: 'node_compatibility_current_release_fk',
    }),
    foreignKey({
      columns: [table.activationApprovalId],
      foreignColumns: [nodeCompatibilityActivationApprovals.approvalId],
      name: 'node_compatibility_current_activation_approval_fk',
    }),
  ],
);
export const nodeCompatibilityActivations = appSchema.table(
  'node_compatibility_activations',
  {
    activationId: uuid('activation_id').primaryKey(),
    approvalId: uuid('approval_id').notNull(),
    predecessorEpoch: integer('predecessor_epoch').notNull(),
    predecessorFingerprint: varchar('predecessor_fingerprint', {
      length: 128,
    }).notNull(),
    epoch: integer('epoch').notNull(),
    fingerprint: varchar('fingerprint', { length: 128 }).notNull(),
    activatedByKind: varchar('activated_by_kind', { length: 32 }).notNull(),
    activatedBy: varchar('activated_by', { length: 128 }).notNull(),
    reason: varchar('reason', { length: 500 }).notNull(),
    activatedAt: timestamp('activated_at', {
      withTimezone: true,
      mode: 'date',
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex('node_compatibility_activations_approval_unique').on(
      table.approvalId,
    ),
    foreignKey({
      columns: [table.approvalId],
      foreignColumns: [nodeCompatibilityActivationApprovals.approvalId],
      name: 'node_compatibility_activations_approval_fk',
    }),
    foreignKey({
      columns: [table.predecessorEpoch, table.predecessorFingerprint],
      foreignColumns: [
        nodeCompatibilityReleases.epoch,
        nodeCompatibilityReleases.fingerprint,
      ],
      name: 'node_compatibility_activations_predecessor_fk',
    }),
    foreignKey({
      columns: [table.epoch, table.fingerprint],
      foreignColumns: [
        nodeCompatibilityReleases.epoch,
        nodeCompatibilityReleases.fingerprint,
      ],
      name: 'node_compatibility_activations_release_fk',
    }),
  ],
);
