import { createContext, useContext } from 'react';
import type { ConnectionFormDefinition } from '@pertexo/contracts';

export const ConnectionDefinitionsContext = createContext<
  readonly ConnectionFormDefinition[]
>([]);

export function useConnectionDefinitions() {
  return useContext(ConnectionDefinitionsContext);
}
