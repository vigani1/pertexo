import type { FormStore, PublicFormGrant } from '@pertexo/core/triggers';
import type { FormAccessRequest } from '@pertexo/contracts';
import type { ConnectionSecretEncryptionPort } from '../connections/ports.js';

export class FormService {
  constructor(
    private readonly store: FormStore,
    private readonly encryption?: ConnectionSecretEncryptionPort,
  ) {}
  discover(input: Parameters<FormStore['discover']>[0]) {
    return this.store.discover(input);
  }
  read(input: Parameters<FormStore['read']>[0], grant?: PublicFormGrant) {
    return this.store.read(input, grant);
  }
  submit(input: Parameters<FormStore['submit']>[0], grant?: PublicFormGrant) {
    return this.store.submit(input, grant);
  }
  history(input: Parameters<FormStore['history']>[0]) {
    return this.store.history(input);
  }
  async access(input: Parameters<FormStore['access']>[0]) {
    const { sealedCapability, ...access } = await this.store.access(input);
    if (sealedCapability === null) return { ...access, capability: null };
    if (this.encryption === undefined)
      throw new Error('Form capability encryption is unavailable');
    const plaintext = await this.encryption.open(
      sealedCapability,
      capabilityContext(input),
      input.signal ?? new AbortController().signal,
    );
    try {
      return { ...access, capability: new TextDecoder().decode(plaintext) };
    } finally {
      plaintext.fill(0);
    }
  }
  async setAccess(
    input: Omit<
      Parameters<FormStore['setAccess']>[0],
      'access' | 'capability' | 'sealedCapability'
    > &
      FormAccessRequest,
  ) {
    if (input.access === 'members') return this.store.setAccess(input);
    if (this.encryption === undefined)
      throw new Error('Form capability encryption is unavailable');
    const plaintext = new TextEncoder().encode(input.capability);
    try {
      const sealedCapability = await this.encryption.seal(
        plaintext,
        capabilityContext(input),
        input.signal ?? new AbortController().signal,
      );
      return await this.store.setAccess({ ...input, sealedCapability });
    } finally {
      plaintext.fill(0);
    }
  }
}

// Bind the existing envelope to this workflow; no connection identifiers are accepted from the caller.
function capabilityContext(
  input: Readonly<{ workspaceId: string; workflowId: string }>,
) {
  return {
    workspaceId: input.workspaceId,
    connectionId: input.workflowId,
    secretVersionId: input.workflowId,
  };
}
