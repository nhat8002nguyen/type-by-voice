import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity({ name: 'plans' })
export class Plan {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true })
  name: string;

  @Column({ name: 'word_limit', type: 'int', nullable: true })
  wordLimit: number | null;

  @Column({ name: 'period_length_days', type: 'int' })
  periodLengthDays: number;

  @Column({ name: 'audio_minutes_ceiling', type: 'int' })
  audioMinutesCeiling: number;

  @Column({ name: 'is_default', type: 'boolean', default: false })
  isDefault: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
