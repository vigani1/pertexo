import { eventCoordinationPolicySchema } from '../event-coordination/contract.js';
import { formRedirectUrlSchema } from './links.js';
import { storageTextSchema } from '../../values/json/text.js';
import { inspectJsonValue } from '../../values/json/canonical.js';
import { FORM_FILE_LIMITS, formFileGroupSchema } from './files.js';
import { z } from 'zod';

export const FORM_LIMITS = Object.freeze({
  fields: 20,
  thankYouCharacters: 1_000,
  schemaBytes: 10_240,
  options: 50,
  textCharacters: 10_000,
  submissionBytes: 65_536,
});
const field = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u),
  name: z
    .string()
    .regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/u)
    .refine(
      (name) => !['constructor', 'prototype', '__proto__'].includes(name),
      'Choose a different field name.',
    ),
  label: storageTextSchema.trim().min(1).max(160),
  help: storageTextSchema.max(500).default(''),
  required: z.boolean().default(true),
});
const choices = field.extend({
  options: z
    .array(
      storageTextSchema
        .trim()
        .min(1)
        .max(160)
        .regex(/^[^\r\n]*$/u, 'Keep each option on one line.'),
    )
    .min(1)
    .max(FORM_LIMITS.options)
    .refine(
      (options) => new Set(options).size === options.length,
      'Choose each option once.',
    ),
});
export const formFieldSchema = z
  .discriminatedUnion('type', [
    field
      .extend({
        type: z.enum(['text', 'textarea', 'email', 'number', 'date']),
      })
      .strict(),
    field
      .extend({
        type: z.literal('boolean'),
        // A consent box: only a tick is accepted. Plain yes/no keeps "no".
        mustBeTicked: z.boolean().exactOptional(),
      })
      .strict(),
    choices.extend({ type: z.literal('select') }).strict(),
    field
      .extend({
        type: z.literal('file'),
        accept: z
          .array(formFileGroupSchema)
          .min(1, 'Choose at least one kind of file.')
          .refine(
            (groups) => new Set(groups).size === groups.length,
            'Choose each kind of file once.',
          ),
        maxFiles: z
          .number()
          .int()
          .min(1)
          .max(FORM_FILE_LIMITS.maxFiles)
          .default(FORM_FILE_LIMITS.defaultMaxFiles),
        maxBytes: z
          .number()
          .int()
          .min(1)
          .max(FORM_FILE_LIMITS.maxBytes, 'Keep each file within 10 MB.')
          .default(FORM_FILE_LIMITS.defaultMaxBytes),
      })
      .strict(),
    choices
      .extend({
        type: z.literal('multi_select'),
        minSelections: z
          .number()
          .int()
          .min(0)
          .max(FORM_LIMITS.options)
          .exactOptional(),
        maxSelections: z
          .number()
          .int()
          .min(1)
          .max(FORM_LIMITS.options)
          .exactOptional(),
      })
      .strict(),
  ])
  .superRefine((value, context) => {
    if (value.type !== 'multi_select') return;
    const minimum = Math.max(value.required ? 1 : 0, value.minSelections ?? 0);
    const maximum = value.maxSelections ?? value.options.length;
    if (minimum > maximum || maximum > value.options.length)
      context.addIssue({
        code: 'custom',
        path: ['minSelections'],
        message:
          'Selection limits must fit the available options, with minimum no greater than maximum.',
      });
  });
export const formFieldsSchema = z
  .array(formFieldSchema)
  .min(1)
  .max(FORM_LIMITS.fields)
  .refine(
    (fields) => new Set(fields.map(({ name }) => name)).size === fields.length,
    'Field names must be unique.',
  )
  .refine(
    (fields) => new Set(fields.map((field) => field.id)).size === fields.length,
    'Field identities must be unique.',
  )
  .refine(
    (fields) => inspectJsonValue(fields).bytes <= FORM_LIMITS.schemaBytes,
    'Keep field definitions within 10 KB; shorten help text or options.',
  );
export const DEFAULT_FORM_THANK_YOU_MESSAGE = 'Thanks for your response.';
export const formThankYouMessageSchema = storageTextSchema
  .trim()
  .min(1)
  .max(FORM_LIMITS.thankYouCharacters);
export const formConfigSchema = z
  .object({
    coordination: eventCoordinationPolicySchema.exactOptional(),
    title: storageTextSchema.trim().min(1).max(160).default('Send a request'),
    instructions: storageTextSchema.max(2_000).default(''),
    thankYouMessage: formThankYouMessageSchema.exactOptional(),
    redirectUrl: formRedirectUrlSchema.exactOptional(),
    fields: formFieldsSchema.default([
      {
        id: 'field-1',
        name: 'message',
        label: 'Message',
        type: 'textarea',
        help: '',
        required: true,
      },
    ]),
  })
  .strict();
export type FormField = z.output<typeof formFieldSchema>;
export type FormConfig = z.output<typeof formConfigSchema>;
