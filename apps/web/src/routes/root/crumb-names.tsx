import { useQuery } from '@tanstack/react-query';
import { tablesQuery } from '@/features/data-tables/picker.public';
import { taskQueryOptions } from '@/features/pending-tasks/queries.public';
import type { NameScope } from './breadcrumbs';

/** A request named by its title, from the read its page already makes. */
export function RequestName({
  scope,
  workspaceId,
  taskId,
}: Readonly<{ scope: NameScope; workspaceId: string; taskId: string }>) {
  const task = useQuery(taskQueryOptions({ ...scope, workspaceId }, taskId))
    .data?.task;
  return task?.title ?? 'Request';
}

/** A table named by its name, from the list its page already reads. */
export function TableName({
  scope,
  workspaceId,
  tableId,
}: Readonly<{ scope: NameScope; workspaceId: string; tableId: string }>) {
  const table = useQuery(
    tablesQuery({ ...scope, workspaceId }),
  ).data?.tables.find((item) => item.id === tableId);
  return table?.name ?? 'Data table';
}
