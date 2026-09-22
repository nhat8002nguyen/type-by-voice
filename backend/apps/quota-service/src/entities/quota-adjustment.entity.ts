import {
  Column,
  CreateDateColumn,
  Entity,
  ForeignKey,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { QuotaPeriod } from './quota-period.entity.js';

@Entity({ name: 'quota_adjustments' })
export class QuotaAdjustment {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @ForeignKey(() => QuotaPeriod, { onDelete: 'CASCADE' })
  @Column({ name: 'quota_period_id', type: 'uuid' })
  quotaPeriodId: string;

  @Column({ name: 'words_delta', type: 'int' })
  wordsDelta: number;

  @Column({ type: 'text' })
  reason: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
