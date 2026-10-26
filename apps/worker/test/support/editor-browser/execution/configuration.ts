import { z } from 'zod';

import type { EditorWorkerSetup } from './contract.js';
import {
  controlledHttp,
  curatedTemplates,
  emailAttachments,
} from './environment.js';

export async function configureEditorWorker(context: EditorWorkerSetup) {
  const { state, namespace, assertSetupActive } = context;
  if (state.configuration === undefined) {
    // Ownership is established before the parent API can write to this Redis DB.
    await namespace.acquire();
    assertSetupActive();
    const pendingConfiguration = new Promise<unknown>((resolve, reject) => {
      process.once('message', resolve);
      state.cancelConfiguration = () => {
        reject(new Error('Worker configuration wait canceled'));
      };
    });
    process.send?.({ phase: 'namespace-ready', database: namespace.database });
    const raw = await pendingConfiguration;
    state.cancelConfiguration = undefined;
    state.configuration = parseEditorWorkerConfiguration(
      raw,
      assertSetupActive,
    );
  }
  return state.configuration;
}

function parseEditorWorkerConfiguration(
  raw: unknown,
  assertSetupActive: () => void,
) {
  if (
    typeof raw !== 'object' ||
    raw === null ||
    !('workerUrl' in raw) ||
    !('dispatcherUrl' in raw) ||
    !('apiUrl' in raw) ||
    !('migrationUrl' in raw) ||
    typeof raw.workerUrl !== 'string' ||
    typeof raw.dispatcherUrl !== 'string' ||
    typeof raw.apiUrl !== 'string' ||
    typeof raw.migrationUrl !== 'string'
  )
    throw new Error(
      'Owned browser worker database configuration is incomplete',
    );
  assertSetupActive();
  return {
    workerUrl: raw.workerUrl,
    dispatcherUrl: raw.dispatcherUrl,
    apiUrl: raw.apiUrl,
    migrationUrl: raw.migrationUrl,
    ...('callbackConfig' in raw
      ? {
          callbackConfig: z
            .object({
              origin: z.string(),
              keys: z.object({
                current: z.object({ key: z.string(), version: z.string() }),
                previous: z.array(
                  z.object({ key: z.string(), version: z.string() }),
                ),
              }),
            })
            .parse(raw.callbackConfig),
        }
      : {}),
    ...(!controlledHttp && !curatedTemplates && !emailAttachments
      ? {}
      : editorHttpConfiguration(raw)),
  };
}

function editorHttpConfiguration(raw: object) {
  if (
    !('connectionMasterKey' in raw) ||
    typeof raw.connectionMasterKey !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(raw.connectionMasterKey) ||
    (controlledHttp &&
      (!('authorizationValue' in raw) ||
        typeof raw.authorizationValue !== 'string' ||
        raw.authorizationValue.length > 128))
  )
    throw new Error('Owned HTTP configuration incomplete');
  return {
    connectionMasterKey: raw.connectionMasterKey,
    ...(controlledHttp &&
    'authorizationValue' in raw &&
    typeof raw.authorizationValue === 'string'
      ? { authorizationValue: raw.authorizationValue }
      : {}),
  };
}
