import { Module } from '@nestjs/common';
import { WorkflowsServiceController } from './workflows-service.controller.js';
import { WorkflowsServiceService } from './workflows-service.service.js';

@Module({
  imports: [],
  controllers: [WorkflowsServiceController],
  providers: [WorkflowsServiceService],
})
export class WorkflowsServiceModule {}
