/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
import * as grpc from '@grpc/grpc-js';
import { describe, expect, it, vi } from 'vitest';
import {
  KVClient,
  MaintenanceClient,
  Services,
  type ICallable,
  type IRangeRequest,
  type IRangeStreamResponse,
  type IResponseStream,
  type ISnapshotResponse,
} from '../rpc.js';

function createResponseStream<T>(values: T[]) {
  const cancel = vi.fn();
  const stream: IResponseStream<T> = {
    cancel,
    on: () => stream,
    async *[Symbol.asyncIterator]() {
      yield* values;
    },
  };

  return { cancel, stream };
}

function createCallable(
  client: grpc.Client,
  metadata: grpc.Metadata,
  callOptionsFactory: ICallable<unknown>['callOptionsFactory'],
): ICallable<unknown> {
  return {
    exec<T>(): Promise<T> {
      return Promise.reject(new Error('unexpected unary request'));
    },
    withConnection<R>(
      _service: keyof typeof Services,
      fn: (args: {
        resource: unknown;
        client: grpc.Client;
        metadata: grpc.Metadata;
      }) => Promise<R> | R,
    ): Promise<R> {
      return Promise.resolve(fn({ resource: undefined, client, metadata }));
    },
    markFailed: vi.fn(),
    callOptionsFactory,
  };
}

describe('generated response streams', () => {
  it('passes KV range stream request, metadata, and options in grpc-js order', async () => {
    const metadata = new grpc.Metadata();
    const options: grpc.CallOptions = { deadline: new Date(0) };
    const callOptionsFactory = vi.fn(() => options);
    const response = {} as IRangeStreamResponse;
    const { cancel, stream } = createResponseStream([response]);
    const rangeStream = vi.fn(() => stream);
    const client = { rangeStream } as unknown as grpc.Client;
    const request: IRangeRequest = { key: Buffer.from('key') };

    const result = await new KVClient(
      createCallable(client, metadata, callOptionsFactory),
    ).rangeStream(request);

    expect(callOptionsFactory).toHaveBeenCalledWith({
      service: 'KV',
      method: 'rangeStream',
      params: request,
      isStream: true,
    });
    expect(rangeStream).toHaveBeenCalledWith(request, metadata, options);

    const responses: IRangeStreamResponse[] = [];
    for await (const item of result) {
      responses.push(item);
    }
    expect(responses).toEqual([response]);

    result.cancel();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('passes an empty snapshot request before metadata and options', async () => {
    const metadata = new grpc.Metadata();
    const options: grpc.CallOptions = { deadline: new Date(0) };
    const callOptionsFactory = vi.fn(() => options);
    const { cancel, stream } = createResponseStream<ISnapshotResponse>([]);
    const snapshot = vi.fn(() => stream);
    const client = { snapshot } as unknown as grpc.Client;

    const result = await new MaintenanceClient(
      createCallable(client, metadata, callOptionsFactory),
    ).snapshot();

    expect(callOptionsFactory).toHaveBeenCalledWith({
      service: 'Maintenance',
      method: 'snapshot',
      isStream: true,
    });
    expect(snapshot).toHaveBeenCalledWith({}, metadata, options);

    result.cancel();
    expect(cancel).toHaveBeenCalledOnce();
  });
});
