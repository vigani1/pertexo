import type { WorkflowValidateResponse } from '@pertexo/contracts/schemas/workflow-authoring';
import { useEffect, useRef, useState } from 'react';
import type { ApiClient } from '@/lib/api/client';
import { publishWorkflow, validateWorkflow } from '../workflow-publish.api';
import { commandErrorMessage, isUncertainCommandError } from './command-utils';

export type ValidationResult = Readonly<{
  report: WorkflowValidateResponse;
  generation: number;
  revision: number;
}>;

type PublishAttempt = Readonly<{
  etag: string;
  generation: number;
  revision: number;
  idempotencyKey: string;
}>;

export type PublicationReceipt = Readonly<{
  versionId: string;
  generation: number;
  revision: number;
}>;

export function useWorkflowPublication({
  apiClient,
  workspaceId,
  workflowId,
  verifyIdentity,
  ensureSaved,
}: Readonly<{
  apiClient: ApiClient;
  workspaceId: string;
  workflowId: string;
  verifyIdentity: () => Promise<void>;
  ensureSaved: () => Promise<
    Readonly<{ etag: string; generation: number; revision: number }>
  >;
}>) {
  const [validation, setValidation] = useState<ValidationResult>();
  const [validationPending, setValidationPending] = useState(false);
  const [validationError, setValidationError] = useState<string>();
  const [publishPending, setPublishPending] = useState(false);
  const [publishError, setPublishError] = useState<string>();
  const [publicationReceipt, setPublicationReceipt] =
    useState<PublicationReceipt>();
  const [publishRecoveryPending, setPublishRecoveryPending] = useState(false);
  const publishAttempt = useRef<PublishAttempt | undefined>(undefined);
  const owner = useRef<symbol | undefined>(undefined);

  useEffect(() => {
    const currentOwner = Symbol('workflow-publication');
    owner.current = currentOwner;
    return () => {
      if (owner.current === currentOwner) {
        owner.current = undefined;
        publishAttempt.current = undefined;
      }
    };
  }, [apiClient, workspaceId, workflowId]);

  async function validate() {
    if (validationPending) return;
    const validationOwner = owner.current;
    if (validationOwner === undefined) return;
    setValidationPending(true);
    setValidationError(undefined);
    try {
      const saved = await ensureSaved();
      if (owner.current !== validationOwner) return;
      const report = await validateWorkflow(apiClient, workspaceId, workflowId);
      if (owner.current !== validationOwner) return;
      setValidation({
        report,
        generation: saved.generation,
        revision: saved.revision,
      });
    } catch (error) {
      if (owner.current !== validationOwner) return;
      setValidationError(commandErrorMessage(error, 'validate the workflow'));
    } finally {
      if (owner.current === validationOwner) setValidationPending(false);
    }
  }

  async function publish() {
    if (publishPending) return false;
    const publicationOwner = owner.current;
    if (publicationOwner === undefined) return false;
    let dispatched = false;
    setPublishPending(true);
    setPublishError(undefined);
    try {
      await verifyIdentity();
      if (owner.current !== publicationOwner) return false;
      let command = publishAttempt.current;
      if (command === undefined) {
        const saved = await ensureSaved();
        if (owner.current !== publicationOwner) return false;
        if (
          validation === undefined ||
          !validation.report.valid ||
          validation.generation !== saved.generation ||
          validation.revision !== saved.revision
        )
          throw new Error('Validate this saved draft before publishing it.');
        command = {
          etag: saved.etag,
          generation: saved.generation,
          revision: saved.revision,
          idempotencyKey: crypto.randomUUID(),
        };
      }
      publishAttempt.current = command;
      dispatched = true;
      const response = await publishWorkflow(
        apiClient,
        workspaceId,
        workflowId,
        {
          etag: command.etag,
          idempotencyKey: command.idempotencyKey,
        },
      );
      if (owner.current !== publicationOwner) return false;
      publishAttempt.current = undefined;
      setPublishRecoveryPending(false);
      setPublicationReceipt({
        versionId: response.version.id,
        generation: command.generation,
        revision: command.revision,
      });
      return true;
    } catch (error) {
      if (owner.current !== publicationOwner) return false;
      if (!dispatched) {
        setPublishRecoveryPending(publishAttempt.current !== undefined);
        setPublishError(commandErrorMessage(error, 'verify this session'));
        return false;
      }
      const uncertain = isUncertainCommandError(error);
      if (!uncertain) publishAttempt.current = undefined;
      setPublishRecoveryPending(
        uncertain && publishAttempt.current !== undefined,
      );
      setPublishError(commandErrorMessage(error, 'publish the workflow'));
      return false;
    } finally {
      if (owner.current === publicationOwner) setPublishPending(false);
    }
  }

  return {
    validation,
    validationPending,
    validationError,
    publicationReceipt,
    publishPending,
    publishError,
    publishRecoveryPending,
    clearPublishError: () => {
      setPublishError(undefined);
    },
    validate,
    publish,
  };
}
