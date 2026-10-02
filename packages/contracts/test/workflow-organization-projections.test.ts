import { describe, expect, it } from 'vitest';
import {
  workflowCombinedOrganizationProjectionResponseSchema,
  workflowListQuerySchema,
  workflowListResponseSchema,
  workflowOrganizationListQuerySchema,
  workflowOrganizationListResponseSchema,
  workflowOrganizationProjectionQuerySchema,
  workflowOrganizationProjectionResponseSchema,
  workflowSummaryResponseSchema,
  workflowTemplateOriginProjectionQuerySchema,
} from '../src/http/workflow-authoring.js';

const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const workflow = {
  id,
  workspaceId: id,
  name: 'Literal %_\\ workflow',
  nameRevision: 1,
  lifecycleStatus: 'active',
  lifecycleRevision: 1,
  activationStatus: 'inactive',
  publishedVersionId: null,
  createdAt: '2026-10-02T00:00:00.000Z',
  updatedAt: '2026-10-02T00:00:00.000Z',
};
const organization = {
  tags: [],
  organizationRevision: 1,
  folderId: null,
  isFavorite: false,
  favoriteRevision: `absent.v1.1790930096.1791016496.${'A'.repeat(43)}`,
};

describe('additive organization projection contracts', () => {
  it('keeps the default query and response paths unchanged and strict', () => {
    expect(workflowListQuerySchema.parse({ limit: '5' })).toEqual({ limit: 5 });
    expect(workflowSummaryResponseSchema.parse({ workflow })).toEqual({
      workflow,
    });
    expect(
      workflowListResponseSchema.parse({ items: [workflow], nextCursor: null }),
    ).toEqual({ items: [workflow], nextCursor: null });
    for (const extension of [
      { query: 'Ops' },
      { view: 'active' },
      { tagId: id },
      { favoritesOnly: 'true' },
      { include: 'organization' },
    ])
      expect(workflowListQuerySchema.safeParse(extension).success).toBe(false);
    expect(
      workflowSummaryResponseSchema.safeParse({ workflow, organization })
        .success,
    ).toBe(false);
    expect(
      workflowListResponseSchema.safeParse({
        items: [{ workflow, organization }],
        nextCursor: null,
      }).success,
    ).toBe(false);
  });

  it('normalizes bounded canonical filters without changing case or literals', () => {
    expect(
      workflowOrganizationListQuerySchema.parse({
        query: '  Ops %_\\  ',
        tagId: id.toUpperCase(),
        favoritesOnly: 'true',
        view: 'archived',
        include: 'organization',
        limit: '10',
        order: 'updated_desc',
      }),
    ).toEqual({
      query: 'Ops %_\\',
      tagId: id,
      favoritesOnly: 'true',
      view: 'archived',
      include: 'organization',
      limit: 10,
      order: 'updated_desc',
    });
    expect(workflowOrganizationListQuerySchema.parse({ query: '   ' })).toEqual(
      {},
    );
    expect(
      workflowOrganizationListQuerySchema.parse({ query: '  x \n' }).query,
    ).toBe('x \n');
    expect(
      workflowOrganizationListQuerySchema.parse({ query: 'é'.repeat(64) })
        .query,
    ).toBe('é'.repeat(64));
    for (const invalid of [
      { query: 'é'.repeat(65) },
      { query: null },
      { view: 'deleted' },
      { favoritesOnly: false },
      { favoritesOnly: 'false' },
      { include: 'templateOrigin' },
      { userId: id },
      { folderId: 'ROOT' },
      { unknown: true },
    ])
      expect(
        workflowOrganizationListQuerySchema.safeParse(invalid).success,
      ).toBe(false);
  });

  it('uses exact include grammar rather than a general field-name list', () => {
    for (const include of ['organization', 'templateOrigin,organization'])
      expect(
        workflowOrganizationProjectionQuerySchema.parse({ include }),
      ).toEqual({ include });
    expect(
      workflowTemplateOriginProjectionQuerySchema.parse({
        include: 'templateOrigin',
      }),
    ).toEqual({ include: 'templateOrigin' });
    for (const include of [
      'organization,templateOrigin',
      'organization,organization',
      ' organization',
      'organization ',
      'templateOrigin',
      '',
      null,
    ])
      expect(
        workflowOrganizationProjectionQuerySchema.safeParse({ include })
          .success,
      ).toBe(false);
  });

  it('requires authoritative organization evidence without fabricated defaults', () => {
    const item = { workflow, organization };
    expect(workflowOrganizationProjectionResponseSchema.parse(item)).toEqual(
      item,
    );
    expect(
      workflowCombinedOrganizationProjectionResponseSchema.parse({
        ...item,
        templateOrigin: null,
      }),
    ).toEqual({ ...item, templateOrigin: null });
    expect(
      workflowOrganizationListResponseSchema.parse({
        items: [item],
        nextCursor: null,
      }),
    ).toEqual({ items: [item], nextCursor: null });
    for (const value of [
      { workflow },
      { workflow, organization: null },
      { ...item, templateOrigin: null },
      { ...item, actorId: id },
    ])
      expect(
        workflowOrganizationProjectionResponseSchema.safeParse(value).success,
      ).toBe(false);
    expect(
      workflowCombinedOrganizationProjectionResponseSchema.safeParse(item)
        .success,
    ).toBe(false);
    expect(
      workflowOrganizationListResponseSchema.safeParse({
        items: Array.from({ length: 101 }, () => item),
        nextCursor: null,
      }).success,
    ).toBe(false);
  });
});
