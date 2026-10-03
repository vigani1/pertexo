import { describe, expect, it } from 'vitest';
import { versionSourceWorkflowPageState } from '@/features/workflow-editor/model/inspector/version-source-pagination';

describe('version source workflow pagination', () => {
  it('does not imply absence before any page has arrived', () => {
    expect(versionSourceWorkflowPageState([], [])).toMatchObject({
      canLoadMore: false,
      problem: undefined,
    });
  });
  it('allows a next cursor while reporting an incomplete list', () => {
    expect(
      versionSourceWorkflowPageState(
        [{ items: [], nextCursor: 'next' }],
        [null],
      ),
    ).toEqual({ canLoadMore: true, incomplete: true, problem: undefined });
  });
  it('stops a repeated cursor without claiming complete discovery', () => {
    const state = versionSourceWorkflowPageState(
      [{ items: [], nextCursor: 'same' }],
      [null, 'same'],
    );
    expect(state).toMatchObject({
      canLoadMore: false,
      incomplete: true,
    });
    expect(state.problem).toContain('repeated cursor');
  });
  it('stops after forty pages without discarding loaded sources or claiming absence', () => {
    const pages = Array.from({ length: 40 }, () => ({
      items: [],
      nextCursor: 'next',
    }));
    const state = versionSourceWorkflowPageState(pages, [null]);
    expect(state).toMatchObject({
      canLoadMore: false,
      incomplete: true,
    });
    expect(state.problem).toContain('40-page limit');
    expect(pages).toHaveLength(40);
  });
  it('calls discovery complete only after a terminal page', () => {
    expect(
      versionSourceWorkflowPageState([{ items: [], nextCursor: null }], [null]),
    ).toEqual({ canLoadMore: false, incomplete: false, problem: undefined });
  });
});
