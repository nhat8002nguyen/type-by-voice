import { Observable } from 'rxjs';

export interface TracingClientProxy {
  send<TResult = unknown, TInput = unknown>(
    pattern: unknown,
    data: TInput,
  ): Observable<TResult>;

  emit<TResult = unknown, TInput = unknown>(
    pattern: unknown,
    data: TInput,
  ): Observable<TResult>;
}

export interface ClientRegistration {
  name: string | symbol;
  queue: string;
}
