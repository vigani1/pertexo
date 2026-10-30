import { inputCaseFailure } from '../../../../src/problems/context/normalize.js';
import { problemResult } from '../../../support/problem.js';
import { toProblem } from '../../../../src/problems/registry.js';
import { authoringFailure } from '../../../../src/problems/context/normalize.js';
import 'reflect-metadata';
import { expect, it } from 'vitest';

import { createWorkflowInputCaseTag } from '@pertexo/contracts';
import {
  WorkflowInputCaseRevisionConflictError,
  WorkflowInputCaseLimitError,
} from '@pertexo/database/authoring';

import {
  caseId,
  versionId,
  context,
  representationTag,
  fixture,
} from './fixture.js';

export function registerDeniesRebindingOversizedJSONWrongCase(): void {
  it('denies rebinding, oversized JSON and wrong-case or malformed validators before persistence', async () => {
    const { cases, persistence } = fixture();
    const command = {
      ...context,
      caseId,
      representationTag,
      idempotencyKey: 'case-once',
    };
    await expect(
      cases.update({
        ...command,
        request: { name: 'x', input: {}, workflowVersionId: versionId },
      }),
    ).rejects.toMatchObject({ name: 'ZodError' });
    await expect(
      cases.create({
        ...command,
        request: {
          name: 'x',
          input: 'a'.repeat(65_536),
          workflowVersionId: versionId,
        },
      }),
    ).rejects.toMatchObject({ name: 'ZodError' });
    await expect(
      cases.delete({ ...command, representationTag: 'bad' }),
    ).rejects.toMatchObject({ name: 'WorkflowHeaderError', code: 'invalid' });
    await expect(
      problemResult(
        cases.delete({
          ...command,
          representationTag: createWorkflowInputCaseTag(versionId, 1),
        }),
        inputCaseFailure,
      ),
    ).rejects.toMatchObject({ code: 'workflow.input_case_revision_conflict' });
    expect(persistence.createCase).not.toHaveBeenCalled();
    expect(persistence.updateCase).not.toHaveBeenCalled();
    expect(persistence.deleteCase).not.toHaveBeenCalled();
  });

  it('maps safe revision/quota/rollout failures without payload or name', () => {
    expect(
      toProblem(
        authoringFailure(new WorkflowInputCaseRevisionConflictError(2)),
      ),
    ).toMatchObject({ code: 'workflow.input_case_revision_conflict' });
    expect(
      toProblem(
        authoringFailure(new WorkflowInputCaseLimitError('retained_bytes')),
      ),
    ).toMatchObject({ code: 'workflow.input_case_limit_exceeded' });
  });
}
