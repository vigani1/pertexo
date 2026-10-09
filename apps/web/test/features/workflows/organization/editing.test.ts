import { describe, expect, it } from 'vitest';
import {
  accessibleWorkspaceSchema,
  workflowOrganizationProjectionResponseSchema,
  workflowOrganizationBulkResponseSchema,
} from '@pertexo/contracts';
import {
  validOrganizationSelection,
  organizationEditAttempt,
  organizationOutcomeText,
  canEditOrganization,
} from '@/features/workflows/components/organization/organization-editing';
import {
  workspaceId,
  workflowId,
  secondWorkflowId,
  thirdWorkflowId,
  summary,
  workspaceWith,
} from '../list/fixtures';
const row = (id = workflowId, revision = 3) =>
  workflowOrganizationProjectionResponseSchema.parse({
    workflow: summary(id, 'Workflow'),
    organization: {
      tags: [],
      folderId: null,
      organizationRevision: revision,
      isFavorite: true,
    },
  });
describe('organization editing presentation model', () => {
  it('requires an explicit bounded distinct selection', () => {
    expect(validOrganizationSelection([])).toBe(false);
    expect(validOrganizationSelection([row(), row()])).toBe(false);
    expect(
      validOrganizationSelection(Array.from({ length: 51 }, () => row())),
    ).toBe(false);
    expect(validOrganizationSelection([row()])).toBe(true);
    expect(() =>
      organizationEditAttempt(workspaceId, [], 'move', null, [], 'key'),
    ).toThrow();
  });
  it('normalizes replacement IDs and freezes the ordered full parent', () => {
    const attempt = organizationEditAttempt(
      workspaceId,
      [row(secondWorkflowId, 8), row(workflowId, 4)],
      'replace_tags',
      null,
      [thirdWorkflowId, secondWorkflowId, secondWorkflowId],
      'parent-key',
    );
    expect(attempt).toEqual({
      kind: 'bulk',
      workspaceId,
      idempotencyKey: 'parent-key',
      body: {
        operation: 'replace_tags',
        tagIds: [secondWorkflowId, thirdWorkflowId],
        items: [
          { workflowId: secondWorkflowId, expectedOrganizationRevision: 8 },
          { workflowId, expectedOrganizationRevision: 4 },
        ],
      },
    });
    expect(Object.isFrozen(attempt)).toBe(true);
    expect(Object.isFrozen(attempt.body)).toBe(true);
  });
  it('rejects oversized replacement sets rather than clipping intent', () => {
    const ids = Array.from(
      { length: 17 },
      (_, index) =>
        `${String(index).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
    );
    expect(() =>
      organizationEditAttempt(
        workspaceId,
        [row()],
        'replace_tags',
        null,
        ids,
        'key',
      ),
    ).toThrow();
  });
  it('does not broaden editing permission from a viewer capability snapshot', () => {
    const workspace = accessibleWorkspaceSchema.parse({
      ...workspaceWith(['workflow:update']),
      role: 'viewer',
    });
    expect(canEditOrganization(workspace, [row()], 'move')).toBe(false);
  });
  it.each(['not_visible', 'outcome_unknown', 'forbidden'] as const)(
    'has distinct safe %s feedback',
    (status) => {
      const response = workflowOrganizationBulkResponseSchema.parse({
        items: [{ workflowId, status }],
      });
      const item = response.items[0];
      if (item === undefined) throw new Error('Missing fixture');
      expect(organizationOutcomeText(item)).toMatch(
        {
          not_visible: /Not visible/,
          outcome_unknown: /Outcome unknown/,
          forbidden: /Access lost/,
        }[status],
      );
    },
  );
});
