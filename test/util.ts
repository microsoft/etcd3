import { expect } from 'chai';
import * as fs from 'fs';
import * as tls from 'tls';

import { Etcd3, IOptions } from '../src';

const rootCertificate = fs.readFileSync(`${__dirname}/certs/certs/ca.crt`);
const tlsCert = fs.readFileSync(`${__dirname}/certs/certs/etcd0.localhost.crt`);
const tlsKey = fs.readFileSync(`${__dirname}/certs/private/etcd0.localhost.key`);
const etcdSourceAddress = process.env.ETCD_ADDR || '127.0.0.1:2379';
const [etcdSourceHost, etcdSourcePort] = etcdSourceAddress.split(':');

/**
 * Proxy is a TCP proxy for etcd, used so that we can simulate network failures
 * and disruptions in a cross-platform manner (i.e no reliance on tcpkill
 * or ip link)
 */
export class Proxy {
  public isActive = false;
  public connections: { end: () => void }[] = [];
  private server: tls.Server;
  private host: string;
  private port: number;

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
        const addr = this.server.address();
        this.host = addr.address;
        this.port = addr.port;
        this.isActive = true;
        resolve();
      });

      this.server.on('error', reject);
    });
  }

  /**
   * pause temporarily shuts down the server, but does not 'deactivate' the
   * proxy; new connections will still try to hit it. Can be restored with
   * resume().
   */
  public pause() {
    this.server.close();
    this.connections.forEach(cnx => cnx.end());
    this.connections = [];
  }

  /**
   * Starts up a previously stopped server.
   */
  public resume() {
    this.server.listen(this.port, this.host);
  }

  /**
   * Destroys a previously-active proxy server.
   */
  public deactivate() {
    this.server.close();
    this.isActive = false;
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
      etcdSourcePort,
      etcdSourceHost,
      {
        secureContext: tls.createSecureContext({ ca: rootCertificate }),
        ALPNProtocols: ['h2'],
      },
      () => {
        if (serverBuffer.length > 0) {
          serverCnx.write(Buffer.concat(serverBuffer));
        }

        serverConnected = true;
      },
    );

    let ended = false;
    const end = (err?: Error) => {
      if (err instanceof Error) {
        throw err;
      }

      ended = true;
      clientCnx.end();
      serverCnx.end();
      this.connections = this.connections.filter(c => c.end !== end);
    };

    serverCnx.on('data', (data: Buffer) => {
      if (!ended) {
        clientCnx.write(data);
      }
    });
    serverCnx.on('close', end);
    serverCnx.on('error', end);

    clientCnx.on('data', (data: Buffer) => {
      if (serverConnected && !ended) {
        serverCnx.write(data);
      } else {
        serverBuffer.push(data);
      }
    });
    clientCnx.on('close', end);
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
export function expectReject(promise: Promise<any>, err: { new (message: string): Error }) {
  return promise
    .then(() => {
      throw new Error('expected to reject');
    })
    .catch(actualErr => {
      if (!(actualErr instanceof err)) {
        console.error(actualErr.stack);
        expect(actualErr).to.be.an.instanceof(err);
      }
    });
}

/**
 * Creates an etcd client with the default options and seeds some keys.
 */
export function createTestClientAndKeys(): Promise<Etcd3> {
  const client = new Etcd3(getOptions());
  return Promise.all([
    client.put('foo1').value('bar1'),
    client.put('foo2').value('bar2'),
    client.put('foo3').value('{"value":"bar3"}'),
    client.put('baz').value('bar5'),
  ]).then(() => client);
}

/**
 * Destroys the etcd client and wipes all keys.
 */
export async function tearDownTestClient(client: Etcd3) {
  await client.delete().all();
  client.close();
}
