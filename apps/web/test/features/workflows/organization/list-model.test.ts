import { describe, expect, it } from 'vitest';
import {
  parseWorkflowListSearch,
  updateWorkflowListSearch,
} from '@/features/workflows/model/list-view';
import { workflowOrganizationControlsEnabled } from '@/features/workflows/model/organization/feature-gates';

const tagId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const folderId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('organization list URL scope', () => {
  it('keeps controls OFF outside the owned qualification build', () => {
    expect(workflowOrganizationControlsEnabled()).toBe(false);
  });
  it('normalizes literal filters and preserves explicit root versus all folders', () => {
    expect(
      parseWorkflowListSearch({
        query: '  Ops\t  ',
        tagId: tagId.toUpperCase(),
        folderId: 'root',
        favoritesOnly: 'true',
      }),
    ).toEqual({
      query: 'Ops\t',
      tagId,
      folderId: 'root',
      favoritesOnly: 'true',
    });
    expect(parseWorkflowListSearch({ folderId })).toEqual({ folderId });
    expect(parseWorkflowListSearch({ folderId: null })).toEqual({});
  });
  it('drops malformed fields independently without erasing valid scope', () => {
    expect(
      parseWorkflowListSearch({
        query: 'é'.repeat(65),
        tagId,
        folderId: '../private',
        favoritesOnly: false,
        view: 'archived',
      }),
    ).toEqual({ tagId, view: 'archived' });
  });
  it('preserves every organization filter through sorting, archive view and creation', () => {
    const filters = {
      query: 'Ops',
      tagId,
      folderId,
      favoritesOnly: 'true' as const,
    };
    expect(
      updateWorkflowListSearch(filters, {
        sort: 'created',
        view: 'archived',
        create: true,
      }),
    ).toEqual({ ...filters, sort: 'created', view: 'archived', create: true });
    expect(
      updateWorkflowListSearch(
        { ...filters, view: 'archived', sort: 'created', create: true },
        { view: 'active', sort: 'updated', create: false },
      ),
    ).toEqual(filters);
  });
  it('adapts JSON-decoded URL scalars without changing strict HTTP inputs', () => {
    expect(
      parseWorkflowListSearch({ query: 123, favoritesOnly: true }),
    ).toEqual({ query: '123', favoritesOnly: 'true' });
    expect(
      parseWorkflowListSearch({ query: false, favoritesOnly: false }),
    ).toEqual({ query: 'false' });
  });
  it('clears selected filters explicitly and retains unrelated URL state', () => {
    expect(
      updateWorkflowListSearch(
        {
          query: 'Ops',
          tagId,
          folderId: 'root',
          favoritesOnly: 'true',
          view: 'all',
          sort: 'created',
        },
        { tagId: null, folderId: null },
      ),
    ).toEqual({
      query: 'Ops',
      favoritesOnly: 'true',
      view: 'all',
      sort: 'created',
    });
    expect(
      updateWorkflowListSearch(
        { query: 'Ops', tagId, folderId, favoritesOnly: 'true' },
        { query: null, tagId: null, folderId: null, favoritesOnly: null },
      ),
    ).toEqual({});
  });
});
