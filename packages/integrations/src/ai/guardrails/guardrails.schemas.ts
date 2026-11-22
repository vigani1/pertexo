import { MODEL_IDENTIFIER_MAX_CHARACTERS } from '@pertexo/node-sdk';
import { GUARDRAILS_PORTS } from '@pertexo/workflow-model';
import { z } from 'zod';
import { modelSettings } from '../model-settings.js';

export const GUARDRAILS_LIMITS = Object.freeze({
  textCharacters: 32_768,
  checks: 4,
  policyCharacters: 4_096,
  terms: 32,
  termCharacters: 100,
});

export const guardrailsTermsSchema = z
  .array(z.string().trim().min(1).max(GUARDRAILS_LIMITS.termCharacters))
  .max(GUARDRAILS_LIMITS.terms);

const piiCheck = z.strictObject({ kind: z.literal('pii') });
const injectionCheck = z.strictObject({ kind: z.literal('injection') });
const prohibitedTermsCheck = z.strictObject({
  kind: z.literal('prohibited_terms'),
  terms: guardrailsTermsSchema,
});

const modelCheckFields = {
  kind: z.literal('model'),
  model: modelSettings.model,
};
const injectionModelCheck = z.strictObject({
  ...modelCheckFields,
  mode: z.literal('injection'),
});
const guardrailsPolicySchema = z
  .string()
  .max(GUARDRAILS_LIMITS.policyCharacters);
const policyModelCheck = z.strictObject({
  ...modelCheckFields,
  mode: z.literal('policy'),
  policy: guardrailsPolicySchema.refine(
    (value) => value.trim() !== '',
    'Enter a policy for the Guardrails model check.',
  ),
});
const modelCheck = z.discriminatedUnion('mode', [
  injectionModelCheck,
  policyModelCheck,
]);

const checkSchema = z.discriminatedUnion('kind', [
  piiCheck,
  prohibitedTermsCheck.extend({
    terms: guardrailsTermsSchema.min(1, 'Enter at least one prohibited term.'),
  }),
  injectionCheck,
  modelCheck,
]);

const draftModelIdentifier = z.string().max(MODEL_IDENTIFIER_MAX_CHARACTERS);

export const guardrailsDraftChecksSchema = z
  .array(
    z.discriminatedUnion('kind', [
      piiCheck,
      prohibitedTermsCheck,
      injectionCheck,
      z.discriminatedUnion('mode', [
        injectionModelCheck.extend({ model: draftModelIdentifier }),
        policyModelCheck.extend({
          model: draftModelIdentifier,
          policy: guardrailsPolicySchema,
        }),
      ]),
    ]),
  )
  .max(GUARDRAILS_LIMITS.checks);

export const guardrailsConfigSchema = z.strictObject({
  checks: z
    .array(checkSchema)
    .min(1, 'Enable at least one Guardrails check.')
    .max(GUARDRAILS_LIMITS.checks)
    .refine(
      (checks) =>
        new Set(checks.map(({ kind }) => kind)).size === checks.length,
      'Enable each Guardrails check at most once.',
    )
    .default([{ kind: 'pii' }]),
});

export const guardrailsInputSchema = z.strictObject({
  text: z
    .string()
    .max(
      GUARDRAILS_LIMITS.textCharacters,
      'Mapped text exceeds the Guardrails character limit.',
    )
    .meta({ title: 'Text' }),
});

export const guardrailsOutputSchema = z.strictObject({
  selectedPort: z.enum(GUARDRAILS_PORTS),
});

export type GuardrailsCheck = z.output<typeof checkSchema>;
export type GuardrailsModelCheck = z.output<typeof modelCheck>;
export type GuardrailsInput = z.output<typeof guardrailsInputSchema>;
export type GuardrailsConfig = z.output<typeof guardrailsConfigSchema>;
