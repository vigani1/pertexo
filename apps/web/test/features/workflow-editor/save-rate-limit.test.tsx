import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import {
  addStepButton,
  findCanvas,
} from '../../support/fixtures/editor-actions';
import {
  draftBody,
  editorHandlers,
  editorPath,
  etagB,
  workflowApi,
} from '../../support/fixtures/workflow-editor';
import { mockServer } from '../../support/mock-server';
import { renderApp } from '../../support/render-app';

function rateLimited(retryAfter: string | undefined) {
  return HttpResponse.json(
    {
      type: 'urn:pertexo:problem:request.rate_limited',
      title: 'Too many requests',
      status: 429,
      code: 'request.rate_limited',
      requestId: 'draft-save-limited',
    },
    {
      status: 429,
      headers: {
        'content-type': 'application/problem+json',
        ...(retryAfter === undefined ? {} : { 'retry-after': retryAfter }),
      },
    },
  );
}

// An autosave refused by a rate limit resumes by itself: after the server's
// Retry-After, or after 5 s when it gives none.
describe('a rate-limited draft save', { timeout: 30_000 }, () => {
  it.each([
    { retryAfter: '1', resumesWithin: 4_000 },
    { retryAfter: undefined, resumesWithin: 8_000 },
  ])(
    'saves again by itself (Retry-After $retryAfter)',
    async ({ retryAfter, resumesWithin }) => {
      let saves = 0;
      mockServer.use(...editorHandlers(() => undefined));
      mockServer.use(
        http.put(`${workflowApi}/draft`, async ({ request }) => {
          saves += 1;
          if (saves === 1) return rateLimited(retryAfter);
          const body = (await request.json()) as {
            graph: Parameters<typeof draftBody>[0];
          };
          return HttpResponse.json(draftBody(body.graph, 2), {
            headers: { etag: etagB },
          });
        }),
      );
      renderApp(editorPath);
      await findCanvas();
      await userEvent.setup().click(addStepButton(/Set fields/u));
      expect(
        await screen.findByTitle(/Saving again shortly/u),
      ).toHaveTextContent('Couldn’t save');
      await waitFor(
        () => {
          expect(saves).toBe(2);
        },
        { timeout: resumesWithin },
      );
      expect(await screen.findByText(/^Saved/u)).toBeVisible();
    },
  );
});
