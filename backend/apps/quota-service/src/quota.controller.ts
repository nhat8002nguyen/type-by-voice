import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import {
  CheckQuotaRequestDto,
  CommitQuotaRequestDto,
  QUOTA_CHECK_PATTERN,
  QUOTA_COMMIT_PATTERN,
} from '@app/quota';
import { QuotaService } from './quota.service.js';

@Controller()
export class QuotaController {
  constructor(private readonly quotaService: QuotaService) {}

  @MessagePattern(QUOTA_CHECK_PATTERN)
  check(@Payload() dto: CheckQuotaRequestDto) {
    return this.quotaService.checkFor(dto);
  }

  @MessagePattern(QUOTA_COMMIT_PATTERN)
  commit(@Payload() dto: CommitQuotaRequestDto) {
    return this.quotaService.commit(dto, new Date());
  }
}
