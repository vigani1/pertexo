import { createTestArtifactScratch } from '../../infrastructure/artifact-scratch.js';
import { createEditorCodeRuntime } from '../code/runtime.js';

import { createArtifactDestination } from '../../../attempts/artifacts/http-destination.js';
import { parseArtifactStoreConfig } from '@pertexo/artifact-store';

import { createWorkerNodeRuntimeCapabilities } from '../../../../src/attempts/execution/runtime-capabilities.js';

import {
  ConnectionEnvelopeEncryption,
  type ConnectionSecretContext,
} from '@pertexo/integrations/server';
import { createEditorBrowserEnvelopeKeys } from '../../../../../../infrastructure/testing/editor-browser-envelope-keys.mjs';
import { createCuratedTemplateEnvelopeContext } from '../../../../../../infrastructure/testing/curated-template-envelope-context.mjs';
import { createCuratedTemplateQualificationTransports } from '../../curated-templates/controlled-transports.js';

import { createEditorControlledHttpTarget } from '../controlled-http.js';
import { createEditorResendMailbox } from '../notifications/resend-mailbox.js';

import type { EditorWorkerExecution } from './contract.js';
import {
  codeCase,
  webhookResponseCase,
  artifactInputs,
  controlledHttp,
  curatedTemplates,
  emailAttachments,
  formUploadsCase,
} from './environment.js';

export async function createEditorCapabilities(context: EditorWorkerExecution) {
  const { raw, database, namespace, resources, assertSetupActive } = context;
  let controlledCapabilities:
    Awaited<ReturnType<typeof createWorkerNodeRuntimeCapabilities>> | undefined;
  if (controlledHttp || curatedTemplates || emailAttachments) {
    if (
      raw.connectionMasterKey === undefined ||
      (controlledHttp && raw.authorizationValue === undefined)
    )
      throw new Error('Owned HTTP configuration incomplete');
    const master = Buffer.from(raw.connectionMasterKey, 'hex');
    const keys = curatedTemplates
      ? createCuratedTemplateEnvelopeContext<ConnectionSecretContext>(
          raw.connectionMasterKey,
        )
      : createEditorBrowserEnvelopeKeys<ConnectionSecretContext>(
          master,
          'connection',
        );
    master.fill(0);
    resources.envelopeKeys = {
      close: () => {
        keys.close();
        return Promise.resolve();
      },
    };
    await createControlledTransport(context);
    assertSetupActive();
    const storesFiles = artifactInputs || emailAttachments;
    const scratch = storesFiles ? await createTestArtifactScratch() : undefined;
    resources.artifactScratch = scratch;
    controlledCapabilities = await createWorkerNodeRuntimeCapabilities(
      {
        ...(scratch === undefined
          ? {}
          : { artifactScratchDirectory: scratch.directory }),
        database,
        redisUrl: namespace.redisUrl,
        ...(storesFiles ? { artifactStore: parseArtifactStoreConfig() } : {}),
      },
      { connectionEncryption: new ConnectionEnvelopeEncryption(keys) },
    );
    resources.capabilities = controlledCapabilities;
    assertSetupActive();
    await controlledCapabilities.checkReadiness();
    assertSetupActive();
  }
  if (formUploadsCase) {
    const scratch = await createTestArtifactScratch();
    resources.artifactScratch = scratch;
    controlledCapabilities = await createWorkerNodeRuntimeCapabilities({
      artifactScratchDirectory: scratch.directory,
      artifactStore: parseArtifactStoreConfig(),
      database,
      redisUrl: namespace.redisUrl,
    });
    resources.capabilities = controlledCapabilities;
    await controlledCapabilities.checkReadiness();
    assertSetupActive();
  }
  if (codeCase) {
    const code = await createEditorCodeRuntime(database);
    resources.codeRunner = code;
    controlledCapabilities = code.capabilities;
    resources.capabilities = controlledCapabilities;
    assertSetupActive();
  }
  if (
    webhookResponseCase ||
    ['variables', 'run-values', 'approvals'].includes(
      process.env.EDITOR_BROWSER_CASE ?? '',
    )
  ) {
    controlledCapabilities = await createWorkerNodeRuntimeCapabilities({
      database,
      ...(raw.callbackConfig === undefined
        ? {}
        : { callbacks: raw.callbackConfig }),
    });
    resources.capabilities = controlledCapabilities;
    await controlledCapabilities.checkReadiness();
    assertSetupActive();
  }

  return controlledCapabilities;
}

/** The one controlled destination this case's provider calls reach. */
async function createControlledTransport(context: EditorWorkerExecution) {
  const { state, raw, resources, sendHttpEffects, sendEmailDeliveries } =
    context;
  if (curatedTemplates) {
    state.curatedTarget = createCuratedTemplateQualificationTransports();
    resources.controlledHttp = state.curatedTarget;
  } else if (emailAttachments) {
    state.resendMailbox = createEditorResendMailbox(sendEmailDeliveries);
    resources.controlledHttp = state.resendMailbox;
  } else if (artifactInputs) {
    state.artifactTarget = await createArtifactDestination(sendHttpEffects);
    resources.controlledHttp = state.artifactTarget;
    sendHttpEffects();
  } else {
    if (raw.authorizationValue === undefined)
      throw new Error('Owned HTTP authorization missing');
    state.httpTarget = createEditorControlledHttpTarget(
      raw.authorizationValue,
      undefined,
      sendHttpEffects,
    );
    resources.controlledHttp = state.httpTarget;
    await state.httpTarget.start();
  }
}
