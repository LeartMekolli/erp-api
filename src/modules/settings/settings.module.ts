import { Module } from '@nestjs/common';
import { SettingsService } from './settings.service';

/** HTTP endpoints arrive in plan 2, once the permission guard exists. */
@Module({ providers: [SettingsService], exports: [SettingsService] })
export class SettingsModule {}
