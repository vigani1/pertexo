import { createContext } from 'react';
import type { ConnectionMutationScope } from '@/features/connections/add-connection.public';

/**
 * Where a step's connection slot creates a new connection in place: the
 * workspace and its name (for the suggested connection name). Null when
 * this person can't manage connections, so slots offer no "New" action.
 */
export type AddConnectionScope = Readonly<{
  scope: ConnectionMutationScope;
  workspaceName: string;
}>;

export const AddConnectionContext = createContext<AddConnectionScope | null>(
  null,
);
