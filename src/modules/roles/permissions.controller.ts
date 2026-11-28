import { Controller, Get } from '@nestjs/common';
import { ApiDoc } from '../../docs/api-doc';
import { permissionList, permissionListResponseSchema } from '../identity/permission-catalogue';
import type { PermissionView } from '../identity/permission-catalogue';
import { RequirePermission } from '../identity/route-markers';

@Controller('permissions')
export class PermissionsController {
  @ApiDoc({
    summary: 'Describe every tenant permission in words.',
    description:
      'Answers `data`: each permission with `key`, its `area` (`key`, `name`), `name`, `description`, ' +
      '`sensitive` and `requires` (the permissions it is useless without), in the order the role editor shows them.',
    response: permissionListResponseSchema,
    errors: [401, 403],
  })
  @RequirePermission('role.read')
  @Get()
  list(): { data: PermissionView[] } {
    return { data: permissionList() };
  }
}
