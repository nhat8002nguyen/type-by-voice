import {
  Column,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity({ name: 'quota_periods' })
@Index('UQ_quota_periods_user_period_start', ['userId', 'periodStart'], {
  unique: true,
})
export class QuotaPeriod {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @Column({ name: 'period_start', type: 'timestamptz' })
  periodStart: Date;

  @Column({ name: 'period_end', type: 'timestamptz' })
  periodEnd: Date;

  @Column({ name: 'words_used', type: 'int', default: 0 })
  wordsUsed: number;

  @Column({ name: 'audio_ms_used', type: 'int', default: 0 })
  audioMsUsed: number;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
