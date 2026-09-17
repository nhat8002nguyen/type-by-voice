import { Test, TestingModule } from '@nestjs/testing';
import { SpeechServiceController } from './speech-service.controller.js';
import { SpeechServiceService } from './speech-service.service.js';

describe('SpeechServiceController', () => {
  let speechServiceController: SpeechServiceController;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [SpeechServiceController],
      providers: [SpeechServiceService],
    }).compile();

    speechServiceController = app.get<SpeechServiceController>(SpeechServiceController);
  });

  describe('root', () => {
    it('should return "Hello World!"', () => {
      expect(speechServiceController.getHello()).toBe('Hello World!');
    });
  });
});
