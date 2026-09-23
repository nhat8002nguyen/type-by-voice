import { Injectable } from '@nestjs/common';

@Injectable()
export class AppService {
  /** getHello returns the scaffold hello payload for the root controller. */
  getHello(): string {
    return 'Hello World!';
  }
}
