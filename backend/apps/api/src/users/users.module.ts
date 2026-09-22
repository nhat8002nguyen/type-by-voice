import { QUOTA_SERVICE } from '@app/quota';
import { NatsClientModule } from '@app/tracing';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { MeQuotaController } from '../quota/quota.controller.js';
import { UsersController } from './users.controller.js';

@Module({
  imports: [
    AuthModule,
    NatsClientModule.register([
      { name: QUOTA_SERVICE, queue: 'quota-service' },
    ]),
  ],
  controllers: [UsersController, MeQuotaController],
})
export class UsersModule {}
