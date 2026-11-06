import {
  workspaceVariableValuesSchema,
  workspaceVariableDescriptionsSchema,
} from '@pertexo/workflow-model';
import { decodeStoredValue } from '../shared/stored-values.js';

/** Settings and pinned execution revisions share the same stored scalar boundary. */
export function decodeStoredVariableSet(
  stored: Readonly<{ values: unknown; descriptions: unknown }>,
) {
  return decodeStoredValue(() => ({
    values: workspaceVariableValuesSchema.parse(stored.values),
    descriptions: workspaceVariableDescriptionsSchema.parse(
      stored.descriptions,
    ),
  }));
}
