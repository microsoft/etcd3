import { IBackoffStrategy } from './backoff/backoff';

/**
 * IOptions are passed into the client constructor to configure how the client
 * connects to etcd. It supports defining multiple servers and configuring how
 * load is balanced between those servers.
 */
export interface IOptions {
  /**
   * Optional client cert credentials for talking to etcd. Describe more
   * {@link https://coreos.com/etcd/docs/latest/op-guide/security.html here},
   * passed into the createSsl function in GRPC
   * {@link http://www.grpc.io/grpc/node/module-src_credentials.html#.createSsl here}.
   */
  credentials?: {
    rootCertificate: Buffer;
    privateKey?: Buffer;
    certChain?: Buffer;
  };

  /**
   * Etcd password auth, if using.
   */
  auth?: {
    username: string;
    password: string;
  };

  /**
   * A list of hosts to connect to. Hosts should include the `https?://` prefix.
   */
  hosts: string[] | string;

  /**
   * Duration in milliseconds to wait while connecting before timing out.
   * Defaults to 30 seconds.
   */
  dialTimeout?: number;

  /**
   * Backoff strategy to use for connecting to hosts. Defaults to an
   * exponential strategy, starting at a 500 millisecond
   * retry with a 30 second max.
   */
  backoffStrategy?: IBackoffStrategy;

  /**
   * Whether, if a query fails as a result of a primitive GRPC error, to retry
   * it on a different server (provided one is available). This can make
   * service disruptions less-severe but can cause a domino effect if a
   * particular operation causes a failure that grpc reports as some sort of
   * internal or network error.
   *
   * Defaults to false.
   */
  retry?: boolean;
}
