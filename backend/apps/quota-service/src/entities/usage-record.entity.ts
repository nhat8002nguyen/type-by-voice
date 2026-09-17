import type { Platform } from '@type-by-voice/dictation-v1';
import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity({ name: 'usage_records' })
export class UsageRecord {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @Column({ name: 'request_id', type: 'uuid', unique: true })
  requestId: string;

  @Column({ name: 'session_id', type: 'uuid' })
  sessionId: string;

  @Column({ type: 'varchar' })
  platform: Platform;

  @Column({ name: 'client_version' })
  clientVersion: string;

  @Column({ name: 'audio_ms', type: 'int' })
  audioMs: number;

  @Column({ name: 'word_count', type: 'int' })
  wordCount: number;

  @Column()
  provider: string;

  @Column({ name: 'provider_latency_ms', type: 'int' })
  providerLatencyMs: number;

  @Column({ name: 'estimated_cost_micros', type: 'int' })
  estimatedCostMicros: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
