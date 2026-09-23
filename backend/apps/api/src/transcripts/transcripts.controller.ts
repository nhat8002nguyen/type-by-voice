import {
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import type { ClientProxy } from '@nestjs/microservices';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Min } from 'class-validator';
import { AccessAuthGuard } from '../auth/access-auth.guard.js';
import type { RequestUser } from '../auth/access-auth.guard.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { WORKFLOWS_SERVICE } from '../../../../libs/workflows/src/tokens.js';
import { TranscriptsService } from './transcripts.service.js';

export class ListTranscriptsQueryDto {
  @IsOptional()
  @IsString()
  q?: string;

  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;
}

type TranscriptsActor = { userId: string } | RequestUser;

/** toUserId extracts the authenticated user id for transcript HTTP handlers. */
function toUserId(user: TranscriptsActor): string {
  return 'userId' in user ? user.userId : user.id;
}

@Controller('v1/transcripts')
@UseGuards(AccessAuthGuard)
export class TranscriptsController {
  private readonly transcriptsService: TranscriptsService;

  constructor(@Inject(WORKFLOWS_SERVICE) workflows: ClientProxy) {
    this.transcriptsService = new TranscriptsService(workflows);
  }

  @Get()
  /** list returns a page of the caller's transcript history from workflows-service. */
  list(
    @CurrentUser() user: TranscriptsActor,
    @Query() query: ListTranscriptsQueryDto,
  ) {
    return this.transcriptsService.list(toUserId(user), query);
  }

  @Get('export')
  @Header('Content-Type', 'application/json')
  /** export downloads the caller's visible transcript history. */
  export(@CurrentUser() user: TranscriptsActor) {
    return this.transcriptsService.export(toUserId(user));
  }

  @Get(':id')
  /** get returns one transcript owned by the caller. */
  async get(@CurrentUser() user: TranscriptsActor, @Param('id') id: string) {
    const item = await this.transcriptsService.get(toUserId(user), id);
    if (item == null) {
      throw new NotFoundException();
    }
    return item;
  }

  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  /** deleteAll soft-deletes all of the caller's transcripts. */
  deleteAll(@CurrentUser() user: TranscriptsActor) {
    return this.transcriptsService.deleteAll(toUserId(user));
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  /** delete soft-deletes one transcript owned by the caller. */
  delete(@CurrentUser() user: TranscriptsActor, @Param('id') id: string) {
    return this.transcriptsService.delete(toUserId(user), id);
  }
}
