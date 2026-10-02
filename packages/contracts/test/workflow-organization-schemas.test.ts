import { describe, expect, it } from 'vitest';

import {
  normalizeWorkflowTagKey,
  workflowFavoriteRequestSchema,
  workflowFavoriteResponseSchema,
  workflowFavoriteRevisionSchema,
  workflowOrganizationNameQuerySchema,
  workflowOrganizationRevisionSchema,
  workflowOrganizationSchema,
  workflowOrganizationViewSchema,
  workflowTagCleanupDetachRequestSchema,
  workflowTagCreateRequestSchema,
  workflowTagDeleteRequestSchema,
  workflowTagKeyInputSchema,
  workflowTagKeySchema,
  workflowTagRenameRequestSchema,
  workflowTagReplaceRequestSchema,
  workflowTagRevisionSchema,
  workflowTagSchema,
  WORKFLOW_ORGANIZATION_LIMITS,
} from '../src/http/workflow-organization.js';

const firstId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const secondId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const tag = { id: firstId, key: 'ops', revision: 1 };
const organization = {
  tags: [tag],
  organizationRevision: 1,
  folderId: null,
  isFavorite: false,
  favoriteRevision: 'absent',
};
const identifierAt = (index: number) =>
  `${index.toString(16).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;

describe('ADR064 workflow organization public schemas', () => {
  it('pins the accepted product bounds rather than caller-configurable quotas', () => {
    expect(WORKFLOW_ORGANIZATION_LIMITS).toEqual({
      tagKeyBytes: 32,
      tagsPerWorkflow: 16,
      tagsPerWorkspace: 256,
      cleanupItems: 50,
      nameQueryBytes: 128,
      favoriteRetryHorizonHours: 24,
    });
    expect(Object.isFrozen(WORKFLOW_ORGANIZATION_LIMITS)).toBe(true);
  });

  it.each([
    ['  Ops-2  ', 'ops-2'],
    ['A', 'a'],
    ['0123456789', '0123456789'],
    ['ABC-DEF-123', 'abc-def-123'],
    ['   ' + 'A'.repeat(32) + '   ', 'a'.repeat(32)],
  ])('normalizes only U+0020 and ASCII uppercase: %j', (input, expected) => {
    expect(normalizeWorkflowTagKey(input)).toBe(expected);
    expect(workflowTagKeyInputSchema.parse(input)).toBe(expected);
    expect(workflowTagCreateRequestSchema.parse({ key: input })).toEqual({
      key: expected,
    });
    expect(
      workflowTagRenameRequestSchema.parse({
        key: input,
        expectedTagRevision: 1,
      }),
    ).toEqual({ key: expected, expectedTagRevision: 1 });
  });

  it('does not Unicode-fold or silently transliterate tag inputs', () => {
    expect(normalizeWorkflowTagKey('  Kéİ-OPS  ')).toBe('Kéİ-ops');
    expect(normalizeWorkflowTagKey('\tOPS\t')).toBe('\tops\t');
    for (const input of [
      'équipe',
      'e\u0301quipe',
      'Key',
      'İ',
      'ＯＰＳ',
      'ops–2',
      'ops−2',
      '\u00a0ops\u00a0',
      '\u2003ops\u2003',
    ])
      expect(workflowTagKeyInputSchema.safeParse(input).success, input).toBe(
        false,
      );
  });

  it.each([
    '',
    ' ',
    'ops_2',
    '-ops',
    'ops-',
    'ops--2',
    'op s',
    'ops/2',
    'a'.repeat(33),
    '\tops',
    'ops\t',
    'ops\n',
    'ops\r',
    'ops\r\n',
    '\nops',
    'ops  \n',
    'ops\u2028',
    'ops\u2029',
    'ops\0',
  ])(
    'rejects invalid remaining tag characters and final line terminators: %j',
    (input) => {
      expect(workflowTagKeyInputSchema.safeParse(input).success).toBe(false);
      expect(workflowTagKeySchema.safeParse(input).success).toBe(false);
    },
  );

  it('keeps read keys canonical instead of accepting command normalization', () => {
    expect(workflowTagKeySchema.parse('a'.repeat(32))).toBe('a'.repeat(32));
    for (const key of ['Ops', ' ops ', 'a'.repeat(33)])
      expect(workflowTagSchema.safeParse({ ...tag, key }).success).toBe(false);
    expect(workflowTagCreateRequestSchema.parse({ key: ' OPS ' })).toEqual(
      workflowTagCreateRequestSchema.parse({ key: 'ops' }),
    );
  });

  const commands = [
    {
      name: 'create',
      schema: workflowTagCreateRequestSchema,
      body: { key: 'ops' },
    },
    {
      name: 'rename',
      schema: workflowTagRenameRequestSchema,
      body: { key: 'ops', expectedTagRevision: 1 },
    },
    {
      name: 'delete',
      schema: workflowTagDeleteRequestSchema,
      body: { expectedTagRevision: 1 },
    },
    {
      name: 'replace',
      schema: workflowTagReplaceRequestSchema,
      body: { tagIds: [firstId], expectedOrganizationRevision: 1 },
    },
    {
      name: 'cleanup',
      schema: workflowTagCleanupDetachRequestSchema,
      body: {
        tagId: firstId,
        items: [{ workflowId: secondId, expectedOrganizationRevision: 1 }],
      },
    },
    {
      name: 'favorite',
      schema: workflowFavoriteRequestSchema,
      body: { favorite: true, expectedFavoriteRevision: 'absent' },
    },
  ];
  it.each(commands)(
    'rejects unknown/null members and actor selectors for $name',
    ({ schema, body }) => {
      expect(schema.safeParse(body).success).toBe(true);
      for (const value of [null, undefined, [], 'request'])
        expect(schema.safeParse(value).success).toBe(false);
      for (const field of Object.keys(body)) {
        expect(schema.safeParse({ ...body, [field]: null }).success).toBe(
          false,
        );
        const omitted: Record<string, unknown> = { ...body };
        Reflect.deleteProperty(omitted, field);
        expect(schema.safeParse(omitted).success).toBe(false);
      }
      for (const field of [
        'actorId',
        'userId',
        'memberId',
        'workspaceId',
        'toggle',
        'quota',
        'unknown',
      ])
        expect(schema.safeParse({ ...body, [field]: firstId }).success).toBe(
          false,
        );
    },
  );

  it('uses positive safe revisions independently of opaque favorite tokens', () => {
    expect(workflowTagRevisionSchema).toBe(workflowOrganizationRevisionSchema);
    for (const revision of [1, Number.MAX_SAFE_INTEGER]) {
      expect(workflowOrganizationRevisionSchema.parse(revision)).toBe(revision);
      expect(
        workflowTagDeleteRequestSchema.parse({ expectedTagRevision: revision }),
      ).toEqual({ expectedTagRevision: revision });
    }
    for (const revision of [
      undefined,
      null,
      0,
      -1,
      1.5,
      '1',
      Number.MAX_SAFE_INTEGER + 1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      expect(
        workflowOrganizationRevisionSchema.safeParse(revision).success,
      ).toBe(false);
      expect(
        workflowTagRenameRequestSchema.safeParse({
          key: 'ops',
          expectedTagRevision: revision,
        }).success,
      ).toBe(false);
      expect(
        workflowTagReplaceRequestSchema.safeParse({
          tagIds: [],
          expectedOrganizationRevision: revision,
        }).success,
      ).toBe(false);
    }
    expect(workflowFavoriteRevisionSchema.safeParse(1).success).toBe(false);
  });

  it('normalizes, sorts and bounds a replacement without mutating caller arrays', () => {
    const ids = Object.freeze([secondId.toUpperCase(), firstId.toUpperCase()]);
    const input = Object.freeze({
      tagIds: ids,
      expectedOrganizationRevision: 1,
    });
    expect(workflowTagReplaceRequestSchema.parse(input)).toEqual({
      tagIds: [firstId, secondId],
      expectedOrganizationRevision: 1,
    });
    expect(ids).toEqual([secondId.toUpperCase(), firstId.toUpperCase()]);
    expect(
      workflowTagReplaceRequestSchema.parse({
        tagIds: [],
        expectedOrganizationRevision: 1,
      }).tagIds,
    ).toEqual([]);
    for (const count of [16, 17])
      expect(
        workflowTagReplaceRequestSchema.safeParse({
          tagIds: Array.from({ length: count }, (_, index) =>
            identifierAt(index + 1),
          ),
          expectedOrganizationRevision: 1,
        }).success,
      ).toBe(count === 16);
    for (const tagIds of [
      [firstId, firstId],
      [firstId, firstId.toUpperCase()],
      ['not-a-uuid'],
      [null],
    ])
      expect(
        workflowTagReplaceRequestSchema.safeParse({
          tagIds,
          expectedOrganizationRevision: 1,
        }).success,
      ).toBe(false);
  });

  it('bounds cleanup to unique explicit workflow identities and preserves requested outcome order', () => {
    const items = Object.freeze([
      Object.freeze({
        workflowId: secondId.toUpperCase(),
        expectedOrganizationRevision: 7,
      }),
      Object.freeze({
        workflowId: firstId.toUpperCase(),
        expectedOrganizationRevision: 3,
      }),
    ]);
    expect(
      workflowTagCleanupDetachRequestSchema.parse({
        tagId: firstId.toUpperCase(),
        items,
      }),
    ).toEqual({
      tagId: firstId,
      items: [
        { workflowId: secondId, expectedOrganizationRevision: 7 },
        { workflowId: firstId, expectedOrganizationRevision: 3 },
      ],
    });
    expect(items[0]?.workflowId).toBe(secondId.toUpperCase());
    for (const count of [0, 1, 50, 51])
      expect(
        workflowTagCleanupDetachRequestSchema.safeParse({
          tagId: firstId,
          items: Array.from({ length: count }, (_, index) => ({
            workflowId: identifierAt(index + 1),
            expectedOrganizationRevision: 1,
          })),
        }).success,
      ).toBe(count >= 1 && count <= 50);
    for (const invalidItems of [
      [
        { workflowId: firstId, expectedOrganizationRevision: 1 },
        { workflowId: firstId.toUpperCase(), expectedOrganizationRevision: 2 },
      ],
      [
        {
          workflowId: secondId,
          expectedOrganizationRevision: 1,
          userId: firstId,
        },
      ],
      [{ workflowId: secondId, expectedOrganizationRevision: null }],
      [{ workflowId: null, expectedOrganizationRevision: 1 }],
    ])
      expect(
        workflowTagCleanupDetachRequestSchema.safeParse({
          tagId: firstId,
          items: invalidItems,
        }).success,
      ).toBe(false);
  });

  it('models desired favorites and false-state tombstones without exposing another actor', () => {
    for (const favorite of [true, false])
      for (const expectedFavoriteRevision of ['absent', firstId.toUpperCase()])
        expect(
          workflowFavoriteRequestSchema.parse({
            favorite,
            expectedFavoriteRevision,
          }),
        ).toEqual({
          favorite,
          expectedFavoriteRevision: expectedFavoriteRevision.toLowerCase(),
        });
    for (const favorite of ['true', 'false', 0, 1, null])
      expect(
        workflowFavoriteRequestSchema.safeParse({
          favorite,
          expectedFavoriteRevision: 'absent',
        }).success,
      ).toBe(false);
    for (const revision of ['', 'ABSENT', '0', 1, null, 'not-a-uuid'])
      expect(workflowFavoriteRevisionSchema.safeParse(revision).success).toBe(
        false,
      );
    for (const state of [
      { isFavorite: false, favoriteRevision: 'absent' },
      { isFavorite: false, favoriteRevision: firstId },
      { isFavorite: true, favoriteRevision: firstId },
    ]) {
      expect(
        workflowFavoriteResponseSchema.safeParse({ ...state, replayed: false })
          .success,
      ).toBe(state.favoriteRevision !== 'absent');
      expect(
        workflowOrganizationSchema.safeParse({ ...organization, ...state })
          .success,
      ).toBe(true);
    }
    expect(
      workflowFavoriteResponseSchema.safeParse({
        isFavorite: true,
        favoriteRevision: 'absent',
        replayed: false,
      }).success,
    ).toBe(false);
    expect(
      workflowOrganizationSchema.safeParse({
        ...organization,
        isFavorite: true,
      }).success,
    ).toBe(false);
    for (const field of [
      'userId',
      'favoriteCount',
      'favorites',
      'organizationRevision',
    ])
      expect(
        workflowFavoriteResponseSchema.safeParse({
          isFavorite: false,
          favoriteRevision: firstId,
          replayed: true,
          [field]: 1,
        }).success,
      ).toBe(false);
  });

  it('requires bounded unique strict metadata and slice-1 folder null', () => {
    expect(workflowOrganizationSchema.parse(organization)).toEqual(
      organization,
    );
    for (const field of Object.keys(organization)) {
      const omitted: Record<string, unknown> = { ...organization };
      Reflect.deleteProperty(omitted, field);
      expect(workflowOrganizationSchema.safeParse(omitted).success).toBe(false);
      if (field !== 'folderId')
        expect(
          workflowOrganizationSchema.safeParse({
            ...organization,
            [field]: null,
          }).success,
        ).toBe(false);
    }
    for (const extension of [
      { folderId: firstId },
      { actorId: firstId },
      { favoriteCount: 1 },
      { favorites: [firstId] },
      { templateOrigin: null },
    ])
      expect(
        workflowOrganizationSchema.safeParse({ ...organization, ...extension })
          .success,
      ).toBe(false);
    for (const tags of [
      [tag, { ...tag, id: firstId.toUpperCase(), key: 'other' }],
      [tag, { ...tag, id: secondId }],
      [{ ...tag, assignmentCount: 1 }],
    ])
      expect(
        workflowOrganizationSchema.safeParse({ ...organization, tags }).success,
      ).toBe(false);
    for (const count of [0, 16, 17])
      expect(
        workflowOrganizationSchema.safeParse({
          ...organization,
          tags: Array.from({ length: count }, (_, index) => ({
            id: identifierAt(index + 1),
            key: `tag-${String(index)}`,
            revision: 1,
          })),
        }).success,
      ).toBe(count <= 16);
  });

  it('keeps name search literal and case-sensitive with only U+0020 outer trim', () => {
    for (const [input, expected] of [
      ['  Invoice_%\\  ', 'Invoice_%\\'],
      ['\tInvoice\n', '\tInvoice\n'],
      [' ÉKİ ', 'ÉKİ'],
      [' e\u0301 ', 'e\u0301'],
      ['   ', ''],
    ])
      expect(workflowOrganizationNameQuerySchema.parse(input)).toBe(expected);
    for (const query of [
      'a'.repeat(128),
      'é'.repeat(64),
      '😀'.repeat(32),
      '€'.repeat(42) + 'aa',
    ])
      expect(workflowOrganizationNameQuerySchema.safeParse(query).success).toBe(
        true,
      );
    for (const query of [
      'a'.repeat(129),
      'é'.repeat(64) + 'a',
      '😀'.repeat(32) + 'a',
      '€'.repeat(43),
      null,
      128,
    ])
      expect(workflowOrganizationNameQuerySchema.safeParse(query).success).toBe(
        false,
      );
    expect(
      workflowOrganizationNameQuerySchema.parse('  ' + 'é'.repeat(64) + '  '),
    ).toBe('é'.repeat(64));
    for (const view of ['active', 'archived', 'all'])
      expect(workflowOrganizationViewSchema.parse(view)).toBe(view);
    for (const view of ['ALL', '', null, 'deleted'])
      expect(workflowOrganizationViewSchema.safeParse(view).success).toBe(
        false,
      );
  });
});
