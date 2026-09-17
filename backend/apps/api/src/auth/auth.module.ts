import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ACCESS_TOKEN_TTL_SECONDS } from './auth.constants.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { Session } from './entities/session.entity.js';
import { User } from './entities/user.entity.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([User, Session]),
    JwtModule.register({
      secret: process.env.JWT_SECRET ?? 'dev-only-jwt-secret',
      signOptions: { expiresIn: ACCESS_TOKEN_TTL_SECONDS },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService],
  exports: [AuthService, JwtModule],
})
export class AuthModule {}
