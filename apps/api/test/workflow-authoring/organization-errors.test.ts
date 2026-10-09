import {
  WorkflowFolderConflictError,
  IdempotencyConflictError,
  WorkflowNotFoundError,
  WorkflowOrganizationUnavailableError,
  WorkflowOrganizationValidationError,
  WorkflowTagConflictError,
  type WorkflowFolderConflictKind,
  type WorkflowTagConflictKind,
} from '@pertexo/database/api';
import { describe, expect, it } from 'vitest';

import { APPLICATION_ERROR_CATALOG } from '../../src/platform/http/application-error.js';
import { mapWorkflowOrganizationError } from '../../src/workflow-authoring/organization-errors.js';
import { mapWorkflowAuthoringError } from '../../src/workflow-authoring/errors.js';
import { AuthorizationError } from '../../src/workspaces/index.js';

const cases = [
  [
    new WorkflowOrganizationUnavailableError(),
    'workflow.organization_unavailable',
    503,
  ],
  [new WorkflowOrganizationValidationError(), 'request.invalid', 400],
  [new WorkflowTagConflictError('key'), 'workflow.tag_key_conflict', 409],
  [new WorkflowTagConflictError('limit'), 'workflow.tag_limit_exceeded', 409],
  [
    new WorkflowTagConflictError('tag_revision'),
    'workflow.tag_revision_conflict',
    409,
  ],
  [
    new WorkflowTagConflictError('delete_overflow'),
    'workflow.tag_delete_overflow',
    409,
  ],
  [
    new WorkflowTagConflictError('organization_revision'),
    'workflow.organization_revision_conflict',
    409,
  ],
  [
    new WorkflowTagConflictError('lifecycle'),
    'workflow.lifecycle_conflict',
    409,
  ],
  [
    new WorkflowFolderConflictError('name'),
    'workflow.folder_name_conflict',
    409,
  ],
  [
    new WorkflowFolderConflictError('limit'),
    'workflow.folder_limit_exceeded',
    409,
  ],
  [
    new WorkflowFolderConflictError('revision'),
    'workflow.folder_revision_conflict',
    409,
  ],
  [
    new WorkflowFolderConflictError('hierarchy'),
    'workflow.folder_hierarchy_conflict',
    409,
  ],
  [
    new WorkflowFolderConflictError('not_empty'),
    'workflow.folder_not_empty',
    409,
  ],
  [
    new WorkflowFolderConflictError('not_visible'),
    'workflow.folder_not_visible',
    409,
  ],
] as const;

describe('workflow organization error mapping', () => {
  it.each(cases)('maps %s to %s with status %i', (error, code, status) => {
    const mapped = mapWorkflowOrganizationError(error);
    expect(mapped?.code).toBe(code);
    expect(typeof mapped?.safeDetail).toBe('string');
    expect(mapped?.safeDetail?.length).toBeGreaterThan(0);
    expect(APPLICATION_ERROR_CATALOG[code].status).toBe(status);
    expect(Object.isFrozen(mapped)).toBe(true);
    expect(mapWorkflowAuthoringError(error)).toEqual(mapped);
  });

  it.each(cases)('does not disclose private properties of %s', (error) => {
    const expected = mapWorkflowOrganizationError(error);
    Object.assign(error, {
      message: 'private-actor-generation-token-input',
      actorId: 'private-actor',
      generation: 'private-generation',
      token: 'private-token',
      currentRevision: 99,
      currentFolderRevision: 99,
      currentOrganizationRevision: 99,
      body: { name: 'private-folder', parentId: 'private-parent' },
      cause: new Error('private-cause'),
    });
    const mapped = mapWorkflowOrganizationError(error);
    expect(mapped).toEqual(expected);
    expect(Object.keys(mapped ?? {})).toEqual(
      error instanceof WorkflowTagConflictError && error.kind === 'lifecycle'
        ? ['code', 'safeDetail', 'details']
        : ['code', 'safeDetail'],
    );
    expect(JSON.stringify(mapped)).not.toContain('private');
    expect(mapWorkflowAuthoringError(error)).toEqual(mapped);
  });

  it.each([
    new WorkflowNotFoundError(),
    new IdempotencyConflictError(),
    new AuthorizationError('resource.not_found', 'not authorized'),
    new Error('unrelated failure'),
    { name: 'WorkflowOrganizationUnavailableError' },
    { code: 'workflow.organization_revision_conflict' },
    { name: 'WorkflowFolderConflictError', kind: 'name' },
    null,
    undefined,
    'unrelated failure',
  ])('leaves unrelated failures to the existing mapper: %s', (error) => {
    expect(mapWorkflowOrganizationError(error)).toBeUndefined();
  });

  it('does not read unrelated error properties', () => {
    const error = Object.defineProperty({}, 'message', {
      get: () => {
        throw new Error('must not read private input');
      },
    });
    expect(mapWorkflowOrganizationError(error)).toBeUndefined();
  });

  it('does not mutate conflict instances', () => {
    const kinds: readonly WorkflowTagConflictKind[] = [
      'key',
      'limit',
      'tag_revision',
      'delete_overflow',
      'organization_revision',
      'lifecycle',
    ];
    for (const kind of kinds) {
      const error = Object.freeze(new WorkflowTagConflictError(kind));
      const descriptors = Object.getOwnPropertyDescriptors(error);
      expect(mapWorkflowOrganizationError(error)).toBeDefined();
      expect(Object.getOwnPropertyDescriptors(error)).toEqual(descriptors);
    }
  });

  it.each(['unknown', '__proto__', 'constructor', 'toString'])(
    'fails closed on an unknown folder conflict kind: %s',
    (kind) => {
      const error = Object.assign(new WorkflowFolderConflictError('name'), {
        kind,
      });
      expect(mapWorkflowOrganizationError(error)).toBeUndefined();
    },
  );

  it('does not mutate frozen folder conflict instances', () => {
    const kinds: readonly WorkflowFolderConflictKind[] = [
      'name',
      'limit',
      'revision',
      'hierarchy',
      'not_empty',
      'not_visible',
    ];
    for (const kind of kinds) {
      const error = Object.freeze(new WorkflowFolderConflictError(kind));
      const descriptors = Object.getOwnPropertyDescriptors(error);
      expect(mapWorkflowOrganizationError(error)).toBeDefined();
      expect(Object.getOwnPropertyDescriptors(error)).toEqual(descriptors);
    }
  });
});
