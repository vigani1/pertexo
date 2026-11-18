import { FormUploadLimitError } from '@pertexo/core/artifacts';
import { expect, it } from 'vitest';
import { toProblem } from '../../../src/problems/api-problem-registry.js';

it('tells a responder over the per-response cap to reload the form', () => {
  expect(toProblem(new FormUploadLimitError('response'))).toMatchObject({
    code: 'form.upload_limit',
    safeDetail:
      'This response has started too many uploads. Reload the form to start again.',
  });
});
