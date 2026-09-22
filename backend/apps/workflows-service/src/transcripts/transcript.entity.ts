import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity({ name: 'transcripts' })
export class Transcript {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id' })
  userId: string;

  @Column({ name: 'request_id', unique: true })
  requestId: string;

  @Column({ type: 'bytea' })
  ciphertext: Buffer;

  @Column({ name: 'word_count', type: 'int' })
  wordCount: number;

  @Column({ name: 'audio_ms', type: 'int' })
  audioMs: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @Column({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt: Date | null;

  @Column({ name: 'list_in_history', type: 'boolean', default: true })
  listInHistory: boolean;
}
