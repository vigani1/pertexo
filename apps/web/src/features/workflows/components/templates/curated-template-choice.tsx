import { useQuery } from '@tanstack/react-query';
import { CURATED_WORKFLOW_TEMPLATES } from '@pertexo/workflow-model/curated-templates';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';
import { authoringCatalogQueryOptions } from '@/features/catalog/queries.public';
import type { ApiClient } from '@/lib/api/client';
import {
  templateUnavailableReasons,
  type CuratedTemplate,
} from '../../model/curated-template-setup';

export function CuratedTemplateChoice({
  apiClient,
  userId,
  disabled,
  onChoose,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  disabled: boolean;
  onChoose: (template: CuratedTemplate) => void;
}>) {
  const catalog = useQuery({
    ...authoringCatalogQueryOptions(apiClient, userId),
    staleTime: 0,
  });
  return (
    <section
      aria-label="Curated workflow examples"
      className="flex flex-col gap-4"
    >
      <Notice tone="info">
        Creating a draft from an example does not publish, activate or run it.
      </Notice>
      {catalog.isFetching ? (
        <p role="status">Checking the current catalog…</p>
      ) : null}
      {catalog.isError ? (
        <Button variant="outline" onClick={() => void catalog.refetch()}>
          Retry current catalog
        </Button>
      ) : null}
      {CURATED_WORKFLOW_TEMPLATES.map((template) => {
        const reasons = templateUnavailableReasons(
          template,
          catalog.isError ? undefined : catalog.data?.definitions,
        );
        return (
          <section
            key={template.templateId}
            aria-label={template.title}
            className="flex flex-col gap-2 border-b border-border pb-4"
          >
            <h3 className="font-heading">{template.title}</h3>
            <p className="text-sm">{template.description}</p>
            <dl className="text-sm text-muted-foreground">
              <dt>Input</dt>
              <dd>{template.inputSummary}</dd>
              <dt>Bounds</dt>
              <dd>{template.boundsSummary}</dd>
              <dt>Effects</dt>
              <dd>{template.effectsSummary}</dd>
            </dl>
            {reasons.map((reason) => (
              <p key={reason} className="text-sm text-warning">
                {reason}
              </p>
            ))}
            <Button
              variant="outline"
              disabled={disabled || catalog.isFetching || reasons.length > 0}
              onClick={() => {
                onChoose(template);
              }}
            >
              Set up {template.title}
            </Button>
          </section>
        );
      })}
    </section>
  );
}
