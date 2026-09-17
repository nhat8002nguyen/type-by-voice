import { Module } from '@nestjs/common';
import { createObserveModule } from '@nestjs/observe';
import { WorkflowsServiceController } from './workflows-service.controller.js';
import { WorkflowsServiceService } from './workflows-service.service.js';

export const { ObserveModule, ObserveInstrument } = createObserveModule();

@Module({
  imports: [
    ObserveModule.forRoot({
      appKey: process.env.OBSERVE_APP_KEY ?? '',
      appSecret: process.env.OBSERVE_APP_SECRET ?? '',
      serviceId: 'workflows-service',
    }),
  ],
  controllers: [WorkflowsServiceController],
  providers: [WorkflowsServiceService],
})
export class WorkflowsServiceModule {}
