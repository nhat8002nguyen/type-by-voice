import { Controller, Get } from '@nestjs/common';
import { WorkflowsServiceService } from './workflows-service.service.js';

@Controller()
export class WorkflowsServiceController {
  constructor(private readonly workflowsServiceService: WorkflowsServiceService) {}

  @Get()
  /** getHello returns the scaffold hello string for workflows-service. */
  getHello(): string {
    return this.workflowsServiceService.getHello();
  }
}
