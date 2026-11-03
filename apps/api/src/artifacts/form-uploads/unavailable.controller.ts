import { Controller, UseInterceptors } from '@nestjs/common';
import { formUploadRoutes as routes } from '@pertexo/contracts/server';
import { UnconfiguredRoute } from '../../workspaces/http/route.js';
import {
  applicationError,
  throwApplicationError,
} from '../../platform/http/index.js';
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

/** The same upload routes when file storage isn't configured: each says so. */
@UseInterceptors(domainErrors(formUploadFailure))
@Controller()
export class UnconfiguredFormUploadsController {
  @UnconfiguredRoute(routes.publicBegin)
  public publicBegin(): never {
    return unavailableStorage();
  }

  @UnconfiguredRoute(routes.publicFinalize)
  public publicFinalize(): never {
    return unavailableStorage();
  }

  @UnconfiguredRoute(routes.memberBegin)
  public memberBegin(): never {
    return unavailableStorage();
  }

  @UnconfiguredRoute(routes.memberFinalize)
  public memberFinalize(): never {
    return unavailableStorage();
  }

  @UnconfiguredRoute(routes.taskBegin)
  public taskBegin(): never {
    return unavailableStorage();
  }

  @UnconfiguredRoute(routes.taskFinalize)
  public taskFinalize(): never {
    return unavailableStorage();
  }
}
