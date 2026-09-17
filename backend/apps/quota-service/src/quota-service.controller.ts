import { Controller, Get } from '@nestjs/common';
import { QuotaServiceService } from './quota-service.service.js';

@Controller()
export class QuotaServiceController {
  constructor(private readonly quotaServiceService: QuotaServiceService) {}

  @Get()
  getHello(): string {
    return this.quotaServiceService.getHello();
  }
}
