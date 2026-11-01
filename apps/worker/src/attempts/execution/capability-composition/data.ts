import { createRunValuesStore } from '@pertexo/core/runs';
import { createRunValuesRuntime } from '../run-values.js';
import { createWorkerDataTablesStore } from '@pertexo/core/data-tables';

import type { CapabilityAssembly } from './contract.js';
import { assertCapabilityRuntimeOpen } from './lifecycle.js';

export function prepareRunValuesCapability(state: CapabilityAssembly): void {
  const runValues =
    state.dependencies.runValues ??
    (state.resources.ownedRunValues = createRunValuesStore(
      state.options.database,
      state.dependencies.databaseRuntime,
    ));
  state.factories.runValues = (context) =>
    createRunValuesRuntime(runValues, context, () => {
      assertCapabilityRuntimeOpen(state.lifecycle);
    });
}

export function prepareDataTablesCapability(state: CapabilityAssembly): void {
  const dataTables =
    state.dependencies.dataTables ??
    (state.resources.ownedDataTables = createWorkerDataTablesStore(
      state.options.database,
      state.dependencies.databaseRuntime,
    ));
  state.factories.dataTables = (context) => ({
    execute: ({ command, columnBindings, signal }) => {
      assertCapabilityRuntimeOpen(state.lifecycle);
      return dataTables.execute({
        ...context,
        command,
        ...(columnBindings === undefined ? {} : { columnBindings }),
        signal,
      });
    },
  });
}
