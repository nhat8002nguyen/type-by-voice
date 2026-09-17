import { Module } from '@nestjs/common';
import { createObserveModule } from '@nestjs/observe';
import { QuotaController } from './quota.controller.js';
import { QuotaServiceController } from './quota-service.controller.js';
import { QuotaServiceService } from './quota-service.service.js';
import { QuotaService } from './quota.service.js';

export const { ObserveModule, ObserveInstrument } = createObserveModule();

@Module({
  imports: [
    ObserveModule.forRoot({
      appKey: process.env.OBSERVE_APP_KEY ?? '',
      appSecret: process.env.OBSERVE_APP_SECRET ?? '',
      serviceId: 'quota-service',
    }),
  ],
  controllers: [QuotaServiceController, QuotaController],
  providers: [QuotaServiceService, QuotaService],
  exports: [QuotaService],
})
export class QuotaServiceModule {}
