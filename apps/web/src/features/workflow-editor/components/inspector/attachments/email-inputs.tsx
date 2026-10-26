import type { NodeDefinitionCatalogItem } from '@pertexo/contracts';
import { isRecord } from '@pertexo/workflow-model';
import type { ReactNode } from 'react';
import type { GraphLevel, WorkflowNode } from '../../../model/graph/scopes';
import type { NodeFormApi } from '../../../model/inspector/node-form';
import { ATTACHMENTS_KEY } from '../../../model/inspector/object-mappings/attachments';
import { EmailAttachments } from './section';

type MessageInputs = Readonly<{
  node: WorkflowNode;
  definition: NodeDefinitionCatalogItem | undefined;
  form: NodeFormApi;
  /** Attachments sit under the message, before the step's links. */
  links: ReactNode;
}>;

function withoutAttachmentsInput(
  definition: NodeDefinitionCatalogItem | undefined,
): NodeDefinitionCatalogItem | undefined {
  const schema = definition?.inputSchema;
  if (definition === undefined || !isRecord(schema?.properties))
    return definition;
  const { [ATTACHMENTS_KEY]: _attachments, ...properties } = schema.properties;
  return { ...definition, inputSchema: { ...schema, properties } };
}

/**
 * Send email's Inputs: the message's ordinary mapping rows, then its
 * Attachments. The rows never see or overwrite the attachments mapping,
 * which the section owns.
 */
export function EmailInputs({
  node,
  graph,
  loopPorts,
  definition,
  form,
  links,
  messageInputs,
}: Readonly<{
  node: WorkflowNode;
  graph: GraphLevel;
  loopPorts: readonly string[];
  definition: NodeDefinitionCatalogItem | undefined;
  form: NodeFormApi;
  links: ReactNode;
  messageInputs: (inputs: MessageInputs) => ReactNode;
}>) {
  const { [ATTACHMENTS_KEY]: _attachments, ...messageMappings } =
    node.inputMappings;
  return messageInputs({
    node: { ...node, inputMappings: messageMappings },
    definition: withoutAttachmentsInput(definition),
    form: {
      ...form,
      commit: (update, coalesceKey) => {
        form.commit((current) => {
          const next = typeof update === 'function' ? update(current) : update;
          const attachments = current.inputMappings[ATTACHMENTS_KEY];
          return next.inputMappings === undefined || attachments === undefined
            ? next
            : {
                ...next,
                inputMappings: {
                  ...next.inputMappings,
                  [ATTACHMENTS_KEY]: attachments,
                },
              };
        }, coalesceKey);
      },
    },
    links: (
      <>
        <EmailAttachments
          node={node}
          graph={graph}
          loopPorts={loopPorts}
          form={form}
        />
        {links}
      </>
    ),
  });
}
