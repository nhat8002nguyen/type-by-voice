import {
  ArgumentsHost,
  BadRequestException,
  Catch,
  ExceptionFilter,
} from '@nestjs/common';

const IDENTITY_PROPERTY_MESSAGE = /^(platform|deviceId|clientVersion) /;

export function isIdentityValidationMessage(message: unknown): boolean {
  const messages = Array.isArray(message) ? message : [message];
  return messages.some(
    (item) => typeof item === 'string' && IDENTITY_PROPERTY_MESSAGE.test(item),
  );
}

@Catch(BadRequestException)
export class InvalidIdentityFilter implements ExceptionFilter {
  catch(exception: BadRequestException, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<{
      status: (code: number) => { json: (body: unknown) => void };
    }>();
    const body = exception.getResponse();
    const message =
      typeof body === 'object' && body !== null && 'message' in body
        ? (body as { message: unknown }).message
        : undefined;

    if (isIdentityValidationMessage(message)) {
      response.status(400).json({ code: 'invalid_request' });
      return;
    }

    response.status(exception.getStatus()).json(body);
  }
}
