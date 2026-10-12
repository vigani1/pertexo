import { useQuery } from '@tanstack/react-query';
import { CURATED_WORKFLOW_TEMPLATES } from '@pertexo/templates';
import { Button } from '@/components/ui/button';
import { authoringCatalogQueryOptions } from '@/features/catalog/queries.public';
import type { ApiClient } from '@/lib/api/client';
import { cn } from '@/lib/utils';
import {
  templateUnavailableReasons,
  type CuratedTemplate,
} from '../../model/templates/curated-setup';
import { PatternGlyph } from '../pattern-glyph';

/**
 * Ready-made workflows, each drawn as its own thread: one line on what it
 * does, and what it takes and touches folded under Details.
 */
export function CuratedTemplateChoice({
  apiClient,
  userId,
  disabled,
  selectedId,
  onChoose,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  disabled: boolean;
  selectedId: string | undefined;
  onChoose: (template: CuratedTemplate) => void;
}>) {
  const catalog = useQuery({
    ...authoringCatalogQueryOptions(apiClient, userId),
    staleTime: 0,
  });
  return (
    <section
      aria-label="Curated workflow examples"
      className="flex flex-col gap-2"
    >
      {catalog.isError ? (
        <p className="flex items-center gap-2 text-sm text-warning">
          Couldn’t check which steps are available.
          <Button
            variant="link"
            size="sm"
            onClick={() => void catalog.refetch()}
          >
            Retry current catalog
          </Button>
        </p>
      ) : null}
      {CURATED_WORKFLOW_TEMPLATES.map((template) => {
        const reasons = templateUnavailableReasons(
          template,
          catalog.isError ? undefined : catalog.data?.definitions,
        );
        const selected = template.templateId === selectedId;
        const unavailable =
          disabled || catalog.isFetching || reasons.length > 0;
        return (
          <article
            key={template.templateId}
            aria-label={template.title}
            className={cn(
              'grid grid-cols-[8.25rem_minmax(0,1fr)] items-center gap-x-3 gap-y-2 rounded-lg border p-2.5 transition-colors motion-reduce:transition-none',
              selected
                ? 'border-primary/45 bg-primary/[0.06]'
                : 'border-border bg-white/[0.02] hover:border-border-strong',
            )}
          >
            <span
              aria-hidden="true"
              className="row-span-2 grid place-items-center self-start rounded-md bg-black/25 py-2"
            >
              <PatternGlyph graph={template.manifest.graph} />
            </span>
            <div className="flex min-w-0 items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 className="text-sm font-semibold text-foreground">
                  {template.title}
                </h3>
                <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                  {template.description}
                </p>
              </div>
              <Button
                variant={selected ? 'default' : 'outline'}
                size="sm"
                aria-label={`Set up ${template.title}`}
                aria-pressed={selected}
                disabled={unavailable}
                className="shrink-0"
                onClick={() => {
                  onChoose(template);
                }}
              >
                {selected ? 'Chosen' : 'Use'}
              </Button>
            </div>
            <div className="col-start-2 flex min-w-0 flex-col gap-1">
              {reasons.map((reason) => (
                <p key={reason} className="text-xs text-warning">
                  {reason}
                </p>
              ))}
              <details className="group/details text-xs text-muted-foreground">
                <summary className="w-fit cursor-pointer rounded-sm text-subtle-foreground outline-none select-none hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
                  Details
                </summary>
                <dl className="mt-1.5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
                  <dt className="text-subtle-foreground">Input</dt>
                  <dd>{template.inputSummary}</dd>
                  <dt className="text-subtle-foreground">Limits</dt>
                  <dd>{template.boundsSummary}</dd>
                  <dt className="text-subtle-foreground">Effects</dt>
                  <dd>{template.effectsSummary}</dd>
                </dl>
              </details>
            </div>
          </article>
        );
      })}
    </section>
  );
}
