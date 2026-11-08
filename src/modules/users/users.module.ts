import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { CouriersModule } from '../couriers/couriers.module';
import { IdentityNotifierModule } from '../identity/identity-notifier';
import { NotificationsModule } from '../notifications/notifications.module';
import { InvitationsController } from './invitations.controller';
import { InvitationsService } from './invitations.service';
import { MeController } from './me.controller';
import { MeService } from './me.service';
import { SkillsController, UserSkillsController } from './skills.controller';
import { SkillsService } from './skills.service';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  imports: [AuditModule, CouriersModule, IdentityNotifierModule, NotificationsModule],
  controllers: [InvitationsController, UsersController, UserSkillsController, MeController, SkillsController],
  providers: [InvitationsService, MeService, UsersService, SkillsService],
})
export class UsersModule {}
