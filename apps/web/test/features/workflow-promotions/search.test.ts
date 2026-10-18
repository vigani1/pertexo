import { expect, it } from 'vitest';
import {
  parsePromotionSearch,
  promotionSearch,
} from '@/features/workflow-promotions/search.public';
const workflowId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  versionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
it('retains exact version selections and drops malformed, repeated and unrelated URL state', () => {
  const selected = promotionSearch([{ workflowId, versionId }]);
  expect(parsePromotionSearch({ ...selected, secret: 'discard' })).toEqual(
    selected,
  );
  expect(
    parsePromotionSearch({
      selected: `wrong,${workflowId}:${versionId},${workflowId}:${workflowId}`,
    }),
  ).toEqual(selected);
  expect(parsePromotionSearch({ selected: { workflowId, versionId } })).toEqual(
    {},
  );
});
