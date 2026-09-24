import type { ConnectionResponse } from '@pertexo/contracts/schemas/connections';
import { Link } from '@tanstack/react-router';
import { ExternalLinkIcon, PlusIcon } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button-variants';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { describeConnectionRequirement } from '@/features/catalog/presentation.public';
import { ChoiceSelect } from './choice-select';
import type { NodeFormApi } from '../../model/node-form';

/**
 * Which workspace connection a step uses for one requirement. Only active
 * connections of the right kind are offered; a new one opens in a new tab
 * so the draft and its guards stay put, and the list refreshes on return.
 */
export function ConnectionSlot({
  requirement,
  selectedId,
  connections,
  workspaceId,
  form,
}: Readonly<{
  requirement: string;
  selectedId: string | undefined;
  connections: readonly ConnectionResponse[];
  workspaceId: string;
  form: NodeFormApi;
}>) {
  const id = `connection-${form.nodeId}-${requirement}`;
  const label = describeConnectionRequirement(requirement);
  const matching = connections.filter(
    (connection) =>
      connection.authType === requirement && connection.status === 'active',
  );
  const missingId =
    selectedId !== undefined &&
    !matching.some((connection) => connection.id === selectedId)
      ? selectedId
      : undefined;
  const missing = missingId !== undefined;
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <ChoiceSelect
        id={id}
        value={selectedId ?? null}
        disabled={!form.editable}
        choices={[
          { value: null, label: 'Choose a connection' },
          ...matching.map((connection) => ({
            value: connection.id,
            label: connection.name,
          })),
          ...(missingId === undefined
            ? []
            : [
                {
                  value: missingId,
                  label: 'A connection that’s no longer active',
                },
              ]),
        ]}
        onChange={(connectionId) => {
          form.commit(
            (node) => ({
              connectionRefs:
                connectionId === null
                  ? Object.fromEntries(
                      Object.entries(node.connectionRefs).filter(
                        ([key]) => key !== requirement,
                      ),
                    )
                  : { ...node.connectionRefs, [requirement]: connectionId },
            }),
            `${form.nodeId}:connection:${requirement}`,
          );
        }}
      />
      {matching.length === 0 ? (
        <FieldDescription>
          There’s no active {label.toLowerCase()} in this workspace yet.
        </FieldDescription>
      ) : null}
      {missing ? (
        <FieldDescription className="text-warning">
          The chosen connection was revoked or needs reauthorizing. Choose
          another one.
        </FieldDescription>
      ) : null}
      <Link
        to="/w/$workspaceId/connections"
        params={{ workspaceId }}
        target="_blank"
        rel="noopener"
        className={buttonVariants({
          variant: 'link',
          size: 'sm',
          className: 'w-fit',
        })}
      >
        <PlusIcon data-icon="inline-start" />
        Add a connection
        <ExternalLinkIcon
          data-icon="inline-end"
          aria-label="(opens in a new tab)"
          role="img"
        />
      </Link>
    </Field>
  );
}
