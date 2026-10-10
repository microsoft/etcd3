/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
import * as grpc from '@grpc/grpc-js';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  KVClient,
  LeaseClient,
  MaintenanceClient,
  Services,
  WatchClient,
  type ICallable,
  type IRangeRequest,
  type IRangeStreamResponse,
  type IResponseStream,
  type ISnapshotResponse,
} from '../rpc.js';

function createResponseStream<T>(values: T[]) {
  const cancel = vi.fn();
  const errorListeners: Array<(error: Error) => void> = [];
  const stream: IResponseStream<T> = {
    cancel,
    [Symbol.dispose]: cancel,
    on(event, listener) {
      if (event === 'error') {
        errorListeners.push(listener as (error: Error) => void);
      }
      return stream;
    },
    async *[Symbol.asyncIterator]() {
      yield* values;
    },
  };

  return {
    cancel,
    stream,
    emitError(error: Error) {
      errorListeners.forEach(listener => listener(error));
    },
  };
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

  it('cancels response streams when disposed', async () => {
    const metadata = new grpc.Metadata();
    const { cancel, stream } = createResponseStream<IRangeStreamResponse>([]);
    const client = { rangeStream: vi.fn(() => stream) } as unknown as grpc.Client;

    {
      using result = await new KVClient(createCallable(client, metadata, undefined)).rangeStream({
        key: Buffer.from('key'),
      });
      expect(result).toBe(stream);
    }

    expect(cancel).toHaveBeenCalledOnce();
  });

  it('reports stream errors through the typed transport path', async () => {
    const metadata = new grpc.Metadata();
    const range = createResponseStream<IRangeStreamResponse>([]);
    const watch = createResponseStream<unknown>([]);
    const keepAlive = createResponseStream<unknown>([]);
    const snapshot = createResponseStream<ISnapshotResponse>([]);
    const client = {
      rangeStream: vi.fn(() => range.stream),
      watch: vi.fn(() => watch.stream),
      leaseKeepAlive: vi.fn(() => keepAlive.stream),
      snapshot: vi.fn(() => snapshot.stream),
    } as unknown as grpc.Client;
    const callable = createCallable(client, metadata, undefined);
    const reportStreamError = vi.fn();
    callable.reportStreamError = reportStreamError;

    await new KVClient(callable).rangeStream({ key: Buffer.from('key') });
    await new WatchClient(callable).watch();
    await new LeaseClient(callable).leaseKeepAlive();
    await new MaintenanceClient(callable).snapshot();

    const errors = [
      new Error('etcdserver: invalid auth token'),
      new Error('etcdserver: invalid auth token'),
      new Error('etcdserver: invalid auth token'),
      new Error('etcdserver: invalid auth token'),
    ];
    range.emitError(errors[0]);
    watch.emitError(errors[1]);
    keepAlive.emitError(errors[2]);
    snapshot.emitError(errors[3]);

    expect(reportStreamError.mock.calls).toEqual([
      [undefined, errors[0], false],
      [undefined, errors[1], false],
      [undefined, errors[2], false],
      [undefined, errors[3], false],
    ]);
    expect(callable.markFailed).not.toHaveBeenCalled();
  });

  it('reports caller cancellation separately from remote stream errors', async () => {
    const metadata = new grpc.Metadata();
    const { stream, emitError } = createResponseStream<IRangeStreamResponse>([]);
    const client = { rangeStream: vi.fn(() => stream) } as unknown as grpc.Client;
    const callable = createCallable(client, metadata, undefined);
    const reportStreamError = vi.fn();
    callable.reportStreamError = reportStreamError;

    const response = await new KVClient(callable).rangeStream({ key: Buffer.from('key') });
    response.cancel();
    const error = Object.assign(new Error('cancelled'), { code: grpc.status.CANCELLED });
    emitError(error);

    expect(reportStreamError).toHaveBeenCalledWith(undefined, error, true);
    expect(callable.markFailed).not.toHaveBeenCalled();

    const remoteError = Object.assign(new Error('unavailable'), {
      code: grpc.status.UNAVAILABLE,
    });
    emitError(remoteError);

    expect(reportStreamError).toHaveBeenLastCalledWith(undefined, remoteError, false);
  });

  it('classifies a native response-stream iterator abort as local cancellation', async () => {
    const metadata = new grpc.Metadata();
    const response = {} as IRangeStreamResponse;
    let emitted = false;
    const stream = Object.assign(
      new Readable({
        objectMode: true,
        read() {
          if (!emitted) {
            emitted = true;
            this.push(response);
          }
        },
      }),
      { cancel: vi.fn() },
    ) as unknown as IResponseStream<IRangeStreamResponse>;
    const client = { rangeStream: vi.fn(() => stream) } as unknown as grpc.Client;
    const callable = createCallable(client, metadata, undefined);
    const reportStreamError = vi.fn();
    callable.reportStreamError = reportStreamError;

    const result = await new KVClient(callable).rangeStream({ key: Buffer.from('key') });
    for await (const item of result) {
      expect(item).toBe(response);
      break;
    }

    await vi.waitFor(() => expect(reportStreamError).toHaveBeenCalledOnce());
    expect(reportStreamError.mock.calls[0][0]).toBeUndefined();
    expect(reportStreamError.mock.calls[0][1]).toMatchObject({
      name: 'AbortError',
      code: 'ABORT_ERR',
    });
    expect(reportStreamError.mock.calls[0][2]).toBe(true);
  });
});
