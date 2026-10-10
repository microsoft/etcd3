/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
import type * as grpc from '@grpc/grpc-js';
import { EventEmitter } from 'node:events';
import { ConnectionPool, normalizeEndpointSyncInterval } from './connection-pool.js';
import { ClientClosedError } from './errors.js';
import type { ClusterClient } from './rpc.js';

const autoSyncTimeout = 5_000;

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Manages the endpoints used by an {@link Etcd3} client.
 *
 * Automatic synchronization failures emit a `warn` event. Explicit calls to
 * {@link EndpointManager.sync} reject instead.
 */
export class EndpointManager extends EventEmitter<{ warn: [error: Error] }> {
  private timer: NodeJS.Timeout | undefined;
  private syncInFlight: Promise<void> | undefined;
  private syncInterval: number | undefined;
  private closed = false;

  /** @internal */
  constructor(
    private readonly pool: ConnectionPool,
    private readonly cluster: ClusterClient,
    syncInterval: number | undefined,
  ) {
    super();
    this.syncInterval = syncInterval;
    this.scheduleSync();
  }

  /**
   * Returns a snapshot of the endpoints currently registered with the client.
   * Assigning replaces the complete endpoint set without waiting for connectivity.
   */
  public get list(): string[] {
    return this.pool.getEndpoints();
  }

  public set list(addresses: string | readonly string[]) {
    this.pool.setEndpoints(addresses);
  }

  /**
   * The duration in milliseconds between automatic membership synchronizations.
   * Assigning resets the pending timer. Assign `undefined` or `0` to disable it.
   */
  public get interval(): number | undefined {
    return this.syncInterval;
  }

  public set interval(value: number | undefined) {
    if (this.closed) {
      throw new ClientClosedError('endpoint');
    }

    const normalized = normalizeEndpointSyncInterval(value);
    this.clearTimer();
    this.syncInterval = normalized;
    if (!this.syncInFlight) {
      this.scheduleSync();
    }
  }

  /**
   * Replaces the endpoint list with client URLs from started voting cluster members.
   * Concurrent synchronizations share the same membership request.
   */
  public sync(options?: grpc.CallOptions): Promise<void> {
    if (this.closed) {
      return Promise.reject(new ClientClosedError('endpoint'));
    }

    if (this.syncInFlight) {
      return this.syncInFlight;
    }

    const generation = this.pool.endpointGeneration;
    const pending = this.cluster
      .memberList({ linearizable: true }, options)
      .then(response => {
        if (this.closed || this.pool.endpointGeneration !== generation) {
          return;
        }

        this.pool.setEndpoints(
          response.members
            .filter(member => member.name !== '' && !member.isLearner)
            .flatMap(member => member.clientURLs),
        );
      })
      .finally(() => {
        if (this.syncInFlight === pending) {
          this.syncInFlight = undefined;
          this.scheduleSync();
        }
      });

    this.syncInFlight = pending;
    return pending;
  }

  /** @internal */
  public close(): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.clearTimer();
  }

  private scheduleSync(): void {
    if (this.closed || this.syncInterval === undefined || this.timer) {
      return;
    }

    this.timer = setTimeout(() => void this.runScheduledSync(), this.syncInterval);
    this.timer.unref();
  }

  private async runScheduledSync(): Promise<void> {
    this.timer = undefined;
    try {
      await this.sync({ deadline: new Date(Date.now() + autoSyncTimeout) });
    } catch (error) {
      if (!this.closed) {
        this.emit('warn', toError(error));
      }
    }
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}
