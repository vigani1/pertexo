export const firstId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const secondId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const tag = { id: firstId, key: 'ops', revision: 1 };
export const organization = {
  tags: [tag],
  organizationRevision: 1,
  folderId: null,
  isFavorite: false,
};
export const identifierAt = (index: number) =>
  `${index.toString(16).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
