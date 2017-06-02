import { ExponentialBackoff } from './backoff/exponential';
import { castGrpcError, GRPCGenericError } from './errors';
import { IOptions } from './options';
import { ICallable, Services, IAuthenticateResponse } from './rpc';
import { SharedPool } from './shared-pool';
import { forOwn } from './util';

const grpc = require('grpc'); // tslint:disable-line
const services = grpc.load(`${__dirname}/../proto/rpc.proto`);

/**
 * Super primitive client descriptor. Used for some basic type-safety when
 * wrapping in an RPC client.
 */
export interface IRawGRPC {
  [method: string]: (req: any, callback: (err: Error, res: any) => void) => void;
}

export const defaultBackoffStrategy = new ExponentialBackoff({
  initial: 300,
  max: 10 * 1000,
  random: 1,
});

/**
 * Used for typing internally.
 */
interface GRPCCredentials {
  isGRPCCredential: void;
}

/**
 * Retrieves and returns an auth token for accessing etcd. This function is
 * based on the algorithm in {@link https://git.io/vHzwh}.
 */
class Authentictor {
  private awaitingToken: Promise<GRPCCredentials> | null = null;

  constructor(private options: IOptions) {}

  /**
   * Augments the call credentials with the configured username and password,
   * if any.
   */
  public augmentCredentials(original: GRPCCredentials): Promise<GRPCCredentials> {
    if (this.awaitingToken !== null) {
      return this.awaitingToken;
    }

    const hosts = typeof this.options.hosts === 'string'
      ? [this.options.hosts]
      : this.options.hosts;
    const auth = this.options.auth;

    if (!auth) {
      return Promise.resolve(original);
    }

    const attempt = (index: number, previousRejection?: Error): Promise<GRPCCredentials> => {
      if (index > hosts.length) {
        this.awaitingToken = null;
        return Promise.reject(previousRejection);
      }

      return this.getCredentialsFromHost(hosts[index], auth, original)
        .then(token => {
          this.awaitingToken = null;
          return grpc.credentials.combineChannelCredentials(
            original, this.createMetadataAugmenter(token));
        })
        .catch(err => attempt(index + 1, err));
    };

    return this.awaitingToken = attempt(0);
  }

  /**
   * Retrieves an auth token from etcd.
   */
  private getCredentialsFromHost(address: string, auth: { username: string, password: string},
    credentials: GRPCCredentials): Promise<string> {

    const service = new services.etcdserverpb.Auth(address, credentials);
    return new Promise((resolve, reject) => {
      service.authenticate(
        { name: auth.username,  password: auth.password },
        (err: Error | null, res: IAuthenticateResponse) => {
          if (err) {
            return reject(err);
          }

          return resolve(res.token);
        }
      );
    });
  }

  /**
   * Creates a metadata generator that adds the auth token to grpc calls.
   */
  private createMetadataAugmenter(token: string): GRPCCredentials {
    return grpc.credentials.createFromMetadataGenerator(
      (_ctx: any, callback: (err: Error | null, result?: any) => void) => {
        const metadata = new grpc.Metadata();
        metadata.add('token', token);
        callback(null, metadata);
      }
    );
  }
}

class Host {

  private cachedServices: { [name in keyof typeof Services]?: Promise<IRawGRPC> } = Object.create(null);

  constructor(
    private host: string,
    private channelCredentials: Promise<GRPCCredentials>,
  ) {}

  /**
   * Returns the given GRPC service on the current host.
   */
  public getService(name: keyof typeof Services): Promise<IRawGRPC> {
    const service = this.cachedServices[name];
    if (service) {
      return Promise.resolve(service);
    }

    return this.channelCredentials.then(credentials => {
      const instance = new services.etcdserverpb[name](this.host, credentials);
      instance.etcdHost = this;
      return instance;
    });
  }

  /**
   * Close frees resources associated with the host, tearing down any
   * existing client
   */
  public close() {
    forOwn(this.cachedServices, (service: Promise<IRawGRPC>) => {
      service.then(c => grpc.closeClient(c));
    });

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
  private authenticator = new Authentictor(this.options);

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
  public exec(service: keyof typeof Services, method: string, payload: any): Promise<any> {
    if (this.mockImpl) {
      return this.mockImpl.exec(service, method, payload);
    }

    return this.getConnection(service).then(grpcService => {
      return new Promise((resolve, reject) => {
        grpcService[method](payload, (err: Error, res: any) => {
          if (!err) {
            this.pool.succeed(grpcService.etcdHost);
            return resolve(res);
          }
          err = castGrpcError(err);
          if (err instanceof GRPCGenericError) {
            this.pool.fail(grpcService.etcdHost);
            grpcService.etcdHost.close();

            if (this.pool.available().length && this.options.retry) {
              return resolve(this.exec(service, method, payload));
            }
          }

          reject(err);
        });
      });
    });
  }

  /**
   * @override
   */
  public getConnection(service: keyof typeof Services): Promise<any> {
    if (this.mockImpl) {
      return this.mockImpl.getConnection(service);
    }

    return this.pool.pull().then(client => client.getService(service));
  }

  /**
   * Adds configured etcd hosts to the connection pool.
   */
  private seedHosts() {
    const credentials = this.buildAuthentication();
    const { hosts } = this.options;

    if (typeof hosts === 'string') {
      this.pool.add(new Host(hosts, credentials));
      return;
    }

    if (hosts.length === 0) {
      throw new Error('Cannot construct an etcd client with no hosts specified');
    }

    hosts.forEach(host => this.pool.add(new Host(host, credentials)));
  }

  /**
   * Creates authentication credentials to use for etcd clients.
   */
  private buildAuthentication(): Promise<GRPCCredentials> {
    const { credentials } = this.options;

    let protocolCredentials = grpc.credentials.createInsecure();
    if (credentials) {
      protocolCredentials = grpc.credentials.createSsl(
        credentials.rootCertificate,
        credentials.privateKey,
        credentials.certChain,
      );
    }

    return this.authenticator.augmentCredentials(protocolCredentials);
  }
}
