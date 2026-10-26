import type {
  collectionEvidenceSchema,
  dateEvidenceSchema,
} from '../evidence/transforms/qualification.js';
import type { apiTokensEvidenceSchema } from '../evidence/api-tokens/qualification.js';
import type { failureRoutingEvidenceSchema } from '../evidence/failure-routing.js';

import type { z } from 'zod';

import type { createEditorHttpControl } from '../http-control.js';
import type { callsEvidenceSchema } from '../evidence/calls.js';
import type { callableEvidenceSchema } from '../evidence/callable.js';
import type { httpEffectsSchema } from '../evidence/http.js';

import type {
  scheduleEvidenceSchema,
  scheduleScopeSchema,
} from '../evidence/schedule.js';
import type {
  prepareReadonlyEvidence,
  readonlyEvidenceSchema,
} from '../evidence/readonly.js';
import type { expressionAdmissionEvidenceSchema } from '../evidence/expression-admission.js';
import type {
  receiptRecoveryEvidenceSchema,
  runRecoveryEvidenceSchema,
} from '../evidence/recovery.js';
import type { workflowDuplicationEvidenceSchema } from '../evidence/duplication.js';
import type {
  prepareWorkflowPortabilityBrowserFixture,
  workflowPortabilityBrowserEvidenceSchema,
} from '../portability.fixture.js';
import type { workflowInputCasesEvidenceSchema } from '../evidence/input-cases.js';
import type {
  prepareCuratedTemplateBrowserFixture,
  curatedTemplateBrowserEvidenceSchema,
} from '../../curated-templates/fixture.js';
import type { curatedTemplateEffectsSchema } from '../../curated-templates/worker-evidence.js';
import type { browserEvidenceSchema } from './environment.js';
import type { DeliveredEmail } from '../evidence/notifications/email-attachments.js';

export const fixtureState: EditorBrowserFixtureState = {
  browserWasOpened: false,
  collectionEvidence: undefined,
  dateEvidence: undefined,
  apiTokensEvidence: undefined,
  failureRoutingEvidence: undefined,
  httpControl: undefined,
  httpEffects: undefined,
  curatedEffects: undefined,
  curatedFixture: undefined,
  curatedEvidence: undefined,
  evidence: undefined,
  duplicationEvidence: undefined,
  portabilityFixture: undefined,
  portabilityEvidence: undefined,
  inputCasesEvidence: undefined,
  callsEvidence: undefined,
  callableEvidence: undefined,
  receiptEvidence: undefined,
  runRecoveryEvidence: undefined,
  expressionEvidence: undefined,
  readonlyFixture: undefined,
  readonlyEvidence: undefined,
  readonlySetupPending: false,
  scheduleEvidence: undefined,
  scheduleRestart: undefined,
  scheduleRestartUsed: false,
};

export const noticeMessages: string[] = [];

export const emailDeliveries: DeliveredEmail[] = [];

interface EditorBrowserFixtureState {
  browserWasOpened: boolean;
  collectionEvidence: z.infer<typeof collectionEvidenceSchema> | undefined;
  dateEvidence: z.infer<typeof dateEvidenceSchema> | undefined;
  apiTokensEvidence: z.infer<typeof apiTokensEvidenceSchema> | undefined;
  failureRoutingEvidence:
    z.infer<typeof failureRoutingEvidenceSchema> | undefined;
  httpControl: ReturnType<typeof createEditorHttpControl> | undefined;
  httpEffects: z.infer<typeof httpEffectsSchema> | undefined;
  curatedEffects: z.infer<typeof curatedTemplateEffectsSchema> | undefined;
  curatedFixture:
    | Awaited<ReturnType<typeof prepareCuratedTemplateBrowserFixture>>
    | undefined;
  curatedEvidence:
    z.infer<typeof curatedTemplateBrowserEvidenceSchema> | undefined;
  evidence: z.infer<typeof browserEvidenceSchema> | undefined;
  duplicationEvidence:
    z.infer<typeof workflowDuplicationEvidenceSchema> | undefined;
  portabilityFixture:
    | Awaited<ReturnType<typeof prepareWorkflowPortabilityBrowserFixture>>
    | undefined;
  portabilityEvidence:
    z.infer<typeof workflowPortabilityBrowserEvidenceSchema> | undefined;
  inputCasesEvidence:
    z.infer<typeof workflowInputCasesEvidenceSchema> | undefined;
  callsEvidence: z.infer<typeof callsEvidenceSchema> | undefined;
  callableEvidence: z.infer<typeof callableEvidenceSchema> | undefined;
  receiptEvidence: z.infer<typeof receiptRecoveryEvidenceSchema> | undefined;
  runRecoveryEvidence: z.infer<typeof runRecoveryEvidenceSchema> | undefined;
  expressionEvidence:
    z.infer<typeof expressionAdmissionEvidenceSchema> | undefined;
  readonlyFixture:
    Awaited<ReturnType<typeof prepareReadonlyEvidence>> | undefined;
  readonlyEvidence: z.infer<typeof readonlyEvidenceSchema> | undefined;
  readonlySetupPending: boolean;
  scheduleEvidence: z.infer<typeof scheduleEvidenceSchema> | undefined;
  scheduleRestart:
    | {
        scope: z.infer<typeof scheduleScopeSchema>;
        triggerId: string;
        nextFireAt: string;
        requestId: string;
      }
    | undefined;
  scheduleRestartUsed: boolean;
}
