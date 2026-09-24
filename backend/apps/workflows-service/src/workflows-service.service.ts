import { Injectable } from '@nestjs/common';

@Injectable()
export class WorkflowsServiceService {
  /** getHello returns the scaffold hello payload for workflows-service. */
  getHello(): string {
    return 'Hello World!';
  }
}
