import { Test, TestingModule } from '@nestjs/testing';
import { QuotaServiceController } from './quota-service.controller.js';
import { QuotaServiceService } from './quota-service.service.js';

describe('QuotaServiceController', () => {
  let quotaServiceController: QuotaServiceController;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [QuotaServiceController],
      providers: [QuotaServiceService],
    }).compile();

    quotaServiceController = app.get<QuotaServiceController>(QuotaServiceController);
  });

  describe('root', () => {
    it('should return "Hello World!"', () => {
      expect(quotaServiceController.getHello()).toBe('Hello World!');
    });
  });
});
