/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
import * as grpc from '@grpc/grpc-js';
import { ChannelOptions } from '@grpc/grpc-js/build/src/channel-options';
import { loadSync } from '@grpc/proto-loader';
import {
  circuitBreaker,
  ConsecutiveBreaker,
  handleWhen,
  IDefaultPolicyContext,
  IPolicy,
  isBrokenCircuitError,
  retry,
} from 'cockatiel';
import {
  castGrpcError,
  ClientClosedError,
  ClientRuntimeError,
  EtcdInvalidAuthTokenError,
  isRecoverableError,
} from './errors';
import { IOptions } from './options';
import { CallContext, ICallable, Services } from './rpc';
import { resolveCallOptions } from './util';

const packageDefinition = loadSync(`${__dirname}/../proto/rpc.proto`, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
});
const services = grpc.loadPackageDefinition(packageDefinition);
const etcdserverpb = services.etcdserverpb as { [service: string]: typeof grpc.Client };

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
  payload: unknown,
): Promise<any> {
  return new Promise((resolve, reject) => {
    (client as any)[method](payload, metadata, options || {}, (err: Error | null, res: any) => {
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

    const ignoreAuth = !auth || !(auth.username && auth.password);
    if (ignoreAuth) {
      return Promise.resolve(new grpc.Metadata());
    }

    const attempt = (index: number, previousRejection?: Error): Promise<grpc.Metadata> => {
      if (index >= hosts.length) {
        this.awaitingMetadata = null;
        return Promise.reject(previousRejection);
      }

      const meta = new grpc.Metadata();
      const host = removeProtocolPrefix(hosts[index]);
      const context: CallContext = {
        method: 'authenticate',
        params: { name: auth.username, password: auth.password },
        service: 'Auth',
        isStream: false,
      };

      return this.getCredentialsFromHost(
        host,
        auth.username,
        auth.password,
        resolveCallOptions(
          resolveCallOptions(undefined, auth.callOptions, context),
          resolveCallOptions(undefined, this.options.defaultCallOptions, context),
          context,
        ),
        this.credentials,
      )
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
    callOptions: grpc.CallOptions | undefined,
    credentials: grpc.ChannelCredentials,
  ): Promise<string> {
    return runServiceCall(
      new etcdserverpb.Auth(address, credentials),
      new grpc.Metadata(),
      callOptions,
      'authenticate',
      { name, password },
    ).then(res => res.token);
  }
}

const defaultCircuitBreaker = () =>
  circuitBreaker(handleWhen(isRecoverableError), {
    halfOpenAfter: 5_000,
    breaker: new ConsecutiveBreaker(3),
  });

/**
 * A Host is one instance of the etcd server, which can contain multiple
 * services. It holds GRPC clients to communicate with the host, and will
 * be removed from the connection pool upon server failures.
 */
export class Host {
  private readonly host: string;
  private closed = false;
  private cachedServices: { [name in keyof typeof Services]?: grpc.Client } = Object.create(null);

  constructor(
    host: string,
    private readonly channelCredentials: grpc.ChannelCredentials,
    private readonly channelOptions?: ChannelOptions,
    public readonly faultHandling: IPolicy<IDefaultPolicyContext> = defaultCircuitBreaker(),
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

    if (this.closed) {
      throw new ClientClosedError(name);
    }

    const newService = new etcdserverpb[name](
      this.host,
      this.channelCredentials,
      this.channelOptions,
    );
    this.cachedServices[name] = newService;
    return newService;
  }

  /**
   * Closes the all clients for the given host, allowing them to be
   * reestablished on subsequent calls.
   */
  public resetAllServices() {
    for (const service of Object.values(this.cachedServices)) {
      if (service) {
        // workaround: https://github.com/grpc/grpc-node/issues/1487
        const state = service.getChannel().getConnectivityState(false);
        if (state === grpc.connectivityState.CONNECTING) {
          service.waitForReady(Date.now() + 10_00, () => setImmediate(() => service.close()));
        } else {
          service.close();
        }
      }
    }

    this.cachedServices = Object.create(null);
  }

  /**
   * Close frees resources associated with the host, tearing down any
   * existing client
   */
  public close() {
    this.resetAllServices();
    this.closed = true;
  }
}

/**
 * Connection wraps GRPC hosts. Note that this wraps the hosts themselves; each
 * host can contain multiple discreet services.
 */
export class ConnectionPool implements ICallable<Host> {
  /**
   * Toggles whether hosts are looped through in a deterministic order.
   * For use in tests, should not be toggled in production/
   */
  public static deterministicOrder = false;

  public readonly callOptionsFactory = this.options.defaultCallOptions;

  private readonly hosts: Host[];
  private readonly globalPolicy: IPolicy<IDefaultPolicyContext> =
    this.options.faultHandling?.global ?? retry(handleWhen(isRecoverableError), { maxAttempts: 3 });
  private mockImpl: ICallable<Host> | null;
  private authenticator: Authenticator;

  constructor(private readonly options: IOptions) {
    const credentials = this.buildAuthentication();
    const { hosts = '127.0.0.1:2379', grpcOptions } = this.options;

    if (typeof hosts === 'string') {
      this.hosts = [
        new Host(hosts, credentials, grpcOptions, options.faultHandling?.host?.(hosts)),
      ];
    } else if (hosts.length === 0) {
      throw new Error('Cannot construct an etcd client with no hosts specified');
    } else {
      this.hosts = hosts.map(
        h => new Host(h, credentials, grpcOptions, options.faultHandling?.host?.(h)),
      );
    }
  }

  /**
   * Sets a mock interface to use instead of hitting real services.
   */
  public mock(callable: ICallable<Host>) {
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
    this.hosts.forEach(host => host.close());
  }

  /**
   * @override
   */
  public async exec<T>(
    serviceName: keyof typeof Services,
    method: string,
    payload: unknown,
    options?: grpc.CallOptions,
  ): Promise<T> {
    if (this.mockImpl) {
      return this.mockImpl.exec(serviceName, method, payload);
    }

    const shuffleGen = this.shuffledHosts();
    let lastError: Error | undefined;

    try {
      return await this.globalPolicy.execute(() =>
        this.withConnection(
          serviceName,
          async ({ client, metadata }) => {
            const resolvedOpts = resolveCallOptions(options, this.callOptionsFactory, {
              service: serviceName,
              method,
              params: payload,
              isStream: false,
            } as CallContext);

            try {
              return await runServiceCall(client, metadata, resolvedOpts, method, payload);
            } catch (err) {
              if (err instanceof EtcdInvalidAuthTokenError) {
                this.authenticator.invalidateMetadata();
                return this.exec(serviceName, method, payload, options);
              }

              lastError = err;
              throw err;
            }
          },
          shuffleGen,
        ),
      );
    } catch (e) {
      // If we ran into an error that caused the a circuit to open, but we had
      // an error before that happened, throw the original error rather than
      // the broken circuit error.
      if (isBrokenCircuitError(e) && lastError && !isBrokenCircuitError(lastError)) {
        throw lastError;
      } else {
        throw e;
      }
    }
  }

  /**
   * @override
   */
  public async withConnection<T>(
    service: keyof typeof Services,
    fn: (args: { resource: Host; client: grpc.Client; metadata: grpc.Metadata }) => Promise<T> | T,
    shuffleGenerator = this.shuffledHosts(),
  ): Promise<T> {
    if (this.mockImpl) {
      return this.mockImpl.withConnection(service, fn);
    }

    const metadata = await this.authenticator.getMetadata();
    let lastError: Error | undefined;
    for (let i = 0; i < this.hosts.length; i++) {
      const host = shuffleGenerator.next().value as Host;
      let didCallThrough = false;
      try {
        return await host.faultHandling.execute(() => {
          didCallThrough = true;
          return fn({ resource: host, client: host.getServiceClient(service), metadata });
        });
      } catch (e) {
        if (isRecoverableError(e)) {
          host.resetAllServices();
        }

        // Check if the call was blocked by some circuit breaker/bulkhead policy
        if (didCallThrough) {
          throw castGrpcError(e);
        }

        lastError = e;
      }
    }

    if (!lastError) {
      throw new ClientRuntimeError('Connection pool has no hosts');
    }

    throw castGrpcError(lastError);
  }

  /**
   * @override
   */
  public markFailed(resource: Host, error: Error): void {
    error = castGrpcError(error);
    let threw = false;

    if (isRecoverableError(error)) {
      resource.resetAllServices();
    }

    resource.faultHandling
      .execute(() => {
        if (!threw) {
          threw = true;
          throw error;
        }
      })
      .catch(() => undefined);
  }

  /**
   * A generator function that endlessly loops through hosts in a
   * fisher-yates shuffle for each iteration.
   */
  private *shuffledHosts() {
    const hosts = this.hosts.slice();

    while (true) {
      for (let i = hosts.length - 1; i >= 0; i--) {
        const idx = ConnectionPool.deterministicOrder ? i : Math.floor((i + 1) * Math.random());
        [hosts[idx], hosts[i]] = [hosts[i], hosts[idx]];
        yield hosts[i];
      }
    }
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
