import { useEffect, useRef } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { DataTableDefinition } from '@pertexo/contracts';
import type { DataTableQuery } from '@pertexo/node-sdk';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';
import { describeCommandError } from '@/lib/api/error-copy';
import { isApiError } from '@/lib/api/error';
import { exportRows, type TableScope } from '../../data/tables.api';
import { downloadTableCsv } from '../../model/export';

export function ExportTableRows({
  scope,
  table,
  query,
}: Readonly<{
  scope: TableScope;
  table: DataTableDefinition;
  query: DataTableQuery;
}>) {
  const request = useRef<AbortController | undefined>(undefined);
  useEffect(
    () => () => {
      request.current?.abort();
    },
    [scope.apiClient, scope.userId, scope.workspaceId, table.id],
  );
  const download = useMutation({
    mutationFn: async (filtered: boolean) => {
      if (request.current !== undefined) return;
      const controller = new AbortController();
      request.current = controller;
      try {
        const result = await exportRows(
          scope,
          table.id,
          {
            filters: filtered ? query.filters : [],
            ...(query.sort === undefined ? {} : { sort: query.sort }),
          },
          controller.signal,
        );
        if (!controller.signal.aborted)
          downloadTableCsv(table.name, result.csv);
      } catch (cause) {
        if (!controller.signal.aborted) throw cause;
      } finally {
        if (request.current === controller) request.current = undefined;
      }
    },
    retry: false,
  });
  const error =
    download.error === null
      ? undefined
      : isApiError(download.error)
        ? (download.error.problem?.detail ??
          describeCommandError(download.error, 'exporting this table'))
        : describeCommandError(download.error, 'exporting this table');
  return (
    <>
      <Button
        type="button"
        variant="outline"
        disabled={download.isPending}
        onClick={() => {
          download.mutate(false);
        }}
      >
        {download.isPending ? 'Preparing CSV…' : 'Export all rows'}
      </Button>
      {query.filters.length === 0 ? null : (
        <Button
          type="button"
          variant="outline"
          disabled={download.isPending}
          onClick={() => {
            download.mutate(true);
          }}
        >
          Export filtered rows
        </Button>
      )}
      {error === undefined ? null : <Notice tone="warning">{error}</Notice>}
    </>
  );
}
