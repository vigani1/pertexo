import { expect, it } from 'vitest';
import { reviewTableBindings } from '@/features/workflow-editor/model/inspector/table-bindings';

it('preserves stable aliases on review and gives colliding newly added names a distinct alias', () => {
  expect(
    reviewTableBindings(
      [
        { id: 'first', name: 'renamed', type: 'text', required: true },
        { id: 'new', name: 'original', type: 'text', required: false },
      ],
      { original: 'first', removed: 'gone' },
    ),
  ).toEqual({ original: 'first', original_2: 'new' });
  expect(
    reviewTableBindings(
      [{ id: 'col_new', name: 'amount', type: 'number', required: false }],
      {},
    ),
  ).toEqual({ amount: 'col_new' });
});
