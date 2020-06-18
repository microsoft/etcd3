/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
import { expect } from 'chai';
import * as fs from 'fs';
import * as tls from 'tls';

import { Etcd3, IOptions, Namespace } from '..';
import { AddressInfo } from 'net';
import { resolve } from 'path';

const rootPath = resolve(__dirname, '..', '..');
const rootCertificate = fs.readFileSync(`${rootPath}/src/test/certs/certs/ca.crt`);
const tlsCert = fs.readFileSync(`${rootPath}/src/test/certs/certs/etcd0.localhost.crt`);
const tlsKey = fs.readFileSync(`${rootPath}/src/test/certs/private/etcd0.localhost.key`);
const etcdSourceAddress = process.env.ETCD_ADDR || '127.0.0.1:2379';
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
  public connections: Array<{ end(): void }> = [];
  private server: tls.Server;
  private host: string;
  private port: number;
  private enabledDataFlows = new Set([TrafficDirection.FromEtcd, TrafficDirection.ToEtcd]);

  /**
   * activate creates the proxy server.
   */
  public activate(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.server = tls.createServer(
        { cert: tlsCert, key: tlsKey, ALPNProtocols: ['h2'] },
        clientCnx => this.handleIncoming(clientCnx),
      );

      this.server.listen(0, '127.0.0.1');
      this.server.on('listening', () => {
        const addr = this.server.address() as AddressInfo;
        this.host = addr.address;
        this.port = addr.port;
        this.isActive = true;
        resolve();
      });

      this.server.on('error', reject);
    });
  }

  /**
   * suspend temporarily shuts down the server, but does not 'deactivate' the
   * proxy; new connections will still try to hit it. Can be restored with
   * resume().
   */
  public suspend() {
    this.server.close();
    this.connections.forEach(cnx => cnx.end());
    this.connections = [];
  }

  /**
   * Starts up a previously stopped server.
   */
  public unsuspend() {
    this.server.listen(this.port, this.host);
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
    await new Promise(r => this.server.close(r));
  }

  /**
   * Returns the address the server is listening on.
   */
  public address() {
    return `${this.host}:${this.port}`;
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
      },
      () => {
        if (serverBuffer.length > 0 && !ended) {
          serverCnx.write(Buffer.concat(serverBuffer));
        }

        serverConnected = true;
      },
    );

    let ended = false;
    const end = (err?: Error) => {
      ended = true;
      if (err instanceof Error) {
        throw err;
      }

      clientCnx.end();
      serverCnx.end();
      this.connections = this.connections.filter(c => c.end !== end);
    };

    serverCnx.on('data', (data: Buffer) => {
      if (ended || !this.enabledDataFlows.has(TrafficDirection.FromEtcd)) {
        return;
      }

      clientCnx.write(data);
    });
    serverCnx.on('end', end);
    serverCnx.on('error', end);

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
    clientCnx.on('end', end);
    clientCnx.on('error', end);

    this.connections.push({ end });
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

  return process.env.ETCD_ADDR || '127.0.0.1:2379';
}

/**
 * Returns etcd options to use for connections.
 */
export function getOptions(defaults: Partial<IOptions> = {}): IOptions {
  return {
    hosts: getHost(),
    credentials: { rootCertificate },
    ...defaults,
  };
}

/**
 * Returns a promise that throws if the promise is resolved or rejected with
 * something other than the provided constructor
 */
export function expectReject(promise: Promise<any>, err: new (message: string) => Error) {
  return promise
    .then(() => {
      throw new Error('expected to reject');
    })
    .catch(actualErr => {
      if (!(actualErr instanceof err)) {
        // tslint:disable-next-line
        console.error(actualErr.stack);
        expect(actualErr).to.be.an.instanceof(err);
      }
    });
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
