/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
import * as grpc from '@grpc/grpc-js';
import type { ChannelOptions } from '@grpc/grpc-js';
import { loadSync } from '@grpc/proto-loader';
import { fileURLToPath } from 'node:url';
import {
  circuitBreaker,
  ConsecutiveBreaker,
  handleWhen,
  isBrokenCircuitError,
  retry,
} from 'cockatiel';
import type { IDefaultPolicyContext, IPolicy } from 'cockatiel';
import {
  castGrpcError,
  ClientClosedError,
  ClientRuntimeError,
  EtcdInvalidAuthTokenError,
  GRPCCancelledError,
  isRecoverableError,
} from './errors.js';
import type { IEndpointOptions, IOptions } from './options.js';
import type { CallContext, ICallable, Services } from './rpc.js';
import { resolveCallOptions } from './util.js';

const packageDefinition = loadSync(fileURLToPath(new URL('../proto/rpc.proto', import.meta.url)), {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
});
const services = grpc.loadPackageDefinition(packageDefinition);
const etcdserverpb = services.etcdserverpb as { [service: string]: typeof grpc.Client };

const defaultEndpoint = '127.0.0.1:2379';
const insecureProtocolPrefix = 'http:';
const maxTimerDuration = 2_147_483_647;
const secureProtocolPrefix = 'https:';

interface INormalizedEndpointOptions {
  addresses: string[];
  syncInterval: number | undefined;
}

export function normalizeEndpointSyncInterval(interval: number | undefined): number | undefined {
  if (interval === undefined || interval === 0) {
    return undefined;
  }

  if (!Number.isSafeInteger(interval) || interval < 0 || interval > maxTimerDuration) {
    throw new Error(`Endpoint sync interval must be an integer from 0 to ${maxTimerDuration}`);
  }

  return interval;
}

function normalizeEndpointOptions(hosts: IOptions['hosts']): INormalizedEndpointOptions {
  let addresses: string | readonly string[];
  let syncInterval: number | undefined;

  if (typeof hosts === 'string' || Array.isArray(hosts)) {
    addresses = hosts;
  } else {
    const endpointOptions = hosts as IEndpointOptions;
    addresses = endpointOptions.address ?? defaultEndpoint;
    syncInterval = endpointOptions.syncInterval;
  }

  const normalized = typeof addresses === 'string' ? [addresses] : [...addresses];
  if (normalized.length === 0) {
    throw new Error('Cannot construct an etcd client with no hosts specified');
  }

  return {
    addresses: normalized,
    syncInterval: normalizeEndpointSyncInterval(syncInterval),
  };
}

/**
 * Strips the https?:// from the start of the connection string.
 * @param {string} name [description]
 */
function removeProtocolPrefix(name: string) {
  return name.replace(/^https?:\/\//, '');
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isIteratorAbortError(error: Error): boolean {
  return error.name === 'AbortError' && 'code' in error && error.code === 'ABORT_ERR';
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
  private readonly awaitingMetadata = new Map<string, Promise<grpc.Metadata>>();

  constructor(
    private readonly options: IOptions,
    private readonly credentials: grpc.ChannelCredentials,
  ) {}

  /**
   * Invalides the cached metadata. Clients should call this if they detect
   * that the authentication is no longer valid.
   */
  public invalidateMetadata(host?: string): void {
    if (host === undefined) {
      this.awaitingMetadata.clear();
    } else {
      this.awaitingMetadata.delete(host);
    }
  }

  /**
   * Returns metadata used to make a call to a specific etcd member.
   */
  public getMetadata(host: string): Promise<grpc.Metadata> {
    const existing = this.awaitingMetadata.get(host);
    if (existing) {
      return existing;
    }

    const auth = this.options.auth;
    if (!auth) {
      return Promise.resolve(new grpc.Metadata());
    }

    const context: CallContext = {
      method: 'authenticate',
      params: { name: auth.username, password: auth.password },
      service: 'Auth',
      isStream: false,
    };
    let pending: Promise<grpc.Metadata>;
    pending = this.getCredentialsFromHost(
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
        const metadata = new grpc.Metadata();
        metadata.set('token', token);
        return metadata;
      })
      .catch(error => {
        if (this.awaitingMetadata.get(host) === pending) {
          this.awaitingMetadata.delete(host);
        }
        throw error;
      });
    this.awaitingMetadata.set(host, pending);
    return pending;
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
    const client = new etcdserverpb.Auth(address, credentials, this.options.grpcOptions);
    return runServiceCall(client, new grpc.Metadata(), callOptions, 'authenticate', {
      name,
      password,
    })
      .then(res => res.token)
      .finally(() => client.close());
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
  public readonly address: string;
  private closed = false;
  private cachedServices: { [name in keyof typeof Services]?: grpc.Client } = Object.create(null);

  constructor(
    host: string,
    private readonly channelCredentials: grpc.ChannelCredentials,
    private readonly channelOptions?: ChannelOptions,
    public readonly faultHandling: IPolicy<IDefaultPolicyContext> = defaultCircuitBreaker(),
  ) {
    this.address = removeProtocolPrefix(host);
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
      this.address,
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
          service.waitForReady(Date.now() + 10_000, () => setImmediate(() => service.close()));
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

  public readonly callOptionsFactory: IOptions['defaultCallOptions'];
  public readonly syncInterval: number | undefined;
  private hosts: Host[];
  private endpointList: string[];
  private generation = 0;
  private closed = false;
  private readonly globalPolicy: IPolicy<IDefaultPolicyContext>;
  private mockImpl: ICallable<Host> | null = null;
  private readonly authenticator: Authenticator;
  private readonly channelCredentials: grpc.ChannelCredentials;
  private readonly secureTransport: boolean;

  constructor(private readonly options: IOptions) {
    const endpointOptions = normalizeEndpointOptions(options.hosts);
    this.syncInterval = endpointOptions.syncInterval;
    this.callOptionsFactory = options.defaultCallOptions;
    this.globalPolicy =
      options.faultHandling?.global ?? retry(handleWhen(isRecoverableError), { maxAttempts: 3 });

    this.secureTransport =
      options.credentials !== undefined || this.hasSecureHost(endpointOptions.addresses);
    this.validateEndpointTransport(endpointOptions.addresses);
    this.channelCredentials = this.buildAuthentication();
    this.authenticator = new Authenticator(options, this.channelCredentials);
    this.endpointList = endpointOptions.addresses;
    this.hosts = endpointOptions.addresses.map(address => this.createHost(address));
  }

  /**
   * Returns a copy of the endpoints currently registered in the pool.
   */
  public getEndpoints(): string[] {
    return this.endpointList.slice();
  }

  /**
   * Replaces all endpoints registered in the pool without waiting for them to connect.
   */
  public setEndpoints(addresses: string | readonly string[]): void {
    if (this.closed) {
      throw new ClientClosedError('endpoint');
    }

    const nextEndpoints = typeof addresses === 'string' ? [addresses] : [...addresses];
    if (nextEndpoints.length === 0) {
      throw new Error('Cannot configure an etcd client with no hosts specified');
    }

    this.validateEndpointTransport(nextEndpoints);

    const availableHosts = new Map<string, Host[]>();
    for (const host of this.hosts) {
      const matches = availableHosts.get(host.address);
      if (matches) {
        matches.push(host);
      } else {
        availableHosts.set(host.address, [host]);
      }
    }

    const createdHosts: Host[] = [];
    let nextHosts: Host[];
    try {
      nextHosts = nextEndpoints.map(address => {
        const existing = availableHosts.get(removeProtocolPrefix(address))?.shift();
        if (existing) {
          return existing;
        }

        const host = this.createHost(address);
        createdHosts.push(host);
        return host;
      });
    } catch (error) {
      createdHosts.forEach(host => host.close());
      throw error;
    }

    const removedHosts = [...availableHosts.values()].flat();
    const retainedAddresses = new Set(nextHosts.map(host => host.address));
    this.endpointList = nextEndpoints;
    this.hosts = nextHosts;
    this.generation++;

    for (const host of removedHosts) {
      host.close();
      if (!retainedAddresses.has(host.address)) {
        this.authenticator.invalidateMetadata(host.address);
      }
    }
  }

  /**
   * Returns a version that changes each time the endpoint list is replaced.
   */
  public get endpointGeneration(): number {
    return this.generation;
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
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.hosts.forEach(host => host.close());
    this.authenticator.invalidateMetadata();
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
      return this.mockImpl.exec(serviceName, method, payload, options);
    }

    let lastError: Error | undefined;
    let invalidTokenHost: Host | undefined;

    for (let authAttempts = 0; authAttempts < 2; authAttempts++) {
      try {
        let generation = this.generation;
        let hosts = this.hosts.slice();
        let shuffledHosts = this.shuffledHosts(hosts);
        let hostGenerator =
          invalidTokenHost && hosts.includes(invalidTokenHost)
            ? this.hostsStartingWith(invalidTokenHost, shuffledHosts, hosts.length)
            : shuffledHosts;

        return await this.globalPolicy.execute(() => {
          if (generation !== this.generation) {
            generation = this.generation;
            hosts = this.hosts.slice();
            shuffledHosts = this.shuffledHosts(hosts);
            hostGenerator =
              invalidTokenHost && hosts.includes(invalidTokenHost)
                ? this.hostsStartingWith(invalidTokenHost, shuffledHosts, hosts.length)
                : shuffledHosts;
          }

          return this.withConnection(
            serviceName,
            async ({ resource, client, metadata }) => {
              const resolvedOpts = resolveCallOptions(options, this.callOptionsFactory, {
                service: serviceName,
                method,
                params: payload,
                isStream: false,
              } as CallContext);

              try {
                return await runServiceCall(client, metadata, resolvedOpts, method, payload);
              } catch (error) {
                const err = toError(error);
                if (err instanceof EtcdInvalidAuthTokenError) {
                  this.authenticator.invalidateMetadata(resource.address);
                  invalidTokenHost = resource;
                }

                lastError = err;
                throw err;
              }
            },
            hostGenerator,
            hosts.length,
          );
        });
      } catch (error) {
        const err = toError(error);
        if (err instanceof EtcdInvalidAuthTokenError && authAttempts === 0 && invalidTokenHost) {
          continue;
        }

        // If we ran into an error that caused the a circuit to open, but we had
        // an error before that happened, throw the original error rather than
        // the broken circuit error.
        if (isBrokenCircuitError(err) && lastError && !isBrokenCircuitError(lastError)) {
          throw lastError;
        }

        throw error;
      }
    }

    throw new ClientRuntimeError('Authentication retry did not complete');
  }

  /**
   * Produces hosts indefinitely, starting each pass with the host whose token must be refreshed.
   */
  private *hostsStartingWith(
    first: Host,
    fallback: Generator<Host>,
    hostCount: number,
  ): Generator<Host> {
    while (true) {
      yield first;
      const yielded = new Set([first]);
      while (yielded.size < hostCount) {
        const next = fallback.next();
        if (next.done) {
          return;
        }

        const host = next.value;
        if (!yielded.has(host)) {
          yielded.add(host);
          yield host;
        }
      }
    }
  }

  /**
   * @override
   */
  public async withConnection<T>(
    service: keyof typeof Services,
    fn: (args: { resource: Host; client: grpc.Client; metadata: grpc.Metadata }) => Promise<T> | T,
    shuffleGenerator?: Generator<Host>,
    hostCount?: number,
  ): Promise<T> {
    if (this.mockImpl) {
      return this.mockImpl.withConnection(service, fn);
    }

    const hosts = this.hosts.slice();
    const generator = shuffleGenerator ?? this.shuffledHosts(hosts);
    let lastError: Error | undefined;
    for (let i = 0; i < (hostCount ?? hosts.length); i++) {
      const next = generator.next();
      if (next.done) {
        break;
      }

      const host = next.value;
      let didCallThrough = false;
      try {
        const metadata = await this.authenticator.getMetadata(host.address);
        return await host.faultHandling.execute(() => {
          didCallThrough = true;
          return fn({ resource: host, client: host.getServiceClient(service), metadata });
        });
      } catch (error) {
        const err = toError(error);
        if (isRecoverableError(err)) {
          host.resetAllServices();
        }

        // Check if the call was blocked by some circuit breaker/bulkhead policy
        if (didCallThrough) {
          throw castGrpcError(err);
        }

        lastError = err;
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
   * Records a stream error after translating it to the library's error type.
   */
  public reportStreamError(resource: Host, error: Error, locallyCancelled: boolean): void {
    const typedError = castGrpcError(error);
    if (typedError instanceof EtcdInvalidAuthTokenError) {
      this.authenticator.invalidateMetadata(resource.address);
    }

    if (
      locallyCancelled &&
      (typedError instanceof GRPCCancelledError || isIteratorAbortError(error))
    ) {
      return;
    }

    this.markFailed(resource, typedError);
  }

  /**
   * A generator function that endlessly loops through hosts in a
   * fisher-yates shuffle for each iteration.
   */
  private *shuffledHosts(source = this.hosts) {
    const hosts = source.slice();

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
    } else if (this.secureTransport) {
      protocolCredentials = grpc.credentials.createSsl();
    }

    return protocolCredentials;
  }

  /**
   * Returns whether any configured host is set up to use TLS.
   */
  private hasSecureHost(hosts: readonly string[]): boolean {
    const countSecure = hosts.filter(host => host.startsWith(secureProtocolPrefix)).length;
    if (countSecure === 0) {
      return false;
    }
    if (countSecure < hosts.length) {
      throw new Error('etcd3 cannot be configured with a mix of secure and insecure hosts');
    }

    return true;
  }

  private validateEndpointTransport(addresses: readonly string[]): void {
    const hasSecure = addresses.some(address => address.startsWith(secureProtocolPrefix));
    const hasInsecure = addresses.some(address => address.startsWith(insecureProtocolPrefix));

    if (
      (hasSecure && hasInsecure) ||
      (hasSecure && !this.secureTransport) ||
      (hasInsecure && this.secureTransport)
    ) {
      throw new Error('etcd3 cannot be configured with a mix of secure and insecure hosts');
    }
  }

  private createHost(address: string): Host {
    return new Host(
      address,
      this.channelCredentials,
      this.options.grpcOptions,
      this.options.faultHandling?.host?.(address),
    );
  }
}
