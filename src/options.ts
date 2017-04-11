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
   */
  dialTimeout?: number;

  /**
   * Backoff strategy to use for connecting to hosts.
   */
  backoffStrategy?: IBackoffStrategy;
}
