import {
  Column,
  Entity,
  ForeignKey,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { User } from './user.entity.js';

export type AuthTokenPurpose = 'verify-email' | 'reset-password';

@Entity({ name: 'auth_tokens' })
@Index('UQ_auth_tokens_token_hash', ['tokenHash'], { unique: true })
export class AuthToken {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ForeignKey(() => User, { onDelete: 'CASCADE' })
  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @Column({ type: 'varchar' })
  purpose: AuthTokenPurpose;

  @Column({ name: 'token_hash' })
  tokenHash: string;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt: Date;

  @Column({ name: 'consumed_at', type: 'timestamptz', nullable: true })
  consumedAt: Date | null;
}
