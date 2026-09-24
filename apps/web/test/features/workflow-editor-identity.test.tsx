import { HttpResponse, http } from 'msw';
import { configure, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockServer } from '../support/mock-server';
import { renderApp } from '../support/render-app';
import {
  addStepButton,
  api,
  deferred,
  editorHandlers,
  editorPath,
  findCanvas,
  findPaused,
  identityHandler,
  openRunLens,
  otherUser,
  pressSave,
  user,
  validHandler,
  workflowApi,
} from '../support/workflow-editor-fixtures';

// The lazy editor route and React Flow are slow to start on a busy machine.
configure({ asyncUtilTimeout: 5_000 });

describe('workflow editor identity fencing', { timeout: 30_000 }, () => {
  it('freezes saving and checks when the signed-in account changes', async () => {
    let currentUser = user;
    let saveCalls = 0;
    let validationCalls = 0;
    mockServer.use(
      ...editorHandlers(() => {
        saveCalls += 1;
      }),
    );
    mockServer.use(
      identityHandler(() => currentUser),
      validHandler(() => {
        validationCalls += 1;
      }),
    );
    renderApp(editorPath, { strict: true });
    const event = userEvent.setup();
    await findCanvas();
    currentUser = otherUser;
    await event.click(addStepButton(/Set fields/u));
    pressSave();
    expect(await findPaused()).toBeVisible();
    await new Promise((resolve) => window.setTimeout(resolve, 900));
    expect(saveCalls).toBe(0);
    expect(validationCalls).toBe(0);

    currentUser = user;
    await event.click(
      screen.getByRole('button', { name: 'Verify original account' }),
    );
    await waitFor(() => {
      expect(
        screen.queryByRole('heading', { name: 'Editor paused' }),
      ).toBeNull();
    });
    pressSave();
    await waitFor(() => {
      expect(saveCalls).toBe(1);
    });
  });

  it('aborts an in-flight draft write when identity observation changes', async () => {
    let currentUser = user;
    let saveStarted = 0;
    let requestAborted = false;
    const gate = deferred<undefined>();
    mockServer.use(...editorHandlers(() => undefined));
    mockServer.use(
      identityHandler(() => currentUser),
      http.put(`${workflowApi}/draft`, async ({ request }) => {
        saveStarted += 1;
        request.signal.addEventListener('abort', () => {
          requestAborted = true;
        });
        await gate.promise;
        return HttpResponse.json({}, { status: 500 });
      }),
    );
    const { queryClient } = renderApp(editorPath, { strict: true });
    const event = userEvent.setup();
    await findCanvas();
    await event.click(addStepButton(/Set fields/u));
    pressSave();
    await waitFor(() => {
      expect(saveStarted).toBe(1);
    });
    currentUser = otherUser;
    await queryClient.refetchQueries({
      queryKey: ['identity', 'current-user'],
    });
    expect(await findPaused()).toBeVisible();
    await waitFor(() => {
      expect(requestAborted).toBe(true);
    });
    gate.resolve(undefined);
  });
});

describe('workflow editor recovery scope', { timeout: 30_000 }, () => {
  it('does not trust cached original-user data when fresh verification fails', async () => {
    let identity: 'original' | 'unavailable' | 'network' | 'unauthorized' =
      'original';
    let runRequests = 0;
    mockServer.use(...editorHandlers(() => undefined));
    mockServer.use(
      http.get(`${api}/users/me`, () => {
        if (identity === 'original') return HttpResponse.json(user);
        if (identity === 'network') return HttpResponse.error();
        const unauthorized = identity === 'unauthorized';
        return HttpResponse.json(
          {
            type: unauthorized
              ? 'urn:pertexo:problem:auth.required'
              : 'urn:pertexo:problem:service.unavailable',
            title: unauthorized
              ? 'Authentication required'
              : 'Service unavailable',
            status: unauthorized ? 401 : 503,
            code: unauthorized ? 'auth.required' : 'service.unavailable',
            requestId: `identity-${identity}`,
          },
          {
            status: unauthorized ? 401 : 503,
            headers: { 'content-type': 'application/problem+json' },
          },
        );
      }),
      http.post(`${workflowApi}/runs`, () => {
        runRequests += 1;
        return HttpResponse.error();
      }),
    );
    renderApp(editorPath, { strict: true });
    const event = userEvent.setup();
    await findCanvas();
    await openRunLens(event);
    await event.click(
      screen.getByRole('button', { name: 'Start published version' }),
    );
    expect(
      await screen.findByRole('button', { name: 'Retry same run' }),
    ).toBeVisible();

    identity = 'unavailable';
    await event.click(screen.getByRole('button', { name: 'Retry same run' }));
    expect(await findPaused()).toBeVisible();
    for (const next of ['unavailable', 'network', 'unauthorized'] as const) {
      identity = next;
      await event.click(
        screen.getByRole('button', { name: 'Verify original account' }),
      );
      expect(
        screen.getByRole('heading', { name: 'Editor paused' }),
      ).toBeVisible();
    }
    expect(runRequests).toBe(1);

    identity = 'original';
    await event.click(
      screen.getByRole('button', { name: 'Verify original account' }),
    );
    await openRunLens(event);
    expect(
      screen.getByRole('button', { name: 'Retry same run' }),
    ).toBeVisible();
    expect(runRequests).toBe(1);
  });

  it('disposes retained command recovery when the routed editor scope exits', async () => {
    let runRequests = 0;
    let publishRequests = 0;
    mockServer.use(...editorHandlers(() => undefined));
    mockServer.use(
      validHandler(),
      http.post(`${workflowApi}/publish`, () => {
        publishRequests += 1;
        return HttpResponse.error();
      }),
      http.post(`${workflowApi}/runs`, () => {
        runRequests += 1;
        return HttpResponse.error();
      }),
    );
    const first = renderApp(editorPath);
    const event = userEvent.setup();
    await findCanvas();
    await openRunLens(event);
    await event.click(
      screen.getByRole('button', { name: 'Start published version' }),
    );
    expect(
      await screen.findByRole('button', { name: 'Retry same run' }),
    ).toBeVisible();
    await event.click(screen.getByRole('button', { name: 'Cancel' }));
    await event.click(screen.getByRole('button', { name: 'Publish' }));
    await event.click(
      await screen.findByRole('button', { name: 'Publish this draft' }),
    );
    expect(
      await screen.findByRole('button', { name: 'Retry original publish' }),
    ).toBeVisible();
    expect(runRequests).toBe(1);
    expect(publishRequests).toBe(1);
    first.unmount();

    renderApp(editorPath);
    await findCanvas();
    await openRunLens(event);
    expect(
      screen.getByRole('button', { name: 'Start published version' }),
    ).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'Retry same run' }),
    ).not.toBeInTheDocument();
    await event.click(screen.getByRole('button', { name: 'Cancel' }));
    await event.click(screen.getByRole('button', { name: 'Publish' }));
    expect(
      await screen.findByRole('button', { name: 'Publish this draft' }),
    ).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'Retry original publish' }),
    ).not.toBeInTheDocument();
  });
});
