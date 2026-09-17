import { Module } from '@nestjs/common';
import { QuotaServiceController } from './quota-service.controller.js';
import { QuotaServiceService } from './quota-service.service.js';

@Module({
  imports: [],
  controllers: [QuotaServiceController],
  providers: [QuotaServiceService],
})
export class QuotaServiceModule {}
