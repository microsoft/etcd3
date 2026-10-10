/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
import { expect } from 'vitest';
import * as fs from 'node:fs';
import * as tls from 'node:tls';
import { fileURLToPath } from 'node:url';

import { NoopPolicy } from 'cockatiel';
import type { AddressInfo } from 'node:net';
import { Etcd3 } from '../index.js';
import type { IOptions, Namespace } from '../index.js';

const rootPath = fileURLToPath(new URL('../..', import.meta.url));
const rootCertificate = fs.readFileSync(`${rootPath}/src/test/certs/certs/ca.crt`);
const tlsCert = fs.readFileSync(`${rootPath}/src/test/certs/certs/etcd0.localhost.crt`);
const tlsKey = fs.readFileSync(`${rootPath}/src/test/certs/private/etcd0.localhost.key`);
const defaultEtcdAddress = '127.0.0.1:2379';
const etcdSourceAddress = process.env.ETCD_ADDR || defaultEtcdAddress;
const [etcdSourceHost, etcdSourcePort] = etcdSourceAddress.split(':');

export const enum TrafficDirection {
  ToEtcd,
  FromEtcd,
}

export const etcdVersion = process.env.ETCD_VERSION || '3.3.9';

/**
 * Proxy is a TCP proxy for etcd, used so that we can simulate network failures
 * and disruptions in a cross-platform manner (i.e no reliance on tcpkill
 * or ip link)
 */
export class Proxy {
  public isActive = false;
  public connections: Array<{ destroy(): void }> = [];
  private server: tls.Server | undefined;
  private host: string | undefined;
  private port: number | undefined;
  private isListening = false;
  private enabledDataFlows = new Set([TrafficDirection.FromEtcd, TrafficDirection.ToEtcd]);

  /**
   * activate creates the proxy server.
   */
  public activate(): Promise<void> {
    if (this.isActive) {
      return Promise.reject(new Error('Proxy is already active'));
    }

    this.enabledDataFlows.add(TrafficDirection.FromEtcd);
    this.enabledDataFlows.add(TrafficDirection.ToEtcd);

    return new Promise<void>((resolve, reject) => {
      const server = tls.createServer(
        { cert: tlsCert, key: tlsKey, ALPNProtocols: ['h2'] },
        clientCnx => this.handleIncoming(clientCnx),
      );
      this.server = server;

      const onError = (err: Error) => {
        this.server = undefined;
        this.isListening = false;
        reject(err);
      };
      server.once('error', onError);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', onError);
        const addr = server.address() as AddressInfo;
        this.host = addr.address;
        this.port = addr.port;
        this.isListening = true;
        this.isActive = true;
        resolve();
      });
    });
  }

  /**
   * suspend temporarily shuts down the server, but does not deactivate the
   * proxy; new connections will still try to hit it. Can be restored with
   * unsuspend().
   */
  public async suspend() {
    if (!this.server || !this.isListening) {
      return;
    }

    this.connections.slice().forEach(cnx => cnx.destroy());
    await this.closeServer();
  }

  /**
   * Starts up a previously stopped server.
   */
  public async unsuspend() {
    if (!this.server || this.isListening) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const server = this.server!;
      const onError = (err: Error) => {
        server.off('error', onError);
        reject(err);
      };
      server.once('error', onError);
      server.listen(this.port, this.host, () => {
        server.off('error', onError);
        this.isListening = true;
        resolve();
      });
    });
  }

  /**
   * Disables data flowing in one direction on the connection.
   */
  public pause(direction: TrafficDirection) {
    this.enabledDataFlows.delete(direction);
  }

  /**
   * Reenables data flow on the connection.
   */
  public resume(direction: TrafficDirection) {
    this.enabledDataFlows.add(direction);
  }

  /**
   * Destroys a previously-active proxy server.
   */
  public async deactivate() {
    this.isActive = false;
    this.connections.slice().forEach(cnx => cnx.destroy());
    try {
      await this.closeServer();
    } finally {
      this.server = undefined;
      this.host = undefined;
      this.port = undefined;
    }
  }

  /**
   * Returns the address the server is listening on.
   */
  public address() {
    if (this.port === undefined) {
      throw new Error('Proxy is not active');
    }

    return `127.0.0.1:${this.port}`;
  }

  private handleIncoming(clientCnx: tls.TLSSocket) {
    let serverConnected = false;
    const serverBuffer: Buffer[] = [];
    const serverCnx = tls.connect(
      Number(etcdSourcePort),
      etcdSourceHost,
      {
        secureContext: tls.createSecureContext({ ca: rootCertificate }),
        ALPNProtocols: ['h2'],
        servername: 'etcd0.localhost',
      },
      () => {
        if (serverBuffer.length > 0 && !ended) {
          serverCnx.write(Buffer.concat(serverBuffer));
        }

        serverConnected = true;
      },
    );

    let ended = false;
    const end = (source?: tls.TLSSocket, err?: Error) => {
      if (ended) {
        return;
      }

      ended = true;
      this.connections = this.connections.filter(c => c.destroy !== destroy);
      clientCnx.destroy(source === clientCnx ? undefined : err);
      serverCnx.destroy(source === serverCnx ? undefined : err);
    };
    const destroy = () => end();

    serverCnx.on('data', (data: Buffer) => {
      if (ended || !this.enabledDataFlows.has(TrafficDirection.FromEtcd)) {
        return;
      }

      clientCnx.write(data);
    });
    serverCnx.on('end', () => end());
    serverCnx.on('error', err => end(serverCnx, err));
    serverCnx.on('close', () => end());

    clientCnx.on('data', (data: Buffer) => {
      if (ended || !this.enabledDataFlows.has(TrafficDirection.ToEtcd)) {
        return;
      }

      if (serverConnected) {
        serverCnx.write(data);
      } else {
        serverBuffer.push(data);
      }
    });
    clientCnx.on('end', () => end());
    clientCnx.on('error', err => end(clientCnx, err));
    clientCnx.on('close', () => end());

    this.connections.push({ destroy });
  }

  private closeServer(): Promise<void> {
    if (!this.server || !this.isListening) {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      this.server!.close(err => {
        this.isListening = false;
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }
}

export const proxy = new Proxy();

/**
 * Returns the host to test against.
 */
export function getHost(): string {
  if (proxy.isActive) {
    return proxy.address();
  }

  return process.env.ETCD_ADDR || defaultEtcdAddress;
}

/**
 * Returns etcd options to use for connections.
 */
export function getOptions(defaults: Partial<IOptions> = {}): IOptions {
  return {
    hosts: getHost(),
    credentials: { rootCertificate },
    grpcOptions: {
      'grpc.ssl_target_name_override': 'etcd0.localhost',
    },
    faultHandling: {
      global: new NoopPolicy(),
      host: () => new NoopPolicy(),
    },
    ...defaults,
  };
}

/**
 * Returns a promise that throws if the promise is resolved or rejected with
 * something other than the provided constructor
 */
export function expectReject(promise: Promise<any>, err: new (message: string) => Error) {
  return expect(promise).rejects.toBeInstanceOf(err);
}

/**
 * Creates a new test etcd client.
 */
export function createTestClient(): Etcd3 {
  return new Etcd3(getOptions());
}

/**
 * Creates an etcd client with the default options and seeds some keys.
 */
export async function createTestClientAndKeys(): Promise<Etcd3> {
  const client = createTestClient();
  await createTestKeys(client);
  return client;
}

/**
 * Creates test keys in the given namespace.
 */
export async function createTestKeys(client: Namespace) {
  await Promise.all([
    client.put('foo1').value('bar1'),
    client.put('foo2').value('bar2'),
    client.put('foo3').value('{"value":"bar3"}'),
    client.put('baz').value('bar5'),
  ]);
}

/**
 * Destroys the etcd client and wipes all keys.
 */
export async function tearDownTestClient(client: Etcd3) {
  await client?.delete().all();
  client.close();
}

function wipeAll(things: Promise<Array<{ delete(): any }>>) {
  return things.then(items => Promise.all(items.map(item => item.delete())));
}

/**
 * Sets up authentication for the server.
 */
export async function setupAuth(client: Etcd3) {
  await wipeAll(client.getUsers());
  await wipeAll(client.getRoles());

  // We need to set up a root user and root role first, otherwise etcd
  // will yell at us.
  const rootUser = await client.user('root').create('password');
  await rootUser.addRole('root');

  await client.user('connor').create('password');

  const normalRole = await client.role('rw_prefix_f').create();
  await normalRole.grant({
    permission: 'Readwrite',
    range: client.range({ prefix: 'f' }),
  });
  await normalRole.addUser('connor');
  await client.auth.authEnable();
}

/**
 * Removes authentication previously added with `setupAuth`
 */
export async function removeAuth(client: Etcd3) {
  const rootClient = new Etcd3(
    getOptions({
      auth: {
        username: 'root',
        password: 'password',
      },
    }),
  );

  await rootClient.auth.authDisable();
  rootClient.close();

  await wipeAll(client.getUsers());
  await wipeAll(client.getRoles());
}

const compareVersion = (version: string) => {
  const aParts = etcdVersion.split('.').map(Number);
  const bParts = version.split('.').map(Number);
  return aParts.map((a, i) => a - bParts[i]).find(cmp => cmp !== 0) ?? 0;
};

export const isAtLeastVersion = (version: string) => compareVersion(version) >= 0;
export const atAtMostVersion = (version: string) => compareVersion(version) <= 0;

const originalSetTimeout = setTimeout;
export const unmockedDelay = (duration: number) =>
  new Promise(r => originalSetTimeout(r, duration));
