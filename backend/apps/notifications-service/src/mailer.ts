import { Injectable, Logger } from '@nestjs/common';
import type { SendEmailDto } from '@app/notifications';

@Injectable()
export class Mailer {
  private readonly logger = new Logger(Mailer.name);

  send(dto: SendEmailDto): void {
    if (process.env.NODE_ENV === 'production') {
      this.logger.log(`type=${dto.type} userId=${dto.userId}`);
      return;
    }
    console.log({ type: dto.type, userId: dto.userId, email: dto.email });
  }
}
