import { Injectable } from '@nestjs/common';

@Injectable()
export class QuotaServiceService {
  getHello(): string {
    return 'Hello World!';
  }
}
