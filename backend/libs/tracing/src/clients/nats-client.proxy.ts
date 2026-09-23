import { ClientProxy, NatsRecord } from '@nestjs/microservices';
import {
  headers as createNatsHeaders,
  type MsgHdrs,
} from '@nats-io/transport-node';
import { TraceContextService } from '../trace-context.service.js';
import { TRACE_ID_HEADER } from '../tracing.constants.js';
import { TracingClientProxyBase } from './tracing-client-proxy.base.js';

type TracedNatsRecord = NatsRecord<unknown, MsgHdrs>;

export class NatsClientProxy extends TracingClientProxyBase {
  constructor(
    client: ClientProxy,
    traceContext: TraceContextService,
    inquirer: object | string,
  ) {
    super(client, traceContext, inquirer, 'nats');
  }

  /** attachTraceId injects the active trace id into outbound NATS message metadata. */
  protected attachTraceId(data: unknown, traceId: string): TracedNatsRecord {
    const record: TracedNatsRecord =
      data instanceof NatsRecord
        ? (data as TracedNatsRecord)
        : new NatsRecord(data);
    const headers = record.headers ?? createNatsHeaders();
    headers.set(TRACE_ID_HEADER, traceId);
    return new NatsRecord(record.data, headers);
  }
}
