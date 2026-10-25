import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import type { DataTableDefinition } from '@pertexo/contracts';
import { RowsGrid } from '@/features/data-tables/components/rows/grid';
import { RowsPager } from '@/features/data-tables/components/rows/pager';
import { TableCollection } from '@/features/data-tables/components/overview';

const table: DataTableDefinition = {
  id: '01900000-0000-7000-8000-000000000001',
  name: 'Orders',
  revision: 1,
  keyColumn: null,
  hasRemovedColumns: false,
  storedBytes: 0,
  rowCount: 0,
  columns: [],
};
const noop = () => undefined;
it('gives the empty table collection a next step', () => {
  render(
    <TableCollection tables={[]} rowLimit={100} workspaceId="workspace" />,
  );
  expect(screen.getByRole('heading', { name: 'No tables yet' })).toBeVisible();
  expect(screen.getByText(/Create a table to keep orders/)).toBeVisible();
});
it('distinguishes empty tables, filters and an empty page after rows disappear', () => {
  const props = {
    table,
    page: { rows: [], affected: 0, hasMore: false },
    pending: false,
    editable: true,
    locked: false,
    onEdit: noop,
    onDelete: noop,
  };
  const { rerender } = render(<RowsGrid {...props} filtered={false} />);
  expect(
    screen.getByText('No rows yet. Add a row or import CSV to start.'),
  ).toBeVisible();
  rerender(<RowsGrid {...props} filtered />);
  expect(
    screen.getByText('No rows match this filter. Try a different filter.'),
  ).toBeVisible();
  rerender(
    <RowsGrid {...props} table={{ ...table, rowCount: 3 }} filtered={false} />,
  );
  expect(screen.getByText(/No rows on this page/)).toBeVisible();
});
it('uses readable empty and filtered footer counts', () => {
  const props = {
    table,
    query: { filters: [], limit: 50, offset: 0 },
    shown: 0,
    pending: false,
    hasMore: false,
    onPrevious: noop,
    onNext: noop,
  };
  const { rerender } = render(<RowsPager {...props} />);
  expect(screen.getByText('0 rows total')).toBeVisible();
  rerender(
    <RowsPager
      {...props}
      query={{
        ...props.query,
        filters: [{ column: 'name', operator: 'equals', value: 'absent' }],
      }}
    />,
  );
  expect(screen.getByText('0 matching rows')).toBeVisible();
});
