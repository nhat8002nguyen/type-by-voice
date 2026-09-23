import { Injectable } from '@nestjs/common';

@Injectable()
export class QuotaServiceService {
  /** getHello returns the scaffold hello payload for quota-service. */
  getHello(): string {
    return 'Hello World!';
  }
}
