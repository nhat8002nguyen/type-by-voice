import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { CheckQuotaRequestDto, CommitQuotaRequestDto } from '@app/quota';
import { QuotaService } from './quota.service.js';

@Controller()
export class QuotaController {
  constructor(private readonly quotaService: QuotaService) {}

  @MessagePattern('quota.check')
  check(@Payload() dto: CheckQuotaRequestDto) {
    return this.quotaService.checkFor(dto);
  }

  @MessagePattern('quota.commit')
  commit(@Payload() dto: CommitQuotaRequestDto) {
    return this.quotaService.commit(dto, new Date());
  }
}
