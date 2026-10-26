import {
  Controller,
  Header,
  Post,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  CsrfProtectionGuard,
  SessionAuthenticationGuard,
} from '../../workspaces/index.js';
import {
  applicationError,
  throwApplicationError,
} from '../../platform/http/index.js';
import { RateLimit } from '../../platform/rate-limit/metadata.js';
import { domainErrors } from '../../platform/http/problems/interceptor.js';
import { formUploadFailure } from '../../problems/context/normalize.js';

function unavailableStorage(): never {
  return throwApplicationError(
    applicationError('artifact.unavailable', {
      safeDetail:
        'This server cannot store files yet. Ask the person running Pertexo to configure file storage.',
    }),
  );
}

@UseInterceptors(domainErrors(formUploadFailure))
@Controller()
export class UnconfiguredFormUploadsController {
  @Post([
    'v1/forms/:publicId/uploads',
    'v1/forms/:publicId/uploads/:uploadId/finalize',
  ])
  @RateLimit('form_read')
  @Header('Cache-Control', 'no-store')
  public publicUpload(): never {
    return unavailableStorage();
  }

  @Post([
    'v1/workspaces/:workspaceId/workflows/:workflowId/form/uploads',
    'v1/workspaces/:workspaceId/workflows/:workflowId/form/uploads/:uploadId/finalize',
    'v1/workspaces/:workspaceId/pending-tasks/:taskId/uploads',
    'v1/workspaces/:workspaceId/pending-tasks/:taskId/uploads/:uploadId/finalize',
  ])
  @RateLimit('ordinary_mutation')
  @UseGuards(SessionAuthenticationGuard, CsrfProtectionGuard)
  @Header('Cache-Control', 'no-store')
  public memberUpload(): never {
    return unavailableStorage();
  }
}
