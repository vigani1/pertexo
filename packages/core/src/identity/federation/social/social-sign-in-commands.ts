import type { Pool } from 'pg';

import { completeSocialSignInCommand } from './complete-sign-in.js';

import type { SignUpMode } from '../../sign-up.js';

import type {
  ProvenSocialSignIn,
  SocialSignInAttempt,
  SocialSignInResult,
} from './social-sign-in.types.js';

import {
  insertSocialSignInAttempt,
  findSocialSignInAttempt,
} from './sign-in.repository.js';

/** A provider proves identity before this owner acquires a transaction. Nobody is signed in yet, so it stays off `withWorkspaceAccess`. */
export class SocialSignInCommands {
  public constructor(
    private readonly input: Readonly<{
      pool: Pool;
      sessionTtlSeconds: number;
      signUpMode: SignUpMode;
    }>,
  ) {}

  public async start(
    input: Readonly<{
      id: string;
      provider: string;
      stateDigest: Buffer;
      browserDigest: Buffer;
      returnPath: string;
    }>,
  ): Promise<void> {
    await insertSocialSignInAttempt(this.input.pool, input);
  }

  public find(
    stateDigest: Buffer,
    browserDigest: Buffer,
  ): Promise<SocialSignInAttempt | undefined> {
    return findSocialSignInAttempt(this.input.pool, stateDigest, browserDigest);
  }

  public complete(input: ProvenSocialSignIn): Promise<SocialSignInResult> {
    return completeSocialSignInCommand(this.input.pool, input, this.input);
  }
}
