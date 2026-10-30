import { FormUploadLimitError } from '@pertexo/database/runs';
import { expect, it } from 'vitest';
import { toProblem } from '../../../src/problems/registry.js';

it('tells a responder over the per-response cap to reload the form', () => {
  expect(toProblem(new FormUploadLimitError('response'))).toMatchObject({
    code: 'form.upload_limit',
    safeDetail:
      'This response has started too many uploads. Reload the form to start again.',
  });
});

// web-app-13: the busy allowance is temporary, so it gets its own code.
it('tells a responder to try again later while unsent public files fill the allowance', () => {
  expect(toProblem(new FormUploadLimitError('unsent_public'))).toMatchObject({
    code: 'form.upload_busy',
    safeDetail:
      'This form is receiving a lot of files right now. Try again in a few minutes.',
  });
});
