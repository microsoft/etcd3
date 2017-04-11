import { ExponentialBackoff } from './backoff/exponential';
import { IOptions } from './options';
import { ICallable, Services } from './rpc';
import { SharedPool } from './shared-pool';

const grpc = require('grpc');
const services = grpc.load(`${__dirname}/../protos/rpc.proto`);

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

  private cachedClient: Promise<IRawGRPC> | null = null;

  constructor(private host: string, private options: IOptions) {}

  /**
   * Close frees resources associated with the host, tearing down any
   * existing client
   */
  public close() {
    if (this.cachedClient) {
      grpc.closeClient(this.cachedClient);
      this.cachedClient = null;
    }
  }

  /**
   * Returns the given GRPC service
   */
  public getService(name: keyof typeof Services): Promise<IRawGRPC> {
    if (this.cachedClient !== null) {
      return this.cachedClient;
    }

    return this.cachedClient = this.buildAuthentication()
      .then(creds => services.etcdserverpb[name](this.host, creds));
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

    return Promise.resolve(credentials);
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
   * @override
   */
  public async exec(service: keyof typeof Services, method: string, payload: any): Promise<any> {
    return this.pool.pull().then(client => {
      return client.getService(service).then(grpcService => {
        return new Promise((resolve, reject) => {
          grpcService[method](payload, (err, res) => {
            if (err) {
              this.pool.fail(client);
              client.close();
              reject(err);
            } else {
              this.pool.succeed(client);
              resolve(res);
            }
          });
        });
      });
    });
  }
}
