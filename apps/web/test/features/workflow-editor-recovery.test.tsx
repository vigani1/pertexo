import { HttpResponse, http } from 'msw';
import { fireEvent, screen, waitFor } from '@testing-library/react';
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
  emptyGraph,
  etagA,
  findCanvas,
  findPaused,
  identityHandler,
  openRunLens,
  otherUser,
  pressSave,
  runDetailHandlers,
  runId,
  runSummary,
  user,
  validHandler,
  versionBody,
  versionId,
  workflowApi,
  workspaceId,
} from '../support/workflow-editor-fixtures';

// The lazy editor route and React Flow are slow to start on a busy machine.

describe('workflow editor uncertain commands', { timeout: 30_000 }, () => {
  it('retains an exact uncertain run through an identity pause until explicit retry', async () => {
    let identity: typeof user | 'error' = user;
    const requests: Readonly<{ body: unknown; key: string | null }>[] = [];
    mockServer.use(...editorHandlers(() => undefined));
    mockServer.use(
      identityHandler(() => identity),
      http.post(`${workflowApi}/runs`, async ({ request }) => {
        requests.push({
          body: await request.clone().json(),
          key: request.headers.get('idempotency-key'),
        });
        if (requests.length === 1) return HttpResponse.error();
        return HttpResponse.json({
          run: runSummary(runId, versionId, 'queued'),
          replayed: true,
        });
      }),
      ...runDetailHandlers(),
    );
    const app = renderApp(editorPath, { strict: true });
    const event = userEvent.setup();
    await findCanvas();
    await openRunLens(event);
    fireEvent.change(screen.getByLabelText('Run input (JSON)'), {
      target: { value: '{"customerId":"customer-7"}' },
    });
    fireEvent.change(screen.getByLabelText('Deadline (optional)'), {
      target: { value: '2026-09-20T12:30' },
    });
    await event.click(
      screen.getByRole('button', { name: 'Start published version' }),
    );
    expect(
      await screen.findByRole('button', { name: 'Retry same run' }),
    ).toBeVisible();
    expect(requests).toHaveLength(1);

    identity = 'error';
    await event.click(screen.getByRole('button', { name: 'Retry same run' }));
    expect(await findPaused()).toBeVisible();
    expect(requests).toHaveLength(1);
    expect(screen.queryByLabelText('Run input (JSON)')).not.toBeInTheDocument();

    identity = otherUser;
    await event.click(
      screen.getByRole('button', { name: 'Verify original account' }),
    );
    expect(
      screen.getByRole('heading', { name: 'Editor paused' }),
    ).toBeVisible();
    expect(requests).toHaveLength(1);

    identity = user;
    await event.click(
      screen.getByRole('button', { name: 'Verify original account' }),
    );
    await openRunLens(event);
    await event.click(screen.getByRole('button', { name: 'Retry same run' }));
    await waitFor(() => {
      expect(requests).toHaveLength(2);
    });
    expect(requests[0]?.key).toBeTruthy();
    expect(requests[0]?.body).toMatchObject({
      input: { customerId: 'customer-7' },
      deadlineAt: new Date('2026-09-20T12:30').toISOString(),
    });
    expect(requests[1]).toEqual(requests[0]);
    await waitFor(() => {
      expect(app.router.state.location.pathname).toBe(
        `/w/${workspaceId}/runs/${runId}`,
      );
    });
  });

  it('retains an exact uncertain publish through an identity pause until explicit retry', async () => {
    let identity: typeof user | 'error' = user;
    const requests: Readonly<{
      body: string;
      etag: string | null;
      key: string | null;
    }>[] = [];
    mockServer.use(...editorHandlers(() => undefined));
    mockServer.use(
      identityHandler(() => identity),
      validHandler(),
      http.post(`${workflowApi}/publish`, async ({ request }) => {
        requests.push({
          body: await request.clone().text(),
          etag: request.headers.get('if-match'),
          key: request.headers.get('idempotency-key'),
        });
        if (requests.length === 1) return HttpResponse.error();
        return HttpResponse.json({
          version: versionBody(versionId, emptyGraph),
          reused: true,
        });
      }),
    );
    renderApp(editorPath, { strict: true });
    const event = userEvent.setup();
    await findCanvas();
    await event.click(screen.getByRole('button', { name: 'Publish' }));
    await event.click(
      await screen.findByRole('button', { name: 'Publish this draft' }),
    );
    expect(
      await screen.findByRole('button', { name: 'Retry original publish' }),
    ).toBeVisible();
    expect(requests).toHaveLength(1);

    identity = 'error';
    await event.click(
      screen.getByRole('button', { name: 'Retry original publish' }),
    );
    expect(await findPaused()).toBeVisible();
    expect(requests).toHaveLength(1);

    identity = otherUser;
    await event.click(
      screen.getByRole('button', { name: 'Verify original account' }),
    );
    expect(
      screen.getByRole('heading', { name: 'Editor paused' }),
    ).toBeVisible();
    identity = user;
    await event.click(
      screen.getByRole('button', { name: 'Verify original account' }),
    );
    await event.click(await screen.findByRole('button', { name: 'Publish' }));
    await event.click(
      await screen.findByRole('button', { name: 'Retry original publish' }),
    );
    await waitFor(() => {
      expect(requests).toHaveLength(2);
    });
    expect(requests[0]).toMatchObject({ body: '', etag: etagA });
    expect(requests[0]?.key).toBeTruthy();
    expect(requests[1]).toEqual(requests[0]);
    expect(await screen.findByText('v1 live')).toBeVisible();
  });
});

describe(
  'workflow editor commands accepted while paused',
  { timeout: 30_000 },
  () => {
    it('retains a run accepted during a pause until the verified user opens it', async () => {
      const accepted = deferred<Response>();
      let identity = user;
      let runRequests = 0;
      mockServer.use(...editorHandlers(() => undefined));
      mockServer.use(
        http.get(`${api}/users/me`, () => HttpResponse.json(identity)),
        http.post(`${workflowApi}/runs`, () => {
          runRequests += 1;
          return accepted.promise;
        }),
        ...runDetailHandlers(),
      );
      const app = renderApp(editorPath, { strict: true });
      const event = userEvent.setup();
      await findCanvas();
      await openRunLens(event);
      await event.click(
        screen.getByRole('button', { name: 'Start published version' }),
      );
      await waitFor(() => {
        expect(runRequests).toBe(1);
      });

      identity = otherUser;
      await app.queryClient.refetchQueries({
        queryKey: ['identity', 'current-user'],
      });
      expect(await findPaused()).toBeVisible();
      accepted.resolve(
        HttpResponse.json({
          run: runSummary(runId, versionId, 'queued'),
          replayed: false,
        }),
      );
      await new Promise((resolve) => window.setTimeout(resolve, 0));
      expect(
        screen.getByRole('heading', { name: 'Editor paused' }),
      ).toBeVisible();
      expect(app.router.state.location.pathname).toBe(editorPath);

      identity = user;
      await event.click(
        screen.getByRole('button', { name: 'Verify original account' }),
      );
      const openAccepted = await screen.findByRole('button', {
        name: 'Open accepted run',
      });
      expect(runRequests).toBe(1);
      await event.click(addStepButton(/Set fields/u));
      expect(screen.getByText('Unsaved')).toBeVisible();
      await event.click(openAccepted);
      expect(
        await screen.findByRole('heading', {
          name: 'Leave with unsaved changes?',
        }),
      ).toBeVisible();
      await event.click(screen.getByRole('button', { name: 'Stay here' }));
      expect(app.router.state.location.pathname).toBe(editorPath);

      pressSave();
      expect(await screen.findByText(/^Saved/u)).toBeVisible();
      await event.click(
        screen.getByRole('button', { name: 'Open accepted run' }),
      );
      await waitFor(() => {
        expect(app.router.state.location.pathname).toBe(
          `/w/${workspaceId}/runs/${runId}`,
        );
      });
      expect(runRequests).toBe(1);
    });

    it('retains a late publish receipt through a pause without publishing again', async () => {
      const accepted = deferred<Response>();
      let identity = user;
      let publishRequests = 0;
      mockServer.use(...editorHandlers(() => undefined));
      mockServer.use(
        http.get(`${api}/users/me`, () => HttpResponse.json(identity)),
        validHandler(),
        http.post(`${workflowApi}/publish`, () => {
          publishRequests += 1;
          return accepted.promise;
        }),
      );
      const app = renderApp(editorPath, { strict: true });
      const event = userEvent.setup();
      await findCanvas();
      await event.click(screen.getByRole('button', { name: 'Publish' }));
      await event.click(
        await screen.findByRole('button', { name: 'Publish this draft' }),
      );
      await waitFor(() => {
        expect(publishRequests).toBe(1);
      });

      identity = otherUser;
      await app.queryClient.refetchQueries({
        queryKey: ['identity', 'current-user'],
      });
      expect(await findPaused()).toBeVisible();
      accepted.resolve(
        HttpResponse.json({
          version: versionBody(versionId, emptyGraph),
          reused: false,
        }),
      );
      await new Promise((resolve) => window.setTimeout(resolve, 0));
      expect(
        screen.getByRole('heading', { name: 'Editor paused' }),
      ).toBeVisible();

      identity = user;
      await event.click(
        screen.getByRole('button', { name: 'Verify original account' }),
      );
      expect(await screen.findByText('v1 live')).toBeVisible();
      expect(publishRequests).toBe(1);
    });
  },
);
