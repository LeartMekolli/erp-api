import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { IdentityNotifierModule } from '../identity/identity-notifier';
import { InvitationsController } from './invitations.controller';
import { InvitationsService } from './invitations.service';
import { MeController } from './me.controller';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  imports: [AuditModule, IdentityNotifierModule],
  controllers: [InvitationsController, UsersController, MeController],
  providers: [InvitationsService, UsersService],
})
export class UsersModule {}
