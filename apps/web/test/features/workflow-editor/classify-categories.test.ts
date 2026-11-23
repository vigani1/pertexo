import { expect, it } from 'vitest';
import { validateClassifyCategoryEdit } from '@/features/workflow-editor/model/classify-categories';

const billing = {
  id: 'category-01',
  label: 'Billing',
  description: 'Payments and invoices',
} as const;
const access = {
  id: 'category-02',
  label: 'Access',
  description: 'Sign-in and permissions',
} as const;
const categories = [billing, access];

it('trims valid category edits and reports a label collision on the edited row', () => {
  expect(
    validateClassifyCategoryEdit(categories, billing, 'label', '  Orders  '),
  ).toEqual({
    ok: true,
    value: 'Orders',
  });
  expect(
    validateClassifyCategoryEdit(categories, billing, 'label', ' aCCESS '),
  ).toEqual({
    ok: false,
    reason: 'duplicate',
  });
});
