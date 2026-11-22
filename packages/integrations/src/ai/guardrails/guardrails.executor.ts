import type { GuardrailsDiagnostics } from '@pertexo/node-sdk';
import type { NodeExecutorRegistration } from '@pertexo/node-sdk/server';
import { GUARDRAILS_STEP } from '@pertexo/workflow-model';
import type {
  GuardrailsConfig,
  GuardrailsInput,
} from './guardrails.schemas.js';
import { countInjectionMarkers } from './injection-markers.js';
import {
  countProhibitedTerms,
  normalizeGuardrailsText,
} from './literal-matching.js';
import { countPii } from './pii-patterns.js';

export const guardrailsExecutor: NodeExecutorRegistration = Object.freeze({
  executor: GUARDRAILS_STEP,
  execute(invocation) {
    const { checks } = invocation.config as GuardrailsConfig;
    const { text } = invocation.input as GuardrailsInput;
    const normalized = normalizeGuardrailsText(text);
    const reasons: GuardrailsDiagnostics = {};
    for (const check of checks) {
      if (check.kind === 'pii') countPii(normalized, reasons);
      else if (check.kind === 'prohibited_terms') {
        const count = countProhibitedTerms(normalized, check.terms);
        if (count > 0) reasons['terms.prohibited'] = count;
      } else {
        const count = countInjectionMarkers(normalized);
        if (count > 0) reasons['injection.marker'] = count;
      }
    }
    invocation.runtime?.observeGuardrailsDiagnostics?.(reasons);
    return Promise.resolve({
      selectedPort: Object.keys(reasons).length === 0 ? 'pass' : 'fail',
    });
  },
} satisfies NodeExecutorRegistration);
