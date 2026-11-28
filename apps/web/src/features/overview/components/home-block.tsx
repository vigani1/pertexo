import {
  InlineFailedRead,
  QueryView,
} from '@/components/patterns/states/query-view';
import { SkeletonLines } from '@/components/patterns/states/loading';
import { RuleHeading } from '@/components/patterns/lists/rule-heading';
import type { ReactNode } from 'react';
import { describeReadError } from '@/lib/api/error-copy';
import type { HomeBlockState } from '../model/home-block-state';

/**
 * One Home block with its own recovery: spooling threads while it loads, a
 * retry when its read fails, and an amber "as of" line when a refresh fails
 * but older results are still worth showing. Blocks never fail together.
 */
export function HomeBlock({
  title,
  headingId,
  count,
  actions,
  state,
  children,
}: Readonly<{
  title: string;
  headingId: string;
  count?: number | undefined;
  actions?: ReactNode;
  state: HomeBlockState;
  children: ReactNode;
}>) {
  return (
    <section aria-labelledby={headingId} className="min-w-0">
      <div className="mb-2 flex items-center justify-between gap-3">
        <RuleHeading id={headingId} count={count}>
          {title}
        </RuleHeading>
        {actions}
      </div>
      <HomeBlockBody title={title} state={state}>
        {children}
      </HomeBlockBody>
    </section>
  );
}

export function HomeBlockBody({
  title,
  state,
  children,
}: Readonly<{ title: string; state: HomeBlockState; children: ReactNode }>) {
  return (
    <QueryView
      query={{
        data: state.hasData ? children : undefined,
        isPending: state.pending,
        isError: state.failed,
        isFetching: state.retrying,
        error: state.error,
        dataUpdatedAt: state.updatedAt,
        refetch: state.onRetry,
      }}
      resource={title}
      loading={
        <SkeletonLines
          label={`Loading ${title.toLowerCase()}`}
          lines={3}
          divided
          className="py-5"
        />
      }
      error={(failure) => (
        <div className="border-t border-surface-ink/6 py-4">
          <InlineFailedRead
            {...failure}
            text={describeReadError(failure.error, title)}
          />
        </div>
      )}
    >
      {(content) => content}
    </QueryView>
  );
}
