import { describe, expect, it } from 'vitest';
import * as organization from '../src/http/workflow-organization.js';
import { workflowGetQuerySchema } from '../src/http/workflow-authoring.js';

const id = (number: number) =>
  `${number.toString(16).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
const tag = { id: id(1), key: 'ops', revision: 1 };
const cursor = `${'A'.repeat(468)}.${'A'.repeat(43)}`;

describe('strict organization endpoint transport schemas', () => {
  it('normalizes scoped UUID parameters without accepting extra selectors', () => {
    expect(
      organization.workflowTagParamsSchema.parse({
        workspaceId: id(1).toUpperCase(),
        tagId: id(2).toUpperCase(),
      }),
    ).toEqual({ workspaceId: id(1), tagId: id(2) });
    for (const params of [
      { workspaceId: id(1), actorId: id(2) },
      { workspaceId: null },
      { workspaceId: 'invalid' },
    ])
      expect(
        organization.workflowTagWorkspaceParamsSchema.safeParse(params).success,
      ).toBe(false);
    expect(
      organization.workflowTagParamsSchema.safeParse({ workspaceId: id(1) })
        .success,
    ).toBe(false);
  });

  it('bounds ascending-UUID page queries and refuses duplicate query values/order/selectors', () => {
    expect(
      organization.workflowTagAssignmentsQuerySchema.parse({ limit: '1' }),
    ).toEqual(organization.workflowTagListQuerySchema.parse({ limit: '1' }));
    expect(organization.workflowTagListQuerySchema.parse({})).toEqual({});
    for (const limit of [1, 100, '1', '100'])
      expect(
        organization.workflowTagListQuerySchema.parse({ limit, after: cursor }),
      ).toEqual({ limit: Number(limit), after: cursor });
    for (const limit of [
      0,
      101,
      1.5,
      null,
      false,
      [],
      ['1'],
      ['1', '2'],
      '01',
      ' 1 ',
      '1\n',
      '1e0',
    ])
      expect(
        organization.workflowTagListQuerySchema.safeParse({ limit }).success,
      ).toBe(false);
    for (const query of [
      { after: '' },
      { after: `${cursor}A` },
      { after: `${cursor}\n` },
      { after: 'é' },
      { after: null },
      { after: [cursor] },
      { order: 'uuid_asc' },
      { actorId: id(1) },
      { total: true },
      { include: 'organization' },
    ])
      expect(
        organization.workflowTagListQuerySchema.safeParse(query).success,
      ).toBe(false);
  });

  it('requires bounded canonical ascending UUID pages with no count or hidden metadata', () => {
    const schemas = [
      organization.workflowTagListResponseSchema,
      organization.workflowTagAssignmentsResponseSchema,
    ];
    for (const schema of schemas) {
      expect(schema.parse({ items: [], nextCursor: null })).toEqual({
        items: [],
        nextCursor: null,
      });
      expect(
        schema.safeParse({ items: [], nextCursor: null, total: 0 }).success,
      ).toBe(false);
      expect(
        schema.safeParse({ items: [], nextCursor: null, actorId: id(1) })
          .success,
      ).toBe(false);
    }
    const tags = Array.from({ length: 100 }, (_, index) => ({
      ...tag,
      id: id(index + 1),
    }));
    const assignments = tags.map((item) => ({
      workflowId: item.id,
      organizationRevision: 1,
    }));
    expect(
      organization.workflowTagListResponseSchema.parse({
        items: [tag],
        nextCursor: null,
      }).items,
    ).toEqual([tag]);
    expect(
      organization.workflowTagAssignmentsResponseSchema.parse({
        items: [assignments[0]],
        nextCursor: null,
      }).items,
    ).toEqual([assignments[0]]);
    expect(
      organization.workflowTagListResponseSchema.parse({
        items: tags,
        nextCursor: cursor,
      }).items,
    ).toHaveLength(100);
    expect(
      organization.workflowTagAssignmentsResponseSchema.parse({
        items: assignments,
        nextCursor: cursor,
      }).items,
    ).toHaveLength(100);
    for (const items of [
      new Array<unknown>(1),
      [undefined, tag],
      [{ ...tag, id: '' }],
      [tags[1], tags[0]],
      [tags[0], tags[0]],
      [...tags, { ...tag, id: id(101) }],
      [{ ...tag, id: tag.id.toUpperCase() }],
      [{ ...tag, assignmentCount: 2 }],
    ])
      expect(
        organization.workflowTagListResponseSchema.safeParse({
          items,
          nextCursor: null,
        }).success,
      ).toBe(false);
    for (const items of [
      new Array<unknown>(1),
      [undefined, assignments[0]],
      [{ workflowId: '', organizationRevision: 1 }],
      [assignments[1], assignments[0]],
      [assignments[0], assignments[0]],
      [...assignments, { workflowId: id(101), organizationRevision: 1 }],
      [
        {
          workflowId: id(1),
          organizationRevision: 1,
          name: 'Private workflow',
        },
      ],
    ])
      expect(
        organization.workflowTagAssignmentsResponseSchema.safeParse({
          items,
          nextCursor: null,
        }).success,
      ).toBe(false);
  });

  it('matches the SQL command receipt shapes without treating historical replies as projections', () => {
    const commands = [
      {
        schema: organization.workflowTagCreateResponseSchema,
        body: { tag, replayed: false },
      },
      {
        schema: organization.workflowTagRenameResponseSchema,
        body: { tag, replayed: true },
      },
      {
        schema: organization.workflowTagDeleteResponseSchema,
        body: {
          tagId: id(1),
          deleted: true,
          detachedWorkflowCount: 50,
          replayed: true,
        },
      },
      {
        schema: organization.workflowTagReplaceResponseSchema,
        body: {
          workflowId: id(1),
          organizationRevision: 2,
          tagIds: [id(2)],
          replayed: false,
        },
      },
    ];
    for (const { schema, body } of commands) {
      expect(schema.parse(body)).toEqual(body);
      for (const extra of [
        { actorId: id(1) },
        { generation: id(1) },
        { proof: true },
        { workflow: {} },
        { updatedAt: '2026-10-02T00:00:00Z' },
      ])
        expect(schema.safeParse({ ...body, ...extra }).success).toBe(false);
      expect(schema.safeParse({ ...body, replayed: null }).success).toBe(false);
    }
    for (const detachedWorkflowCount of [-1, 51, 0.5, '0'])
      expect(
        organization.workflowTagDeleteResponseSchema.safeParse({
          tagId: id(1),
          deleted: true,
          detachedWorkflowCount,
          replayed: false,
        }).success,
      ).toBe(false);
    expect(
      organization.workflowTagDeleteResponseSchema.safeParse({
        tagId: id(1),
        deleted: false,
        detachedWorkflowCount: 0,
        replayed: false,
      }).success,
    ).toBe(false);
    for (const tagIds of [
      [id(1), id(1)],
      [id(1).toUpperCase()],
      Array.from({ length: 17 }, (_, index) => id(index + 1)),
    ])
      expect(
        organization.workflowTagReplaceResponseSchema.safeParse({
          workflowId: id(1),
          organizationRevision: 2,
          tagIds,
          replayed: false,
        }).success,
      ).toBe(false);
  });

  it('preserves requested cleanup order with exact bounded outcome fields and known problem codes', () => {
    const items = [
      {
        workflowId: id(7),
        status: 'detached',
        organizationRevision: 2,
        replayed: true,
      },
      { workflowId: id(6), status: 'not_visible' },
      {
        workflowId: id(5),
        status: 'conflict',
        code: 'workflow.organization_revision_conflict',
      },
      {
        workflowId: id(4),
        status: 'unavailable',
        code: 'workflow.organization_unavailable',
      },
      { workflowId: id(3), status: 'outcome_unknown' },
      { workflowId: id(2), status: 'forbidden' },
      { workflowId: id(1), status: 'not_processed' },
    ];
    expect(
      organization.workflowTagCleanupDetachResponseSchema.parse({ items }),
    ).toEqual({ items });
    for (const item of items) {
      for (const extension of [
        { actorId: id(1) },
        { generation: id(1) },
        { proof: 'signed' },
        { detachedCount: 1 },
        { detail: 'private evidence' },
      ])
        expect(
          organization.workflowTagCleanupItemOutcomeSchema.safeParse({
            ...item,
            ...extension,
          }).success,
        ).toBe(false);
      if (item.status !== 'detached')
        expect(
          organization.workflowTagCleanupItemOutcomeSchema.safeParse({
            ...item,
            organizationRevision: 9,
            replayed: true,
          }).success,
        ).toBe(false);
    }
    for (const code of [
      'workflow.organization_revision_conflict',
      'request.idempotency_conflict',
      'workflow.lifecycle_conflict',
    ])
      expect(
        organization.workflowTagCleanupItemOutcomeSchema.parse({
          workflowId: id(1),
          status: 'conflict',
          code,
        }),
      ).toEqual({ workflowId: id(1), status: 'conflict', code });
    for (const code of [
      'workflow.tag_revision_conflict',
      'internal.unexpected',
      'auth.forbidden',
      'workflow.organization_unavailable',
    ])
      expect(
        organization.workflowTagCleanupItemOutcomeSchema.safeParse({
          workflowId: id(1),
          status: 'conflict',
          code,
        }).success,
      ).toBe(false);
    expect(
      organization.workflowTagCleanupItemOutcomeSchema.safeParse({
        workflowId: id(1),
        status: 'unavailable',
        code: 'provider.unavailable',
      }).success,
    ).toBe(false);
  });

  it('bounds cleanup results and stops after current authority loss without retained metadata', () => {
    const detached = (number: number) => ({
      workflowId: id(number),
      status: 'detached',
      organizationRevision: 2,
      replayed: false,
    });
    for (const count of [1, 50])
      expect(
        organization.workflowTagCleanupDetachResponseSchema.safeParse({
          items: Array.from({ length: count }, (_, index) =>
            detached(index + 1),
          ),
        }).success,
      ).toBe(true);
    for (const items of [
      [],
      Array.from({ length: 51 }, (_, index) => detached(index + 1)),
      [detached(1), detached(1)],
      [{ workflowId: id(1), status: 'not_processed' }],
      [{ workflowId: id(1), status: 'forbidden' }, detached(2)],
      [
        { workflowId: id(1), status: 'forbidden' },
        { workflowId: id(2), status: 'outcome_unknown' },
      ],
      [
        { workflowId: id(1), status: 'forbidden' },
        { workflowId: id(2), status: 'forbidden' },
      ],
    ])
      expect(
        organization.workflowTagCleanupDetachResponseSchema.safeParse({ items })
          .success,
      ).toBe(false);
    expect(
      organization.workflowTagCleanupDetachResponseSchema.safeParse({
        items: [detached(1)],
        replayed: true,
      }).success,
    ).toBe(false);
  });

  it('exposes only the canonical combined include grammar while accepting unchanged default GET', () => {
    expect(workflowGetQuerySchema.parse({})).toEqual({});
    for (const include of [
      'templateOrigin',
      'organization',
      'templateOrigin,organization',
    ])
      expect(workflowGetQuerySchema.parse({ include })).toEqual({ include });
    for (const include of [
      'organization,templateOrigin',
      'templateOrigin, organization',
      'organization,organization',
      'templateOrigin\n',
      '',
      null,
      ['organization'],
    ])
      expect(workflowGetQuerySchema.safeParse({ include }).success).toBe(false);
    expect(
      workflowGetQuerySchema.safeParse({
        include: 'organization',
        actorId: id(1),
      }).success,
    ).toBe(false);
  });
});
