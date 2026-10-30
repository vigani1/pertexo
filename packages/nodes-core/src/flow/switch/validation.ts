import {
  SWITCH_CASE_PORTS,
  switchConfigSchema,
  switchScalarSchema,
} from '@pertexo/workflow-model';
import { z } from 'zod';

export const CORE_SWITCH_SELECTED_PORT_SCHEMA = z.enum([
  ...SWITCH_CASE_PORTS,
  'default',
]);
export const CORE_SWITCH_CONFIG_SCHEMA = switchConfigSchema;
export const CORE_SWITCH_INPUT_SCHEMA = z
  .object({ value: switchScalarSchema })
  .strict();
export const CORE_SWITCH_OUTPUT_SCHEMA = z
  .object({ selectedPort: CORE_SWITCH_SELECTED_PORT_SCHEMA })
  .strict();

export type CoreSwitchInput = Readonly<
  z.output<typeof CORE_SWITCH_INPUT_SCHEMA>
>;
