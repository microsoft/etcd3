import { ExponentialBackoff } from './backoff/exponential';
import { castGrpcError, GRPCGenericError } from './errors';
import { IOptions } from './options';
import { ICallable, Services } from './rpc';
import { SharedPool } from './shared-pool';
import { forOwn } from './util';

const grpc = require('grpc');
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

class Host {

  private cachedCredentials: Promise<any> | null = null;
  private cachedServices: { [name in keyof typeof Services]?: Promise<IRawGRPC> } = Object.create(null);

  constructor(private host: string, private options: IOptions) {}

  /**
   * Returns the given GRPC service on the current host.
   */
  public getService(name: keyof typeof Services): Promise<IRawGRPC> {
    const service = this.cachedServices[name];
    if (service) {
      return Promise.resolve(service);
    }

    if (this.cachedCredentials === null) {
      this.cachedCredentials = this.buildAuthentication();
    }

    return this.cachedServices[name] = this.cachedCredentials.then(credentials => {
      return new services.etcdserverpb[name](this.host, credentials);
    });
  }

  /**
   * Close frees resources associated with the host, tearing down any
   * existing client
   */
  public close() {
    if (!this.cachedCredentials) {
      return;
    }

    forOwn(this.cachedServices, (service: Promise<IRawGRPC>) => {
      service.then(c => grpc.closeClient(c));
    });

    this.cachedCredentials = null;
    this.cachedServices = Object.create(null);
  }

  private buildAuthentication(): Promise<any> {
    const { credentials, auth } = this.options;

    let protocolCredentials = grpc.credentials.createInsecure();
    if (credentials) {
      protocolCredentials = grpc.credentials.createSsl(
        credentials.rootCertificate,
        credentials.privateKey,
        credentials.certChain,
      );
    }

    if (auth) {
      throw new Error('password auth not supported yet'); // todo(connor4312)
    }

    return Promise.resolve(grpc.credentials.combineCallCredentials(protocolCredentials));
  }
}

/**
 * Connection wraps GRPC hosts. Note that this wraps the hosts themselves; each
 * host can contain multiple discreet services.
 */
export class ConnectionPool implements ICallable {

  private pool = new SharedPool<Host>(this.options.backoffStrategy || defaultBackoffStrategy);

  constructor(private options: IOptions) {
    if (typeof options.hosts === 'string') {
      options.hosts = [options.hosts];
    }
    if (options.hosts.length === 0) {
      throw new Error('Cannot construct an etcd client with no hosts specified');
    }

    options.hosts.forEach(host => this.pool.add(new Host(host, options)));
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
    return this.pool.pull().then(client => {
      return client.getService(service).then(grpcService => {
        return new Promise((resolve, reject) => {
          grpcService[method](payload, (err, res) => {
            if (!err) {
              this.pool.succeed(client);
              return resolve(res);
            }
            err = castGrpcError(err);
            if (err instanceof GRPCGenericError) {
              this.pool.fail(client);
              client.close();

              if (this.pool.available().length && this.options.retry) {
                return resolve(this.exec(service, method, payload));
              }
            }

            reject(err);
          });
        });
      });
    });
  }
}
