import { describe, expect, it } from 'vitest';
import {
  normalizeWorkflowTagKey,
  workflowTagCreateRequestSchema,
  workflowTagKeyInputSchema,
  workflowTagKeySchema,
  workflowTagRenameRequestSchema,
  workflowTagSchema,
  WORKFLOW_ORGANIZATION_LIMITS,
} from '../../../src/schemas/workflows/organization.js';
import { tag } from '../../support/organization-schemas.js';

describe('ADR064 workflow organization public schemas', () => {
  it('pins the accepted product bounds rather than caller-configurable quotas', () => {
    expect(WORKFLOW_ORGANIZATION_LIMITS).toEqual({
      tagKeyBytes: 32,
      tagsPerWorkflow: 16,
      tagsPerWorkspace: 256,
      cleanupItems: 50,
      nameQueryBytes: 128,
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
});
