import {
  formSchemaResponseSchema,
  formAccessSchema,
  coordinatedEventHistorySchema,
  formSubmissionResponseSchema,
  publicFormSubmissionResponseSchema,
} from '@pertexo/contracts';
import type { FormStore, PublicFormGrant } from '@pertexo/core/triggers';

export class FormService {
  constructor(private readonly store: FormStore) {}
  async discover(input: Parameters<FormStore['discover']>[0]) {
    return this.store.discover(input);
  }
  async read(input: Parameters<FormStore['read']>[0], grant?: PublicFormGrant) {
    return formSchemaResponseSchema.parse(await this.store.read(input, grant));
  }
  async submit(
    input: Parameters<FormStore['submit']>[0],
    grant?: PublicFormGrant,
  ) {
    return (
      grant === undefined
        ? formSubmissionResponseSchema
        : publicFormSubmissionResponseSchema
    ).parse(await this.store.submit(input, grant));
  }
  async history(input: Parameters<FormStore['history']>[0]) {
    return coordinatedEventHistorySchema.parse(await this.store.history(input));
  }
  async access(input: Parameters<FormStore['access']>[0]) {
    return formAccessSchema.parse(await this.store.access(input));
  }
  async setAccess(input: Parameters<FormStore['setAccess']>[0]) {
    return formAccessSchema.parse(await this.store.setAccess(input));
  }
}
