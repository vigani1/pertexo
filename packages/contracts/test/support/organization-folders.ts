export const a = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const b = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const idAt = (index: number) =>
  `${index.toString(16).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
export const folder = {
  id: a,
  name: 'Ops',
  parentId: null,
  revision: 1,
  depth: 1,
};
export const items = [
  { workflowId: b, expectedOrganizationRevision: 2 },
  { workflowId: a, expectedOrganizationRevision: 1 },
];
