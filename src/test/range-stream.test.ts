/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
import * as grpc from '@grpc/grpc-js';
import { describe, expect, it, vi } from 'vitest';

import { MultiRangeBuilder } from '../builder.js';
import * as RPC from '../rpc.js';
import { NSApplicator } from '../util.js';

class FakeResponseStream<T> implements RPC.IResponseStream<T> {
  public readonly cancel = vi.fn<() => void>();

  constructor(
    private readonly chunks: readonly T[],
    private readonly error?: Error,
  ) {}

  public on(event: 'data', fn: (item: T) => void): this;
  public on(event: 'end', fn: () => void): this;
  public on(event: 'status', fn: (status: grpc.StatusObject) => void): this;
  public on(event: 'error', fn: (error: Error) => void): this;
  public on(
    _event: 'data' | 'end' | 'status' | 'error',
    _fn:
      | ((item: T) => void)
      | (() => void)
      | ((status: grpc.StatusObject) => void)
      | ((error: Error) => void),
  ): this {
    void _event;
    void _fn;
    return this;
  }

  public async *[Symbol.asyncIterator](): AsyncIterableIterator<T> {
    for (const chunk of this.chunks) {
      yield chunk;
    }

    if (this.error) {
      throw this.error;
    }
  }
}

interface IRangeStreamCall {
  service?: keyof typeof RPC.Services;
  request?: RPC.IRangeRequest;
  options?: grpc.CallOptions;
}

function createBuilder(stream: RPC.IResponseStream<RPC.IRangeStreamResponse>) {
  const call: IRangeStreamCall = {};
  const rawClient = {
    rangeStream(
      request: RPC.IRangeRequest,
      _metadata: grpc.Metadata,
      options?: grpc.CallOptions,
    ): RPC.IResponseStream<RPC.IRangeStreamResponse> {
      call.request = request;
      call.options = options;
      return stream;
    },
  };
  const callable: RPC.ICallable<unknown> = {
    callOptionsFactory: undefined,
    exec<T>(): Promise<T> {
      return Promise.reject(new Error('Unexpected unary request'));
    },
    withConnection<R>(
      service: keyof typeof RPC.Services,
      fn: (args: {
        resource: unknown;
        client: grpc.Client;
        metadata: grpc.Metadata;
      }) => Promise<R> | R,
    ): Promise<R> {
      call.service = service;
      return Promise.resolve(
        fn({
          resource: undefined,
          // KVClient invokes generated grpc methods dynamically.
          client: rawClient as unknown as grpc.Client,
          metadata: new grpc.Metadata(),
        }),
      );
    },
    markFailed: () => undefined,
  };

  return {
    builder: new MultiRangeBuilder(
      new RPC.KVClient(callable),
      new NSApplicator(Buffer.from('tenant/')),
    ),
    call,
  };
}

function header(revision: string): RPC.IResponseHeader {
  return {
    cluster_id: 'cluster-id',
    member_id: 'member-id',
    revision,
    raft_term: '7',
  };
}

function keyValue(key: string, value: string, version: string): RPC.IKeyValue {
  return {
    key: Buffer.from(key),
    value: Buffer.from(value),
    create_revision: '9007199254740991',
    mod_revision: '9007199254740992',
    version,
    lease: '9',
  };
}

function rangeResponse(
  revision: string,
  kvs: RPC.IKeyValue[],
  more: boolean,
  count: string,
): RPC.IRangeResponse {
  return { header: header(revision), kvs, more, count };
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const chunks: T[] = [];
  for await (const chunk of iterable) {
    chunks.push(chunk);
  }

  return chunks;
}

describe('MultiRangeBuilder.stream()', () => {
  it('forwards its namespaced request and call options', async () => {
    const stream = new FakeResponseStream<RPC.IRangeStreamResponse>([]);
    const { builder, call } = createBuilder(stream);
    const options: grpc.CallOptions = {
      deadline: new Date('2026-09-04T17:30:00.000Z'),
    };

    await collect(
      builder
        .prefix('items/')
        .revision('9007199254740993')
        .serializable(true)
        .minModRevision('5')
        .options(options)
        .stream(),
    );

    expect(call.service).toBe('KV');
    expect(call.request).toEqual({
      key: Buffer.from('tenant/items/'),
      range_end: Buffer.from('tenant/items0'),
      revision: '9007199254740993',
      serializable: true,
      min_mod_revision: '5',
    });
    expect(call.options).toBe(options);
    expect(stream.cancel).not.toHaveBeenCalled();
  });

  it('yields ordered, unprefixed response chunks without losing response fields', async () => {
    const first: RPC.IRangeStreamResponse = {
      range_response: rangeResponse(
        '101',
        [keyValue('tenant/first', 'first value', '1')],
        true,
        'unfinalized-count',
      ),
    };
    const final: RPC.IRangeStreamResponse = {
      range_response: rangeResponse(
        '102',
        [keyValue('tenant/second', 'second value', '2')],
        false,
        '2',
      ),
    };
    const stream = new FakeResponseStream([first, final]);
    const { builder } = createBuilder(stream);

    const chunks = await collect(builder.stream());

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe(first.range_response);
    expect(chunks[1]).toBe(final.range_response);
    expect(chunks).toEqual([
      rangeResponse('101', [keyValue('first', 'first value', '1')], true, 'unfinalized-count'),
      rangeResponse('102', [keyValue('second', 'second value', '2')], false, '2'),
    ]);
    expect(stream.cancel).not.toHaveBeenCalled();
  });

  it('propagates response stream errors', async () => {
    const error = new Error('range stream failed');
    const stream = new FakeResponseStream<RPC.IRangeStreamResponse>([], error);
    const { builder } = createBuilder(stream);

    await expect(collect(builder.stream())).rejects.toBe(error);
    expect(stream.cancel).toHaveBeenCalledTimes(1);
  });

  it('cancels the response stream when iteration ends early', async () => {
    const stream = new FakeResponseStream<RPC.IRangeStreamResponse>([
      { range_response: rangeResponse('101', [keyValue('tenant/first', 'first value', '1')], true, '2') },
      { range_response: rangeResponse('102', [keyValue('tenant/second', 'second value', '2')], false, '2') },
    ]);
    const { builder } = createBuilder(stream);

    for await (const chunk of builder.stream()) {
      expect(chunk.kvs[0].key).toEqual(Buffer.from('first'));
      break;
    }

    expect(stream.cancel).toHaveBeenCalledTimes(1);
  });
});
