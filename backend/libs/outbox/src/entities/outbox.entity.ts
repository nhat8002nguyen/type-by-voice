import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity()
export class Outbox {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  type: string;

  @Column({ type: 'jsonb' })
  payload: Record<string, unknown>;

  @Column()
  target: string;

  @Column({
    type: 'enum',
    enum: ['pending', 'processed'],
    default: 'pending',
  })
  status: 'pending' | 'processed';

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
