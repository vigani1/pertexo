import { screen, waitFor } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import {
  openEditor,
  pinHandler,
} from '../../../../support/fixtures/inspector-session';
import { workflowApi } from '../../../../support/fixtures/workflow-editor';
import {
  at,
  chain,
  direct,
  openPicker,
  realRunHandlers,
  runStepTest,
  stepTestHandler,
  workflowTestHandlers,
} from './fixture';

const PINNED_AGAIN = {
  sample: {
    id: '11111111-1111-4111-8111-111111111111',
    nodeId: 'fetch',
    binding: 'sample-binding',
    state: 'pinned',
    source: { kind: 'json' },
    createdAt: at,
    expiresAt: '2026-11-15T10:00:00.000Z',
  },
  output: { recovered: true },
  draftRevision: 1,
  limits: { inlineBytes: 262144, depth: 64, members: 10000 },
};

describe('where a step’s values come from', { timeout: 60_000 }, () => {
  const pin = () => pinHandler('fetch', { source: 'pinned sample' });

  it.each([
    {
      name: 'a pinned sample beats everything',
      handlers: [pin(), ...workflowTestHandlers(), ...realRunHandlers()],
      stepTest: true,
      line: 'Values from its pinned sample',
      value: 'pinned sample',
    },
    {
      name: 'this session’s test beats recorded runs',
      handlers: [...workflowTestHandlers(), ...realRunHandlers()],
      stepTest: true,
      line: 'Values from your last test',
      value: 'session test',
    },
    {
      name: 'the latest workflow test beats the latest real run',
      handlers: [...workflowTestHandlers(), ...realRunHandlers()],
      stepTest: false,
      line: 'Values from the latest workflow test',
      value: 'workflow test',
    },
    {
      name: 'the latest real run is the last resort',
      handlers: realRunHandlers(),
      stepTest: false,
      line: 'Values from its latest run',
      value: 'real run',
    },
    {
      name: 'an expired pin counts as no sample',
      handlers: [
        pinHandler('fetch', { source: 'pinned sample' }, 'expired'),
        ...realRunHandlers(),
      ],
      stepTest: false,
      line: 'Values from its latest run',
      value: 'real run',
    },
    {
      name: 'a workflow test that never reached the step falls through',
      handlers: [...workflowTestHandlers('middle'), ...realRunHandlers()],
      stepTest: false,
      line: 'Values from its latest run',
      value: 'real run',
    },
  ])('$name', async ({ handlers, stepTest, line, value }) => {
    const session = await openEditor(direct(), {
      handlers: [
        ...handlers,
        stepTestHandler('fetch', { source: 'session test' }),
      ],
    });
    if (stepTest) await runStepTest(session, 'Fetch order');
    const picker = await openPicker(session);
    expect(await picker.findByText(line)).toBeVisible();
    expect(
      picker.getByRole('button', { name: `source${value}string` }),
    ).toBeVisible();
  });

  it('remembers tests of several steps, without reloading', async () => {
    const session = await openEditor(chain(), {
      handlers: [
        stepTestHandler('fetch', { fromFetch: 'yes' }),
        stepTestHandler('middle', { fromMiddle: 'yes' }),
      ],
    });
    await runStepTest(session, 'Fetch order');
    await runStepTest(session, 'Middle');
    const picker = await openPicker(session);
    expect(
      await picker.findByRole('button', { name: /^fromMiddle/u }),
    ).toBeVisible();
    await session.event.click(
      picker.getByRole('button', { name: 'Fetch order' }),
    );
    expect(
      await picker.findByRole('button', { name: /^fromFetch/u }),
    ).toBeVisible();
  });

  it('says a stored file has no fields to list', async () => {
    const session = await openEditor(direct(), {
      handlers: realRunHandlers({
        kind: 'artifact',
        artifactId: '13131313-1313-4313-8313-131313131313',
      }),
    });
    const picker = await openPicker(session);
    expect(
      await picker.findByText(/stored as a file, so it has no fields to list/u),
    ).toBeVisible();
  });

  it('says a read failed, and Try again works', async () => {
    let broken = true;
    const session = await openEditor(direct(), {
      handlers: [
        http.get(`${workflowApi}/draft/nodes/fetch/sample`, () => {
          if (broken) return HttpResponse.json({}, { status: 500 });
          return HttpResponse.json(PINNED_AGAIN);
        }),
      ],
    });
    const picker = await openPicker(session);
    expect(
      await picker.findByText(/Couldn’t load its last output/u, undefined, {
        timeout: 10_000,
      }),
    ).toBeVisible();
    broken = false;
    await session.event.click(
      picker.getByRole('button', { name: 'Try again' }),
    );
    expect(
      await picker.findByText('Values from its pinned sample'),
    ).toBeVisible();
    expect(picker.getByRole('button', { name: /^recovered/u })).toBeVisible();
  });

  it('asks nothing of someone who can’t read runs, and says why', async () => {
    const asked: string[] = [];
    const session = await openEditor(direct(), {
      capabilities: ['workspace:read', 'workflow:read', 'workflow:update'],
      handlers: [
        http.get(`${workflowApi}/draft/nodes/:nodeId/sample`, ({ params }) => {
          asked.push(String(params.nodeId));
          return HttpResponse.json({}, { status: 403 });
        }),
      ],
    });
    const picker = await openPicker(session);
    expect(
      (await picker.findAllByText(/can’t read run data here/u)).length,
    ).toBeGreaterThan(0);
    expect(asked).toEqual([]);
  });

  it('reads nothing until the picker opens, and further-back steps until they do', async () => {
    const asked: string[] = [];
    const session = await openEditor(chain(), {
      handlers: [
        http.get(`${workflowApi}/draft/nodes/:nodeId/sample`, ({ params }) => {
          asked.push(String(params.nodeId));
          return HttpResponse.json({
            sample: null,
            output: null,
            draftRevision: 1,
            limits: { inlineBytes: 262144, depth: 64, members: 10000 },
          });
        }),
      ],
    });
    session.select('Target');
    await session.event.click(
      await screen.findByRole('tab', { name: 'Inputs' }),
    );
    expect(asked).toEqual([]);
    const picker = await openPicker(session);
    await waitFor(() => {
      expect(new Set(asked)).toEqual(new Set(['middle', 'manual']));
    });
    await session.event.click(
      picker.getByRole('button', { name: 'Fetch order' }),
    );
    await waitFor(() => {
      expect(asked).toContain('fetch');
    });
  });
});
