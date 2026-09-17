import { Module } from '@nestjs/common';
import { NatsClientModule } from '@app/tracing';
import { WORKFLOWS_SERVICE } from '../../../../libs/workflows/src/tokens.js';
import { AuthModule } from '../auth/auth.module.js';
import { TranscriptsController } from './transcripts.controller.js';

@Module({
  imports: [
    AuthModule,
    NatsClientModule.register([
      { name: WORKFLOWS_SERVICE, queue: 'workflows-service' },
    ]),
  ],
  controllers: [TranscriptsController],
})
export class TranscriptsModule {}
