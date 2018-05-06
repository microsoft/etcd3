import * as grpc from 'grpc';

import { ExponentialBackoff } from './backoff/exponential';
import { castGrpcError, EtcdInvalidAuthTokenError, GRPCGenericError } from './errors';
import { IOptions } from './options';
import { ICallable, Services } from './rpc';
import { SharedPool } from './shared-pool';
import { forOwn } from './util';

const services = grpc.load(`${__dirname}/../proto/rpc.proto`);

export const defaultBackoffStrategy = new ExponentialBackoff({
  initial: 300,
  max: 10 * 1000,
  random: 1,
});

const secureProtocolPrefix = 'https:';

/**
 * Strips the https?:// from the start of the connection string.
 * @param {string} name [description]
 */
function removeProtocolPrefix(name: string) {
  return name.replace(/^https?:\/\//, '');
}

/**
 * Executes a grpc service calls, casting the error (if any) and wrapping
 * into a Promise.
 */
function runServiceCall(
  client: grpc.Client,
  metadata: grpc.Metadata,
  options: grpc.CallOptions | undefined,
  method: string,
  payload: object,
): Promise<any> {
  return new Promise((resolve, reject) => {
    (<any>client)[method](payload, metadata, options, (err: Error | null, res: any) => {
      if (err) {
        reject(castGrpcError(err));
      } else {
        resolve(res);
      }
    });
  });
}

/**
 * Retrieves and returns an auth token for accessing etcd. This function is
 * based on the algorithm in {@link https://git.io/vHzwh}.
 */
class Authenticator {
  private awaitingMetadata: Promise<grpc.Metadata> | null = null;

  constructor(
    private readonly options: IOptions,
    private readonly credentials: grpc.ChannelCredentials,
  ) {}

  /**
   * Invalides the cached metadata. Clients should call this if they detect
   * that the authentication is no longer valid.
   */
  public invalidateMetadata(): void {
    this.awaitingMetadata = null;
  }

  /**
   * Returns metadata used to make a call to etcd.
   */
  public getMetadata(): Promise<grpc.Metadata> {
    if (this.awaitingMetadata !== null) {
      return this.awaitingMetadata;
    }

    const hosts =
      typeof this.options.hosts === 'string' ? [this.options.hosts] : this.options.hosts;
    const auth = this.options.auth;

    if (!auth) {
      return Promise.resolve(new grpc.Metadata());
    }

    const attempt = (index: number, previousRejection?: Error): Promise<grpc.Metadata> => {
      if (index >= hosts.length) {
        this.awaitingMetadata = null;
        return Promise.reject(previousRejection);
      }

      const meta = new grpc.Metadata();
      const host = removeProtocolPrefix(hosts[index]);
      return this.getCredentialsFromHost(host, auth.username, auth.password, this.credentials)
        .then(token => {
          meta.set('token', token);
          return meta;
        })
        .catch(err => attempt(index + 1, err));
    };

    return (this.awaitingMetadata = attempt(0));
  }

  /**
   * Retrieves an auth token from etcd.
   */
  private getCredentialsFromHost(
    address: string,
    name: string,
    password: string,
    credentials: grpc.ChannelCredentials,
  ): Promise<string> {
    return runServiceCall(
      new services.etcdserverpb.Auth(address, credentials),
      new grpc.Metadata(),
      undefined,
      'authenticate',
      { name, password },
    ).then(res => res.token);
  }
}

/**
 * A Host is one instance of the etcd server, which can contain multiple
 * services. It holds GRPC clients to communicate with the host, and will
 * be removed from the connection pool upon server failures.
 */
export class Host {
  private readonly host: string;
  private cachedServices: { [name in keyof typeof Services]?: grpc.Client } = Object.create(null);

  constructor(
    host: string,
    private readonly channelCredentials: grpc.ChannelCredentials,
    private readonly channelOptions?: grpc.ChannelOptions,
  ) {
    this.host = removeProtocolPrefix(host);
  }

  /**
   * Returns the given GRPC service on the current host.
   */
  public getServiceClient(name: keyof typeof Services): grpc.Client {
    const service = this.cachedServices[name];
    if (service) {
      return service;
    }

    const newService = new services.etcdserverpb[name](
      this.host,
      this.channelCredentials,
      this.channelOptions,
    );
    this.cachedServices[name] = newService;
    return newService;
  }

  /**
   * Close frees resources associated with the host, tearing down any
   * existing client
   */
  public close() {
    forOwn(this.cachedServices, (service: grpc.Client) => grpc.closeClient(service));
    this.cachedServices = Object.create(null);
  }
}

/**
 * Connection wraps GRPC hosts. Note that this wraps the hosts themselves; each
 * host can contain multiple discreet services.
 */
export class ConnectionPool implements ICallable {
  private pool = new SharedPool<Host>(this.options.backoffStrategy || defaultBackoffStrategy);
  private mockImpl: ICallable | null;
  private authenticator: Authenticator;

  constructor(private options: IOptions) {
    this.seedHosts();
  }

  /**
   * Sets a mock interface to use instead of hitting real services.
   */
  public mock(callable: ICallable) {
    this.mockImpl = callable;
  }

  /**
   * Removes any existing mock.
   */
  public unmock() {
    this.mockImpl = null;
  }

  /**
   * Tears down all ongoing connections and resoruces.
   */
  public close() {
    this.pool.all().forEach(host => host.close());
  }

  /**
   * @override
   */
  public exec(
    serviceName: keyof typeof Services,
    method: string,
    payload: object,
    options?: grpc.CallOptions,
  ): Promise<any> {
    if (this.mockImpl) {
      return this.mockImpl.exec(serviceName, method, payload);
    }

    return this.getConnection(serviceName).then(({ host, client, metadata }) => {
      return runServiceCall(client, metadata, options, method, payload)
        .then(res => {
          this.pool.succeed(host);
          return res;
        })
        .catch(err => {
          if (err instanceof EtcdInvalidAuthTokenError) {
            this.authenticator.invalidateMetadata();
            return this.exec(serviceName, method, payload, options);
          }

          if (err instanceof GRPCGenericError) {
            this.pool.fail(host);
            host.close();

            if (this.pool.available().length && this.options.retry) {
              return this.exec(serviceName, method, payload, options);
            }
          }

          throw err;
        });
    });
  }

  /**
   * @override
   */
  public getConnection(
    service: keyof typeof Services,
  ): Promise<{ host: Host; client: grpc.Client; metadata: grpc.Metadata }> {
    if (this.mockImpl) {
      return Promise.resolve(<any>this.mockImpl.getConnection(service)).then(connection => ({
        metadata: new grpc.Metadata(),
        ...connection,
      }));
    }

    return Promise.all([this.pool.pull(), this.authenticator.getMetadata()]).then(
      ([host, metadata]) => {
        const client = host.getServiceClient(service);
        return { client, host, metadata };
      },
    );
  }

  /**
   * Adds configured etcd hosts to the connection pool.
   */
  private seedHosts() {
    const credentials = this.buildAuthentication();
    const { hosts, grpcOptions } = this.options;

    if (typeof hosts === 'string') {
      this.pool.add(new Host(hosts, credentials, grpcOptions));
      return;
    }

    if (hosts.length === 0) {
      throw new Error('Cannot construct an etcd client with no hosts specified');
    }

    hosts.forEach(host => this.pool.add(new Host(host, credentials, grpcOptions)));
  }

  /**
   * Creates authentication credentials to use for etcd clients.
   */
  private buildAuthentication(): grpc.ChannelCredentials {
    const { credentials } = this.options;

    let protocolCredentials = grpc.credentials.createInsecure();
    if (credentials) {
      protocolCredentials = grpc.credentials.createSsl(
        credentials.rootCertificate,
        credentials.privateKey,
        credentials.certChain,
      );
    } else if (this.hasSecureHost()) {
      protocolCredentials = grpc.credentials.createSsl();
    }

    this.authenticator = new Authenticator(this.options, protocolCredentials);
    return protocolCredentials;
  }

  /**
   * Returns whether any configured host is set up to use TLS.
   */
  private hasSecureHost(): boolean {
    const { hosts } = this.options;
    if (typeof hosts === 'string') {
      return hosts.startsWith(secureProtocolPrefix);
    }

    const countSecure = hosts.filter(host => host.startsWith(secureProtocolPrefix)).length;
    if (countSecure === 0) {
      return false;
    }
    if (countSecure < hosts.length) {
      throw new Error('etcd3 cannot be configured with a mix of secure and insecure hosts');
    }

    return true;
  }
}
