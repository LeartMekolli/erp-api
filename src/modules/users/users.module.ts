import { Module } from '@nestjs/common';
import { IdentityNotifierModule } from '../identity/identity-notifier';
import { InvitationsController } from './invitations.controller';
import { InvitationsService } from './invitations.service';

@Module({
  imports: [IdentityNotifierModule],
  controllers: [InvitationsController],
  providers: [InvitationsService],
})
export class UsersModule {}
