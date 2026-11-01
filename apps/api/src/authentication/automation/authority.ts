import {
  applicationError,
  throwApplicationError,
} from '../../platform/http/index.js';
import type {
  ApiTokenDatabase,
  VerifiedApiToken,
} from '@pertexo/core/tenant-access';
import type { RequestHeaders } from '../../platform/http/request-headers.js';
import type { HttpRateLimitAdmission } from '../../platform/rate-limit/admission.js';
import { bearerCredential } from './headers.js';

export class ApiTokenAuthentication {
  private readonly enabled: boolean;
  private readonly admission: HttpRateLimitAdmission;
  public constructor(
    private readonly database: ApiTokenDatabase,
    {
      enabled,
      admission,
    }: Readonly<{ enabled: boolean; admission: HttpRateLimitAdmission }>,
  ) {
    this.enabled = enabled;
    this.admission = admission;
  }
  public async authenticate(
    input: Readonly<{
      headers: RequestHeaders;
      rawHeaders?: readonly string[] | undefined;
      clientAddress: string;
      hasSession: boolean;
    }>,
  ): Promise<VerifiedApiToken | undefined> {
    await this.admission.admit('automation_authentication', {
      clientAddress: input.clientAddress,
    });
    const credential = bearerCredential(input.headers, input.rawHeaders);
    if (credential === undefined || input.hasSession) return undefined;
    if (!this.enabled)
      return throwApplicationError(
        applicationError('api_token.unavailable', {
          safeDetail: 'Automation tokens are disabled on this server.',
        }),
      );
    return this.database.authenticate(credential);
  }
}
