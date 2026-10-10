import { describe, expect, it } from 'vitest';
import {
  createWorkflowInputCaseTag,
  parseWorkflowInputCaseTag,
  workflowInputCaseCreateRequestSchema,
  workflowInputCaseUpdateRequestSchema,
  workflowInputCaseJsonSchema,
  workflowInputCaseQuerySchema,
  workflowInputCaseMetadataSchema,
  workflowInputCaseCommandResponseSchema,
  workflowInputCaseResponseSchema,
  workflowInputCaseListResponseSchema,
  workflowInputCaseTagSchema,
} from '../../src/schemas/workflows/input-cases.js';
import {
  workflowAuthoringOpenApiDocument,
  workflowAuthoringClientContract,
} from '../../src/server.js';
import { API_PROBLEM_MANIFEST } from '../../src/errors/api-problem.js';

const caseId = '11111111-1111-4111-8111-111111111111';
const metadata = {
  id: caseId,
  workspaceId: caseId,
  workflowId: caseId,
  workflowVersionId: caseId,
  versionChecksum: `wf:sha256:${'a'.repeat(64)}`,
  name: 'Example',
  revision: 1,
  representationTag: createWorkflowInputCaseTag(caseId, 1),
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
};
describe('bounded version-contextual input case contracts', () => {
  it('accepts only strict manually entered JSON commands and preserves version binding', () => {
    expect(
      workflowInputCaseCreateRequestSchema.parse({
        workflowVersionId: caseId,
        name: ' Example ',
        input: null,
      }),
    ).toEqual({ workflowVersionId: caseId, name: 'Example', input: null });
    expect(
      workflowInputCaseUpdateRequestSchema.parse({
        name: 'Edit',
        input: [1, true, { z: '🚀', a: null }],
      }),
    ).toEqual({ name: 'Edit', input: [1, true, { z: '🚀', a: null }] });
    for (const body of [
      { name: '', input: {} },
      { name: 'a'.repeat(129), input: {} },
      { name: '\u0000', input: {} },
      { name: '\ud800', input: {} },
      { name: '\udc00', input: {} },
      { name: 'x' },
      { name: 'x', input: {}, workflowVersionId: caseId },
      { name: 'x', input: {}, pins: [] },
    ])
      expect(workflowInputCaseUpdateRequestSchema.safeParse(body).success).toBe(
        false,
      );
  });
  it('measures UTF-8 JSON bytes, root/container depth and members consistently', () => {
    expect(workflowInputCaseJsonSchema.safeParse(-0).success).toBe(true);
    expect(workflowInputCaseJsonSchema.safeParse('é').success).toBe(true);
    expect(workflowInputCaseJsonSchema.safeParse('漢').success).toBe(true);
    const manyMembers = Object.fromEntries(
      Array.from({ length: 5_001 }, (_, index) => [
        `field${String(index)}`,
        null,
      ]),
    );
    expect(
      workflowInputCaseJsonSchema.safeParse([manyMembers, manyMembers]).success,
    ).toBe(false);
    expect(
      workflowInputCaseJsonSchema.safeParse('x'.repeat(65_534)).success,
    ).toBe(true);
    expect(
      workflowInputCaseJsonSchema.safeParse('x'.repeat(65_535)).success,
    ).toBe(false);
    expect(
      workflowInputCaseJsonSchema.safeParse('🚀'.repeat(16_383)).success,
    ).toBe(true);
    expect(
      workflowInputCaseJsonSchema.safeParse('🚀'.repeat(16_384)).success,
    ).toBe(false);
    expect(
      workflowInputCaseJsonSchema.safeParse('é'.repeat(32_767)).success,
    ).toBe(true);
    expect(
      workflowInputCaseJsonSchema.safeParse('日'.repeat(21_845)).success,
    ).toBe(false);
    let nested: unknown = null;
    for (let index = 0; index < 64; index += 1) nested = [nested];
    expect(workflowInputCaseJsonSchema.safeParse(nested).success).toBe(true);
    expect(workflowInputCaseJsonSchema.safeParse([nested]).success).toBe(false);
    expect(
      workflowInputCaseJsonSchema.safeParse(
        Array.from({ length: 10_000 }, () => 0),
      ).success,
    ).toBe(true);
    expect(
      workflowInputCaseJsonSchema.safeParse(
        Array.from({ length: 10_001 }, () => 0),
      ).success,
    ).toBe(false);
  });
  it('rejects cycles, sparse arrays, classes, symbols, non-finite numbers and accessors without invoking them', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const shared = { x: 1 };
    expect(
      workflowInputCaseJsonSchema.safeParse([shared, shared]).success,
    ).toBe(true);
    let getterCalls = 0;
    const accessor = Object.defineProperty({}, 'input', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return null;
      },
    });
    const sparse = Array.from({ length: 1 });
    Reflect.deleteProperty(sparse, '0');
    const extended = Object.assign([1], { extra: true });
    for (const value of [
      undefined,
      NaN,
      Infinity,
      1n,
      () => null,
      cyclic,
      sparse,
      extended,
      new Date(),
      { [Symbol('key')]: 1 },
      accessor,
      '\u0000',
      '\ud800',
      '\udfff',
      { '\u0000': null },
      { '\ud800': null },
    ])
      expect(workflowInputCaseJsonSchema.safeParse(value).success).toBe(false);
    expect(getterCalls).toBe(0);
    expect(
      workflowInputCaseJsonSchema.safeParse(Object.create(null) as unknown)
        .success,
    ).toBe(true);
  });
  it('uses exact strong opaque validators and rejects weak/list/wildcard/noncanonical values', () => {
    const tag = createWorkflowInputCaseTag(caseId, 2_147_483_647);
    expect(parseWorkflowInputCaseTag(tag)).toEqual({
      caseId,
      revision: 2_147_483_647,
    });
    expect(workflowInputCaseTagSchema.parse(tag)).toBe(tag);
    for (const value of [
      null,
      'W/' + tag,
      '*',
      `${tag},${tag}`,
      '"wic1.bad.1"',
      '"wic1.11111111111141118111111111111111.01"',
      '"wic1.11111111111141118111111111111111.zzzzzz"',
      '"wic1.11111111111111111111111111111111.1"',
    ])
      expect(parseWorkflowInputCaseTag(value)).toBeUndefined();
    expect(() => createWorkflowInputCaseTag('bad', 1)).toThrow();
    expect(() => createWorkflowInputCaseTag(caseId, 0)).toThrow();
  });
  it('keeps lists payload-free and receipt responses identifier-only', () => {
    expect(workflowInputCaseMetadataSchema.parse(metadata)).toEqual(metadata);
    expect(
      workflowInputCaseListResponseSchema.parse({ items: [metadata] }),
    ).toEqual({ items: [metadata] });
    expect(
      workflowInputCaseResponseSchema.parse({
        case: { ...metadata, input: { n: 1 } },
      }).case.input,
    ).toEqual({ n: 1 });
    expect(
      workflowInputCaseMetadataSchema.safeParse({ ...metadata, input: {} })
        .success,
    ).toBe(false);
    const command = { caseId, revision: 1, replayed: true };
    expect(workflowInputCaseCommandResponseSchema.parse(command)).toEqual(
      command,
    );
    expect(
      workflowInputCaseCommandResponseSchema.safeParse({
        ...command,
        name: 'private',
        input: {},
      }).success,
    ).toBe(false);
    expect(workflowInputCaseQuerySchema.parse({ limit: '5' })).toEqual({
      limit: 5,
    });
    expect(workflowInputCaseQuerySchema.parse({})).toEqual({ limit: 20 });
    for (const query of [
      { limit: 101 },
      { after: 'x'.repeat(1025) },
      { input: {} },
    ])
      expect(workflowInputCaseQuerySchema.safeParse(query).success).toBe(false);
  });
  it('projects browser and OpenAPI contracts with conditional mutation requirements and truthful effects', () => {
    const collection =
      workflowAuthoringOpenApiDocument.paths[
        '/v1/workspaces/{workspaceId}/workflows/{workflowId}/input-cases'
      ];
    const item =
      workflowAuthoringOpenApiDocument.paths[
        '/v1/workspaces/{workspaceId}/workflows/{workflowId}/input-cases/{caseId}'
      ];
    expect(collection.post.parameters.map(({ name }) => name)).toContain(
      'Idempotency-Key',
    );
    expect(item.put.parameters.map(({ name }) => name)).toContain('If-Match');
    expect(item.delete.responses['428']).toEqual({
      $ref: '#/components/responses/PreconditionRequired',
    });
    expect(item.get.responses['200'].headers.ETag.required).toBe(true);
    expect(collection.get.description).toContain('Loading never starts a run');
    expect(workflowAuthoringClientContract.schemas).toHaveProperty(
      'WorkflowInputCaseCreateRequest',
    );
    expect(
      API_PROBLEM_MANIFEST['workflow.input_case_revision_conflict'].status,
    ).toBe(412);
    expect(
      API_PROBLEM_MANIFEST['workflow.input_case_limit_exceeded'].status,
    ).toBe(409);
  });
});
