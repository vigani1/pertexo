import { z } from 'zod';

export const CORE_SWITCH_CASE_PORTS = Object.freeze([
  'case-01',
  'case-02',
  'case-03',
  'case-04',
  'case-05',
  'case-06',
  'case-07',
  'case-08',
  'case-09',
  'case-10',
  'case-11',
  'case-12',
  'case-13',
  'case-14',
  'case-15',
  'case-16',
] as const);

export const CORE_SWITCH_CASE_PORT_SCHEMA = z.enum(CORE_SWITCH_CASE_PORTS);
export const CORE_SWITCH_SELECTED_PORT_SCHEMA = z.enum([
  ...CORE_SWITCH_CASE_PORTS,
  'default',
]);
export const CORE_SWITCH_SCALAR_SCHEMA = z.union([
  z.null(),
  z.boolean(),
  z.number(),
  z.string().max(1_024),
]);
export const CORE_SWITCH_CONFIG_SCHEMA = z
  .object({
    cases: z
      .array(
        z
          .object({
            id: CORE_SWITCH_CASE_PORT_SCHEMA,
            equals: CORE_SWITCH_SCALAR_SCHEMA,
          })
          .strict(),
      )
      .min(1)
      .max(CORE_SWITCH_CASE_PORTS.length),
  })
  .strict()
  .superRefine(({ cases }, context) => {
    if (new Set(cases.map(({ id }) => id)).size !== cases.length)
      context.addIssue({
        code: 'custom',
        path: ['cases'],
        message: 'Switch case IDs must be unique',
      });
  });
export const CORE_SWITCH_INPUT_SCHEMA = z
  .object({ value: CORE_SWITCH_SCALAR_SCHEMA })
  .strict();
export const CORE_SWITCH_OUTPUT_SCHEMA = z
  .object({ selectedPort: CORE_SWITCH_SELECTED_PORT_SCHEMA })
  .strict();

export type CoreSwitchConfig = Readonly<
  z.output<typeof CORE_SWITCH_CONFIG_SCHEMA>
>;
export type CoreSwitchInput = Readonly<
  z.output<typeof CORE_SWITCH_INPUT_SCHEMA>
>;
