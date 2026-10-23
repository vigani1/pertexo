import { formFieldsSchema } from '../../src/index.js';
export const fields = formFieldsSchema.parse(
  [
    { name: 'name', label: 'Name', type: 'text' },
    { name: 'notes', label: 'Notes', type: 'textarea', required: false },
    { name: 'amount', label: 'Amount', type: 'number' },
    { name: 'checked', label: 'Checked', type: 'boolean' },
    {
      name: 'currency',
      label: 'Currency',
      type: 'select',
      options: ['USD', 'EUR'],
    },
    { name: 'date', label: 'Date', type: 'date' },
  ].map((field, index) => ({ ...field, id: `field-${String(index)}` })),
);
export const values = {
  name: '  Alice  ',
  amount: 0,
  checked: false,
  currency: 'EUR',
  date: '2024-02-29',
};
export const multiple = formFieldsSchema.parse([
  {
    id: 'required',
    name: 'channels',
    label: 'Channels',
    type: 'multi_select',
    options: ['Email', 'SMS'],
  },
  {
    id: 'optional',
    name: 'extras',
    label: 'Extras',
    type: 'multi_select',
    required: false,
    options: ['A', 'B'],
  },
  { id: 'text', name: 'note', label: 'Note', type: 'text', required: false },
]);
