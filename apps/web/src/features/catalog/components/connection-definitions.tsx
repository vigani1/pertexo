import type { ReactNode } from 'react';
import type { ConnectionFormDefinition } from '@pertexo/contracts';
import { ConnectionDefinitionsContext } from '../hooks/connection-definitions';

const NO_CONNECTIONS: readonly ConnectionFormDefinition[] = [];

export function ConnectionDefinitions({
  items,
  children,
}: Readonly<{
  items: readonly ConnectionFormDefinition[] | undefined;
  children: ReactNode;
}>) {
  return (
    <ConnectionDefinitionsContext value={items ?? NO_CONNECTIONS}>
      {children}
    </ConnectionDefinitionsContext>
  );
}
