import { Controller, Get } from '@nestjs/common';
import { WorkflowsServiceService } from './workflows-service.service.js';

@Controller()
export class WorkflowsServiceController {
  constructor(private readonly workflowsServiceService: WorkflowsServiceService) {}

  @Get()
  getHello(): string {
    return this.workflowsServiceService.getHello();
  }
}
