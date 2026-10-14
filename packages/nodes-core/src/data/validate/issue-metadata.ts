interface CoreValidateIssueMetadataEntry {
  readonly key: string;
  readonly code: string;
  readonly message: string;
}

const coreValidateIssueMetadata = Object.freeze([
  Object.freeze({
    key: 'required',
    code: 'required',
    message: 'Required value is missing.',
  }),
  Object.freeze({
    key: 'type',
    code: 'type',
    message: 'Value has an unexpected type.',
  }),
  Object.freeze({
    key: 'enum',
    code: 'enum',
    message: 'Value is not an allowed enum member.',
  }),
  Object.freeze({
    key: 'minimum',
    code: 'minimum',
    message: 'Number is below the minimum.',
  }),
  Object.freeze({
    key: 'maximum',
    code: 'maximum',
    message: 'Number is above the maximum.',
  }),
  Object.freeze({
    key: 'minLength',
    code: 'min_length',
    message: 'String is shorter than the minimum length.',
  }),
  Object.freeze({
    key: 'maxLength',
    code: 'max_length',
    message: 'String is longer than the maximum length.',
  }),
  Object.freeze({
    key: 'minItems',
    code: 'min_items',
    message: 'Array has fewer than the minimum items.',
  }),
  Object.freeze({
    key: 'maxItems',
    code: 'max_items',
    message: 'Array has more than the maximum items.',
  }),
] as const satisfies readonly CoreValidateIssueMetadataEntry[]);

type CoreValidateIssueMetadata = (typeof coreValidateIssueMetadata)[number];
type CoreValidateIssueKey = CoreValidateIssueMetadata['key'];
type CoreValidateIssueCode = CoreValidateIssueMetadata['code'];
type CoreValidateIssueMessage = CoreValidateIssueMetadata['message'];

type CoreValidateIssueMetadataByKey<Key extends CoreValidateIssueKey> = Extract<
  CoreValidateIssueMetadata,
  { readonly key: Key }
>;

type CoreValidateIssueMetadataRecord<Property extends 'code' | 'message'> = {
  readonly [
    Key in CoreValidateIssueKey
  ]: CoreValidateIssueMetadataByKey<Key>[Property];
};

type CoreValidateIssueCodeValues<
  Entries extends readonly CoreValidateIssueMetadataEntry[],
> = { readonly [Index in keyof Entries]: Entries[Index]['code'] };

function metadataRecord<Property extends 'code' | 'message'>(
  property: Property,
): CoreValidateIssueMetadataRecord<Property> {
  return Object.fromEntries(
    coreValidateIssueMetadata.map((entry) => [entry.key, entry[property]]),
  ) as CoreValidateIssueMetadataRecord<Property>;
}

export const coreValidateIssueCodes = Object.freeze(metadataRecord('code'));
export const coreValidateIssueMessages = Object.freeze(
  metadataRecord('message'),
);

export const coreValidateIssueCodeValues = Object.freeze(
  coreValidateIssueMetadata.map(({ code }) => code),
) as CoreValidateIssueCodeValues<typeof coreValidateIssueMetadata>;

export const coreValidateIssueMessageByCode = Object.freeze(
  Object.fromEntries(
    coreValidateIssueMetadata.map(({ code, message }) => [code, message]),
  ) as Record<CoreValidateIssueCode, CoreValidateIssueMessage>,
);
