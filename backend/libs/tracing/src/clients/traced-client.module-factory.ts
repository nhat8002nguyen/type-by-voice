import { DynamicModule, Scope, Type } from '@nestjs/common';
import { INQUIRER } from '@nestjs/core';
import {
  ClientProviderOptions,
  ClientProxy,
  ClientsModule,
} from '@nestjs/microservices';
import { TraceContextService } from '../trace-context.service.js';
import { TracingModule } from '../tracing.module.js';
import { ClientRegistration, TracingClientProxy } from './tracing-client.types.js';
import { underlyingClientToken } from './traced-client.tokens.js';

export interface TracedClientModuleDefinition {
  module: Type<unknown>;
  registrations: ClientRegistration[];
  clientOptions: (
    registration: ClientRegistration,
    name: symbol,
  ) => ClientProviderOptions;
  createProxy: (
    client: ClientProxy,
    traceContext: TraceContextService,
    inquirer: object,
  ) => TracingClientProxy;
}

/** createTracedClientModule builds a dynamic module wrapping a ClientProxy with tracing. */
export function createTracedClientModule({
  module,
  registrations,
  clientOptions,
  createProxy,
}: TracedClientModuleDefinition): DynamicModule {
  const entries = registrations.map((registration) => ({
    registration,
    clientToken: underlyingClientToken(registration.name),
  }));

  return {
    module,
    imports: [
      TracingModule,
      ClientsModule.register(
        entries.map(({ registration, clientToken }) =>
          clientOptions(registration, clientToken),
        ),
      ),
    ],
    providers: entries.map(({ registration, clientToken }) => ({
      provide: registration.name,
      scope: Scope.TRANSIENT,
      inject: [clientToken, TraceContextService, INQUIRER],
      useFactory: createProxy,
    })),
    exports: [
      ...entries.map(({ registration }) => registration.name),
      ClientsModule,
    ],
  };
}
