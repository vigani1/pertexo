import { Empty, EmptyDescription, EmptyTitle } from '@/components/ui/empty';
import { PageHeader, PageHeaderTitle } from './page-header';

/**
 * A page the person can't use right now: its header stays so they know
 * where they are, and one empty state says why.
 */
export function UnavailablePage({
  heading,
  title,
  description,
}: Readonly<{ heading: string; title: string; description: string }>) {
  return (
    <div className="flex flex-col gap-8">
      <PageHeader>
        <PageHeaderTitle>{heading}</PageHeaderTitle>
      </PageHeader>
      <Empty>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </Empty>
    </div>
  );
}
