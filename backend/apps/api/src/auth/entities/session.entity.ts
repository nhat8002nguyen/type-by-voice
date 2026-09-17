import type { Platform } from '@type-by-voice/dictation-v1';
import {
  Column,
  Entity,
  ForeignKey,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { User } from './user.entity.js';

@Entity({ name: 'sessions' })
@Index('UQ_sessions_active_user_device', ['userId', 'deviceId'], {
  unique: true,
  where: '"revoked_at" IS NULL',
})
export class Session {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ForeignKey(() => User, { onDelete: 'CASCADE' })
  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @Column({ name: 'refresh_token_hash' })
  refreshTokenHash: string;

  @Column({ type: 'varchar' })
  platform: Platform;

  @Column({ name: 'client_version' })
  clientVersion: string;

  @Column({ name: 'device_id', type: 'uuid' })
  deviceId: string;

  @Column({ name: 'user_agent', type: 'text', nullable: true })
  userAgent: string | null;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt: Date;

  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
  revokedAt: Date | null;
}
