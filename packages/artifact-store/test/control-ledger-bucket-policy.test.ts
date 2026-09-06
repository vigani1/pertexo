import { describe, expect, it } from 'vitest';

import { inspectControlLedgerBucketPolicy } from '../src/control-ledger/bucket-policy.js';
import {
  bucketPolicy,
  DELETE_DENY,
  MISSING_IF_NONE_MATCH_DENY,
} from './support/control-ledger.fixture.js';

const BUCKET = 'pertexo-control-ledger';
const UNPROTECTED = { deletesDenied: false, missingIfNoneMatchDenied: false };

describe('control ledger bucket policy', () => {
  it('recognizes separate unconditional deletion and conditional write denies', () => {
    expect(
      inspectControlLedgerBucketPolicy(
        bucketPolicy(DELETE_DENY, MISSING_IF_NONE_MATCH_DENY),
        BUCKET,
      ),
    ).toEqual({ deletesDenied: true, missingIfNoneMatchDenied: true });
  });

  it.each([
    'invalid JSON',
    'null',
    'false',
    '3',
    '{}',
    '{"Statement":[null,false,3]}',
  ])('fails closed for malformed policy %s', (policy) => {
    expect(inspectControlLedgerBucketPolicy(policy, BUCKET)).toEqual(
      UNPROTECTED,
    );
  });

  it('accepts a single statement and case-insensitive action wildcards', () => {
    const policy = JSON.stringify({
      Statement: { ...DELETE_DENY, Action: ['S3:DELETE*', 's3:Replicate*'] },
    });
    expect(inspectControlLedgerBucketPolicy(policy, BUCKET)).toEqual({
      deletesDenied: true,
      missingIfNoneMatchDenied: false,
    });
  });

  it.each([
    { Effect: 'Allow' },
    { Principal: { AWS: '*' } },
    { Resource: 'arn:aws:s3:::another-bucket/control-ledger/*' },
    {
      Resource: 'arn:aws:s3:::pertexo-control-ledger/control-ledger/one-record',
    },
    {
      Resource:
        'arn:aws:s3:::pertexo-control-ledger/control-ledger/workspaces/subset/*',
    },
    { Condition: { StringEquals: { 'aws:PrincipalArn': 'one-role' } } },
    { Action: ['s3:DeleteObject', 's3:DeleteObjectVersion'] },
    { Action: 3 },
  ])('does not accept incomplete deletion protection %j', (override) => {
    expect(
      inspectControlLedgerBucketPolicy(
        bucketPolicy({ ...DELETE_DENY, ...override }),
        BUCKET,
      ),
    ).toEqual(UNPROTECTED);
  });

  it.each([
    undefined,
    null,
    false,
    { Null: null },
    { Null: { 's3:if-none-match': 'false' } },
    { Null: { 's3:if-none-match': true } },
    { Null: { 's3:if-none-match': 'true', another: 'true' } },
    { Null: { 's3:if-none-match': 'true' }, StringEquals: {} },
  ])(
    'requires the exact missing If-None-Match deny condition %j',
    (condition) => {
      expect(
        inspectControlLedgerBucketPolicy(
          bucketPolicy({ ...MISSING_IF_NONE_MATCH_DENY, Condition: condition }),
          BUCKET,
        ).missingIfNoneMatchDenied,
      ).toBe(false);
    },
  );
});
