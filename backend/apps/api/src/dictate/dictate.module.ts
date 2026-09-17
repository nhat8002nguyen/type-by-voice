import { Module } from '@nestjs/common';
import { OutboxModule } from '@app/outbox';
import { QUOTA_SERVICE } from '@app/quota';
import { SPEECH_SERVICE } from '@app/speech';
import { NatsClientModule } from '@app/tracing';
import { AuthModule } from '../auth/auth.module.js';
import { DictateMetrics } from '../metrics/dictate-metrics.js';
import { DictateGateway } from './dictate.gateway.js';
import { SessionRegistry } from './session-registry.js';

@Module({
  imports: [
    AuthModule,
    OutboxModule.forFeature(),
    NatsClientModule.register([
      { name: QUOTA_SERVICE, queue: 'quota-service' },
      { name: SPEECH_SERVICE, queue: 'speech-service' },
    ]),
  ],
  providers: [DictateGateway, SessionRegistry, DictateMetrics],
})
export class DictateModule {}
