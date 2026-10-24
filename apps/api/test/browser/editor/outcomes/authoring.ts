import { verifyTransformEvidence } from '../evidence/transforms/qualification.js';
import { verifyApiTokensEvidence } from '../evidence/api-tokens/qualification.js';

import { expect } from 'vitest';

import { verifyWorkflowDuplicationEvidence } from '../evidence/duplication.js';
import { verifyWorkflowPortabilityBrowserEvidence } from '../portability.fixture.js';
import { verifyWorkflowInputCasesEvidence } from '../evidence/input-cases.js';

import { fixtureState } from '../fixture/state.js';
import { recheckOwnership, closeChild } from '../fixture/lifecycle.js';
import type { EditorBrowserJourneyContext } from '../fixture/contract.js';

export async function verifyEditorApiTokensOutcome(
  context: EditorBrowserJourneyContext,
) {
  const { api } = context;
  if (fixtureState.apiTokensEvidence === undefined)
    throw new Error('API token browser evidence missing');
  await verifyApiTokensEvidence(api.database(), fixtureState.apiTokensEvidence);
  return;
}

export async function verifyEditorCuratedTemplatesOutcome(
  context: EditorBrowserJourneyContext,
) {
  const { apiOrigin, fixture } = context;
  if (
    fixtureState.curatedFixture === undefined ||
    fixtureState.curatedEvidence === undefined
  )
    throw new Error('Curated template browser evidence missing');
  await fixtureState.curatedFixture.verifyEvidence(
    fixtureState.curatedEvidence,
  );
  await recheckOwnership();
  const runs = await fixtureState.curatedFixture.executeGraphs(
    fixtureState.curatedEvidence,
  );
  await recheckOwnership();
  const triggerRuns = await fixtureState.curatedFixture.executeTriggers(
    fixtureState.curatedEvidence,
    apiOrigin,
  );
  await closeChild(fixture.worker);
  if (fixtureState.curatedEffects === undefined)
    throw new Error('Controlled curated worker effects missing');
  expect(
    fixtureState.curatedEffects.observations.map(({ kind, status }) => ({
      kind,
      status,
    })),
  ).toEqual([
    { kind: 'http', status: 200 },
    { kind: 'slack', status: 200 },
    { kind: 'http', status: 204 },
    { kind: 'http', status: 500 },
  ]);
  expect(fixtureState.curatedEffects.pendingHttpResponses).toBe(0);
  process.stdout.write(
    `Live browser curated template verified identities ${JSON.stringify({ ...fixtureState.curatedEvidence, runs, triggerRuns, effects: fixtureState.curatedEffects })}\n`,
  );
  return;
}

export async function verifyEditorPortabilityOutcome(
  context: EditorBrowserJourneyContext,
) {
  const { api } = context;
  if (
    fixtureState.portabilityFixture === undefined ||
    fixtureState.portabilityEvidence === undefined
  )
    throw new Error('Workflow portability evidence missing');
  await verifyWorkflowPortabilityBrowserEvidence(
    api.database(),
    fixtureState.portabilityFixture.scope,
    fixtureState.portabilityEvidence,
  );
  process.stdout.write(
    `Live browser workflow portability evidence ${JSON.stringify(fixtureState.portabilityEvidence)}\n`,
  );
  return;
}

export async function verifyEditorInputCasesOutcome(
  context: EditorBrowserJourneyContext,
) {
  const { api } = context;
  if (fixtureState.inputCasesEvidence === undefined)
    throw new Error('Workflow input cases evidence missing');
  await verifyWorkflowInputCasesEvidence(
    api.database(),
    fixtureState.inputCasesEvidence,
  );
  process.stdout.write(
    `Live browser workflow input cases verified identities ${JSON.stringify(fixtureState.inputCasesEvidence)}\n`,
  );
  return;
}

export async function verifyEditorDuplicationOutcome(
  context: EditorBrowserJourneyContext,
) {
  const { api } = context;
  if (fixtureState.duplicationEvidence === undefined)
    throw new Error('Workflow duplication evidence missing');
  await verifyWorkflowDuplicationEvidence(
    api.database(),
    fixtureState.duplicationEvidence,
  );
  process.stdout.write(
    `Live browser workflow duplication evidence ${JSON.stringify(fixtureState.duplicationEvidence)}\n`,
  );
  return;
}

export async function verifyEditorTransformsOutcome(
  context: EditorBrowserJourneyContext,
) {
  const { api } = context;
  if (
    fixtureState.collectionEvidence === undefined ||
    fixtureState.dateEvidence === undefined
  )
    throw new Error('Transform browser evidence missing');
  await verifyTransformEvidence(
    api.database(),
    fixtureState.collectionEvidence,
    fixtureState.dateEvidence,
  );
  return;
}

export async function verifyEditorReadonlyOutcome(
  _context: EditorBrowserJourneyContext,
) {
  if (
    fixtureState.readonlyFixture === undefined ||
    fixtureState.readonlyEvidence === undefined
  )
    throw new Error('Readonly editor evidence missing');
  await fixtureState.readonlyFixture.verify(fixtureState.readonlyEvidence);
  process.stdout.write(
    `Live browser readonly evidence ${JSON.stringify(fixtureState.readonlyEvidence)}\n`,
  );
  return;
}
