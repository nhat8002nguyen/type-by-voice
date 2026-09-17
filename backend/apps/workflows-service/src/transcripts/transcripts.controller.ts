import { InboxService } from '@app/inbox';
import { CreateTranscriptDto, WORKFLOWS_CREATE_EVENT } from '@app/workflows';
import { Controller, Logger } from '@nestjs/common';
import {
  Ctx,
  EventPattern,
  MessagePattern,
  Payload,
  RmqContext,
} from '@nestjs/microservices';
import { IsInt, IsOptional, IsString, Min } from 'class-validator';
import { Type } from 'class-transformer';
import type { Channel, Message } from 'amqplib';
import { TranscriptsService } from './transcripts.service.js';

export class TranscriptsUserDto {
  @IsString()
  userId: string;
}

export class TranscriptsListDto extends TranscriptsUserDto {
  @IsOptional()
  @IsString()
  cursor?: string;

  @IsInt()
  @Min(1)
  limit: number;
}

export class TranscriptsGetDto extends TranscriptsUserDto {
  @IsString()
  id: string;
}

export class TranscriptsSearchDto extends TranscriptsUserDto {
  @IsString()
  q: string;

  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;
}

@Controller()
export class TranscriptsController {
  private readonly logger = new Logger(TranscriptsController.name);

  constructor(
    private readonly transcriptsService: TranscriptsService,
    private readonly inboxService: InboxService,
  ) {}

  @EventPattern(WORKFLOWS_CREATE_EVENT)
  async create(
    @Payload() dto: CreateTranscriptDto,
    @Ctx() context: RmqContext,
  ): Promise<void> {
    const channel = context.getChannelRef() as Channel;
    const originalMessage = context.getMessage() as Message;
    const messageId = originalMessage.properties.messageId as
      string | undefined;

    if (!messageId) {
      this.logger.error(
        'Missing messageId on workflows.create; acking without store',
      );
      channel.ack(originalMessage);
      return;
    }

    await this.transcriptsService.create(dto);
    await this.inboxService.store({
      messageId,
      type: WORKFLOWS_CREATE_EVENT,
      payload: {
        userId: dto.userId,
        requestId: dto.requestId,
        wordCount: dto.wordCount,
        audioMs: dto.audioMs,
      },
    });
    channel.ack(originalMessage);
  }

  @MessagePattern('transcripts.list')
  list(@Payload() dto: TranscriptsListDto) {
    return this.transcriptsService.list(dto.userId, {
      cursor: dto.cursor,
      limit: dto.limit,
    });
  }

  @MessagePattern('transcripts.get')
  get(@Payload() dto: TranscriptsGetDto) {
    return this.transcriptsService.get(dto.userId, dto.id);
  }

  @MessagePattern('transcripts.delete')
  delete(@Payload() dto: TranscriptsGetDto) {
    return this.transcriptsService.delete(dto.userId, dto.id);
  }

  @MessagePattern('transcripts.search')
  search(@Payload() dto: TranscriptsSearchDto) {
    return this.transcriptsService.search(dto.userId, dto.q, {
      cursor: dto.cursor,
      limit: dto.limit,
    });
  }

  @MessagePattern('transcripts.export')
  export(@Payload() dto: TranscriptsUserDto) {
    return this.transcriptsService.export(dto.userId);
  }
}
