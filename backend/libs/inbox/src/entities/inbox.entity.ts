import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export type InboxStatus = 'pending' | 'processed' | 'failed';

@Entity()
export class Inbox {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ unique: true })
  messageId: string;

  @Column()
  type: string;

  @Column({ type: 'jsonb' })
  payload: Record<string, unknown>;

  @Column({
    type: 'enum',
    enum: ['pending', 'processed', 'failed'],
    default: 'pending',
  })
  status: InboxStatus;

  @Column({ default: 0 })
  attempts: number;

  @Column({ type: 'text', nullable: true })
  lastError: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
