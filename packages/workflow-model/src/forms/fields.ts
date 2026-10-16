import { storageTextSchema } from '../json/text.js';
import { inspectJsonValue } from '../json/canonical.js';
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
export const formFieldSchema = z.discriminatedUnion('type', [
  field
    .extend({
      type: z.enum(['text', 'textarea', 'email', 'number', 'boolean', 'date']),
    })
    .strict(),
  field
    .extend({
      type: z.enum(['select', 'multi_select']),
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
    })
    .strict(),
]);
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
    title: storageTextSchema.trim().min(1).max(160).default('Send a request'),
    instructions: storageTextSchema.max(2_000).default(''),
    thankYouMessage: formThankYouMessageSchema.exactOptional(),
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
