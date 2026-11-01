import { expect, it } from 'vitest';

import { ErrorWorkflowDeliveryMismatchError } from '../../../../src/runs/error-workflows/errors.js';

import { admin } from '../../../lifecycle/calls/fixtures.js';

import { store, fixture, delivery, intent } from './fixture.js';

export function registerCreatesExactlyOneSIntent(): void {
  it.each(['failed', 'timed_out', 'outcome_unknown'] as const)(
    'creates exactly one %s intent and target run under duplicate concurrent delivery',
    async (status) => {
      const f = await fixture(status);
      await Promise.all([f.produce(), f.produce()]);
      const input = await delivery(f);
      await Promise.all([store.dispatch(input), store.dispatch(input)]);
      await store.dispatch(input);
      const result = await intent(f);
      expect(result?.status).toBe('accepted');
      const runs = await admin.query<{
        trigger_type: string;
        error_workflow_origin: boolean;
        input_ref: unknown;
      }>(
        "select trigger_type,error_workflow_origin,input_ref from app.workflow_runs where workspace_id=$1 and trigger_type='workflow_error'",
        [f.workspaceId],
      );
      expect(runs.rows).toHaveLength(1);
      expect(runs.rows[0]).toMatchObject({
        trigger_type: 'workflow_error',
        error_workflow_origin: true,
        input_ref: { kind: 'inline', value: result?.context },
      });
      expect(JSON.stringify(result?.context)).not.toContain(
        'Call retention input',
      );
    },
  );

  it.each([
    ['succeeded', false, false],
    ['canceled', false, false],
    ['failed', true, false],
    ['failed', false, true],
  ] as const)(
    'does not trigger for %s, error origin %s or cancellation %s',
    async (status, origin, canceled) => {
      const f = await fixture(status, origin, canceled);
      await f.produce();
      expect(await intent(f)).toBeUndefined();
    },
  );

  it('records target archive refusal without admitting a run', async () => {
    const f = await fixture();
    await f.produce();
    await admin.query(
      "update app.workflows set lifecycle_status='archived',lifecycle_revision=lifecycle_revision+1 where id=$1",
      [f.childWorkflowId],
    );
    await store.dispatch(await delivery(f));
    expect(await intent(f)).toMatchObject({
      status: 'refused',
      refusal_code: 'target_unavailable',
      accepted_run_id: null,
    });
  });

  it('refuses changed transport data and cannot read another workspace intent', async () => {
    const f = await fixture();
    await f.produce();
    const input = await delivery(f);
    await expect(
      store.dispatch({ ...input, payloadChecksum: 'a'.repeat(64) }),
    ).rejects.toBeInstanceOf(ErrorWorkflowDeliveryMismatchError);
    const other = await fixture();
    await expect(
      store.dispatch({ ...input, workspaceId: other.workspaceId }),
    ).rejects.toBeInstanceOf(ErrorWorkflowDeliveryMismatchError);
    expect(await intent(f)).toMatchObject({ status: 'pending' });
  });
}
