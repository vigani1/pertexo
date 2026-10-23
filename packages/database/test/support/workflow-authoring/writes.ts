import type { WritePoint } from './write-points.js';

/** The writes a publication makes, in order, for one workflow. */
export function publicationWrite(
  step:
    | 'version'
    | 'integration_usage'
    | 'trigger_projection'
    | 'pointer'
    | 'outbox'
    | 'audit'
    | 'idempotency',
  workflow: string,
): WritePoint {
  switch (step) {
    case 'version':
      return {
        table: 'workflow_versions',
        operation: 'insert',
        when: `NEW.workflow_id = '${workflow}'`,
      };
    case 'integration_usage':
      return { table: 'workflow_integration_usage', operation: 'insert' };
    case 'trigger_projection':
      return {
        table: 'workflow_triggers',
        operation: 'insert or update',
        when: `NEW.workflow_id = '${workflow}'`,
      };
    case 'pointer':
      return {
        table: 'workflows',
        operation: 'update',
        when: `NEW.id = '${workflow}' and NEW.published_version_id is distinct from OLD.published_version_id`,
      };
    case 'outbox':
      return {
        table: 'outbox_events',
        operation: 'insert',
        when: `NEW.aggregate_id = '${workflow}'`,
      };
    case 'audit':
      return {
        table: 'audit_events',
        operation: 'insert',
        when: `NEW.target_id = '${workflow}' and NEW.action = 'workflow.published'`,
      };
    case 'idempotency':
      return {
        table: 'idempotency_records',
        operation: 'update',
        when: `NEW.resource_id = '${workflow}' and NEW.status = 'completed'`,
      };
  }
}

/** The writes an archive makes, in order, for one workflow. */
export function archiveWrite(
  step: 'claim' | 'workflow' | 'outbox' | 'audit' | 'idempotency',
  workflow: string,
): WritePoint {
  const claim = `NEW.resource_id = '${workflow}' and NEW.operation = 'workflow.archive'`;
  switch (step) {
    case 'claim':
      return { table: 'idempotency_records', operation: 'insert', when: claim };
    case 'workflow':
      return {
        table: 'workflows',
        operation: 'update',
        when: `NEW.id = '${workflow}' and NEW.lifecycle_status is distinct from OLD.lifecycle_status`,
      };
    case 'outbox':
      return {
        table: 'outbox_events',
        operation: 'insert',
        when: `NEW.aggregate_id = '${workflow}'`,
      };
    case 'audit':
      return {
        table: 'audit_events',
        operation: 'insert',
        when: `NEW.target_id = '${workflow}' and NEW.action = 'workflow.archived'`,
      };
    case 'idempotency':
      return {
        table: 'idempotency_records',
        operation: 'update',
        when: `${claim} and NEW.status = 'completed'`,
      };
  }
}

/** The writes a rename makes, in order, for one workflow. */
export function renameWrite(
  step: 'claim' | 'workflow' | 'audit' | 'idempotency',
  workflow: string,
): WritePoint {
  const claim = `NEW.resource_id = '${workflow}' and NEW.operation = 'workflow.rename'`;
  switch (step) {
    case 'claim':
      return { table: 'idempotency_records', operation: 'insert', when: claim };
    case 'workflow':
      return {
        table: 'workflows',
        operation: 'update',
        when: `NEW.id = '${workflow}' and NEW.name is distinct from OLD.name`,
      };
    case 'audit':
      return {
        table: 'audit_events',
        operation: 'insert',
        when: `NEW.target_id = '${workflow}' and NEW.action = 'workflow.renamed'`,
      };
    case 'idempotency':
      return {
        table: 'idempotency_records',
        operation: 'update',
        when: `${claim} and NEW.status = 'completed'`,
      };
  }
}

/** A workflow's draft save, the write a save or version restore makes. */
export function draftWrite(workflow: string): WritePoint {
  return {
    table: 'workflow_drafts',
    operation: 'update',
    when: `NEW.workflow_id = '${workflow}'`,
  };
}

/** The writes a duplication makes, in order; one copy runs at a time. */
export function duplicateWrite(
  step: 'claim' | 'workflow' | 'draft' | 'audit' | 'idempotency',
  copyName: string,
): WritePoint {
  const claim = `NEW.operation = 'workflow.duplicate'`;
  switch (step) {
    case 'claim':
      return { table: 'idempotency_records', operation: 'insert', when: claim };
    case 'workflow':
      return {
        table: 'workflows',
        operation: 'insert',
        when: `NEW.name = '${copyName.replaceAll("'", "''")}'`,
      };
    case 'draft':
      return { table: 'workflow_drafts', operation: 'insert' };
    case 'audit':
      return {
        table: 'audit_events',
        operation: 'insert',
        when: `NEW.action = 'workflow.duplicated'`,
      };
    case 'idempotency':
      return {
        table: 'idempotency_records',
        operation: 'update',
        when: `${claim} and NEW.status = 'completed'`,
      };
  }
}

/** The writes an import makes, in order; one import runs at a time. */
export function importWrite(
  step: 'claim' | 'workflow' | 'draft' | 'audit' | 'idempotency',
  name: string,
): WritePoint {
  const claim = `NEW.operation = 'workflow.import'`;
  switch (step) {
    case 'claim':
      return { table: 'idempotency_records', operation: 'insert', when: claim };
    case 'workflow':
      return {
        table: 'workflows',
        operation: 'insert',
        when: `NEW.name = '${name.replaceAll("'", "''")}'`,
      };
    case 'draft':
      return { table: 'workflow_drafts', operation: 'insert' };
    case 'audit':
      return {
        table: 'audit_events',
        operation: 'insert',
        when: `NEW.action = 'workflow.imported'`,
      };
    case 'idempotency':
      return {
        table: 'idempotency_records',
        operation: 'update',
        when: `${claim} and NEW.status = 'completed'`,
      };
  }
}
