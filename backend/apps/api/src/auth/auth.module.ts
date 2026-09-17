import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OutboxModule } from '../../../../libs/outbox/src/outbox.module.js';
import { AccessAuthGuard } from './access-auth.guard.js';
import { ACCESS_TOKEN_TTL_SECONDS } from './auth.constants.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { AuthToken } from './entities/auth-token.entity.js';
import { Session } from './entities/session.entity.js';
import { User } from './entities/user.entity.js';
import {
  REDIS_CLIENT,
  RateLimitGuard,
  createRedisClient,
} from '../rate-limit/rate-limit.guard.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([User, Session, AuthToken]),
    OutboxModule.forFeature(),
    JwtModule.register({
      secret: process.env.JWT_SECRET ?? 'dev-only-jwt-secret',
      signOptions: { expiresIn: ACCESS_TOKEN_TTL_SECONDS },
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    AccessAuthGuard,
    RateLimitGuard,
    { provide: REDIS_CLIENT, useFactory: createRedisClient },
  ],
  exports: [
    AuthService,
    JwtModule,
    AccessAuthGuard,
    TypeOrmModule,
    RateLimitGuard,
  ],
})
export class AuthModule {}
