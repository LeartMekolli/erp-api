import { Global, Module } from '@nestjs/common';
import { ConfigService } from '../config/config.service';
import { STORAGE } from './object-storage';
import { S3Storage } from './s3-storage';

/** Global: the API signs and checks, the worker reads. */
@Global()
@Module({
  providers: [
    { provide: STORAGE, inject: [ConfigService], useFactory: (config: ConfigService) => new S3Storage(config) },
  ],
  exports: [STORAGE],
})
export class StorageModule {}
