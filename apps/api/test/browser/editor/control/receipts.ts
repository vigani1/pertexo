import {
  collectionEvidenceSchema,
  dateEvidenceSchema,
} from '../evidence/transforms/qualification.js';
import { apiTokensEvidenceSchema } from '../evidence/api-tokens/qualification.js';
import { failureRoutingEvidenceSchema } from '../evidence/failure-routing.js';

import { callsEvidenceSchema } from '../evidence/calls.js';
import { callableEvidenceSchema } from '../evidence/callable.js';

import { scheduleEvidenceSchema } from '../evidence/schedule.js';
import { readonlyEvidenceSchema } from '../evidence/readonly.js';
import { expressionAdmissionEvidenceSchema } from '../evidence/expression-admission.js';
import {
  receiptRecoveryEvidenceSchema,
  runRecoveryEvidenceSchema,
} from '../evidence/recovery.js';
import { workflowDuplicationEvidenceSchema } from '../evidence/duplication.js';
import { workflowPortabilityBrowserEvidenceSchema } from '../portability.fixture.js';
import { workflowInputCasesEvidenceSchema } from '../evidence/input-cases.js';
import { curatedTemplateBrowserEvidenceSchema } from '../../curated-templates/fixture.js';

import { scenario, browserEvidenceSchema } from '../fixture/environment.js';
import { fixtureState } from '../fixture/state.js';
import { openBrowserInstances } from '../fixture/lifecycle.js';
import type { EditorControlRequest } from './contract.js';

const editorEvidenceReceipts = new Map<
  string,
  {
    readonly scenario: typeof scenario;
    readonly accept: (value: unknown) => void;
  }
>([
  [
    '/evidence/api-tokens',
    {
      scenario: 'api-tokens',
      accept: (value: unknown) => {
        fixtureState.apiTokensEvidence = apiTokensEvidenceSchema.parse(value);
      },
    },
  ],
  [
    '/evidence/transforms',
    {
      scenario: 'transforms',
      accept: (value: unknown) => {
        fixtureState.collectionEvidence = collectionEvidenceSchema.parse(value);
      },
    },
  ],
  [
    '/evidence/transform-date',
    {
      scenario: 'transforms',
      accept: (value: unknown) => {
        fixtureState.dateEvidence = dateEvidenceSchema.parse(value);
      },
    },
  ],
  [
    '/evidence/callable',
    {
      scenario: 'callable',
      accept: (value: unknown) => {
        fixtureState.callableEvidence = callableEvidenceSchema.parse(value);
      },
    },
  ],
  [
    '/evidence/calls',
    {
      scenario: 'callable',
      accept: (value: unknown) => {
        fixtureState.callsEvidence = callsEvidenceSchema.parse(value);
      },
    },
  ],
  [
    '/evidence/curated-templates',
    {
      scenario: 'curated-templates',
      accept: (value: unknown) => {
        fixtureState.curatedEvidence =
          curatedTemplateBrowserEvidenceSchema.parse(value);
      },
    },
  ],
  [
    '/evidence/portability',
    {
      scenario: 'portability',
      accept: (value: unknown) => {
        fixtureState.portabilityEvidence =
          workflowPortabilityBrowserEvidenceSchema.parse(value);
      },
    },
  ],
  [
    '/evidence',
    {
      scenario: 'nested-conflict',
      accept: (value: unknown) => {
        fixtureState.evidence = browserEvidenceSchema.parse(value);
      },
    },
  ],
  [
    '/evidence/receipts',
    {
      scenario: 'receipts',
      accept: (value: unknown) => {
        fixtureState.receiptEvidence =
          receiptRecoveryEvidenceSchema.parse(value);
      },
    },
  ],
  [
    '/evidence/failure-routing',
    {
      scenario: 'failure-routing',
      accept: (value: unknown) => {
        fixtureState.failureRoutingEvidence =
          failureRoutingEvidenceSchema.parse(value);
      },
    },
  ],
  [
    '/evidence/run-recovery',
    {
      scenario: 'run-recovery',
      accept: (value: unknown) => {
        fixtureState.runRecoveryEvidence =
          runRecoveryEvidenceSchema.parse(value);
      },
    },
  ],
  [
    '/evidence/expression-admission',
    {
      scenario: 'expression-admission',
      accept: (value: unknown) => {
        fixtureState.expressionEvidence =
          expressionAdmissionEvidenceSchema.parse(value);
      },
    },
  ],
  [
    '/evidence/duplication',
    {
      scenario: 'duplication',
      accept: (value: unknown) => {
        fixtureState.duplicationEvidence =
          workflowDuplicationEvidenceSchema.parse(value);
      },
    },
  ],
  [
    '/input-cases-evidence',
    {
      scenario: 'input-cases',
      accept: (value: unknown) => {
        fixtureState.inputCasesEvidence =
          workflowInputCasesEvidenceSchema.parse(value);
      },
    },
  ],
  [
    '/evidence/readonly',
    {
      scenario: 'readonly',
      accept: (value: unknown) => {
        fixtureState.readonlyEvidence = readonlyEvidenceSchema.parse(value);
      },
    },
  ],
  [
    '/evidence/schedule',
    {
      scenario: 'schedule',
      accept: (value: unknown) => {
        fixtureState.scheduleEvidence = scheduleEvidenceSchema.parse(value);
      },
    },
  ],
]);

export function handleEditorBrowserReceipt(
  input: EditorControlRequest,
): boolean {
  const { request, response, url } = input;
  if (
    request.method === 'POST' &&
    (url.pathname === '/browser-opened' || url.pathname === '/browser-disposed')
  ) {
    let body = '';
    request.on('data', (chunk: Buffer) => {
      body += chunk.toString();
      if (body.length > 128) request.destroy();
    });
    request.on('end', () => {
      try {
        const value: unknown = JSON.parse(body);
        if (
          typeof value !== 'object' ||
          value === null ||
          !('instanceId' in value) ||
          typeof value.instanceId !== 'string' ||
          !/^[a-f0-9-]{36}$/u.test(value.instanceId)
        )
          throw new Error('Invalid browser receipt');
        if (url.pathname === '/browser-opened') {
          fixtureState.browserWasOpened = true;
          openBrowserInstances.add(value.instanceId);
        } else if (!openBrowserInstances.delete(value.instanceId))
          throw new Error('Unknown browser receipt');
        response.writeHead(204).end();
      } catch {
        response.writeHead(400).end();
      }
    });
    return true;
  }
  return false;
}

export function handleEditorEvidenceReceipt(
  input: EditorControlRequest,
): boolean {
  const { request, response, url } = input;
  const receipt = editorEvidenceReceipts.get(url.pathname);
  if (request.method === 'POST' && receipt !== undefined) {
    let body = '';
    request.on('data', (chunk: Buffer) => {
      body += chunk.toString();
      if (body.length > 1_024) request.destroy();
    });
    request.on('end', () => {
      try {
        const value: unknown = JSON.parse(body);
        if (receipt.scenario !== scenario)
          throw new Error('Evidence does not match the selected scenario');
        receipt.accept(value);
        response.writeHead(204).end();
      } catch {
        response.writeHead(400).end();
      }
    });
    return true;
  }
  return false;
}
