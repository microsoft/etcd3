/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { ChannelOptions } from '@grpc/grpc-js/build/src/channel-options';
import { CallOptions } from '@grpc/grpc-js';
import { IPolicy, IBackoff, IDefaultPolicyContext } from 'cockatiel';
import { CallContext } from './rpc';

export type CallOptionsFactory = CallOptions | ((context: CallContext) => CallOptions);

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
   * {@link https://grpc.io/grpc/node/grpc.credentials.html#.createSsl__anchor here}.
   *
   * For example:
   *
   * ```ts
   * const etcd = new Etcd3({
   *   credentials: {
   *     rootCertificate: fs.readFileSync('ca.crt'),
   *   },
   * });
   * ```
   */
  credentials?: {
    rootCertificate: Buffer;
    privateKey?: Buffer;
    certChain?: Buffer;
  };

  /**
   * Internal options to configure the GRPC client. These are channel options
   * as enumerated in their [C++ documentation](https://grpc.io/grpc/cpp/group__grpc__arg__keys.html).
   * For example:
   *
   * ```js
   * const etcd = new Etcd3({
   *   // ...
   *   grpcOptions: {
   *     'grpc.http2.max_ping_strikes': 3,
   *   },
   * })
   * ```
   */
  grpcOptions?: ChannelOptions;

  /**
   * Etcd password auth, if using. You can also specify call options for the
   * authentication token exchange call.
   */
  auth?: {
    username: string;
    password: string;

    /**
     * Call options to use for the password-to-token exchange.
     */
    callOptions?: CallOptionsFactory;
  };

  /**
   * Default call options used for all requests. This can be an object, or a
   * function which will be called for each etcd method call.  As a function,
   * it will be called with a context object, which looks like:
   * ```js
   * {
   *   service: 'KV',   // etcd service name
   *   method: 'range', // etcd method name
   *   isStream: false, // whether the call create a stream
   *   params: { ... }, // arguments given to the call
   * }
   * ```
   *
   * For example, this will set a 10 second timeout on all calls which are not streams:
   *
   * ```js
   * const etcd3 = new Etcd3({
   *   defaultCallOptions: context => context.isStream ? {} : { deadline: Date.now() + 10000 },
   * });
   * ```
   *
   * The default options are shallow merged with any call-specific options.
   * For example this will always result in a 5 second timeout, regardless of
   * what the `defaultCallOptions` contains:
   *
   * ```js
   * etcd3.get('foo').options({ deadline: Date.now() + 5000 })
   * ```
   */
  defaultCallOptions?: CallOptionsFactory;

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
   * Defines the fault-handling policies for the client via
   * [Cockatiel](https://github.com/connor4312/cockatiel/blob/master/readme.md).
   * There are two policies: per-host, and global. Calls will call through the
   * global policy, and then to a host policy. Each time the global policy
   * retries, it will pick a new host to run the call on.
   *
   * The recommended setup for this is to put a retry policy on the `global`
   * slot, and a circuit-breaker policy guarding each `host`. Additionally,
   * you can configure a backoff that the watch manager will use for
   * reconnecting watch streams.
   *
   * By default, `global` is set to a three-retry policy and `host` is a
   * circuit breaker that will open (stop sending requests) for five seconds
   * after three consecutive failures. The watch backoff defaults to
   * Cockatiel's default exponential options (a max 30 second delay on
   * a decorrelated jitter).
   *
   * For example, this is how you would manually specify the default options:
   *
   * ```ts
   * import { Etcd3, isRecoverableError } from 'etcd3';
   * import { Policy, ConsecutiveBreaker, ExponentialBackoff } from 'cockatiel';
   *
   * const etcd = new Etcd3({
   *   faultHandling: {
   *     host: () =>
   *       Policy.handleWhen(isRecoverableError).circuitBreaker(5_000, new ConsecutiveBreaker(3)),
   *     global: Policy.handleWhen(isRecoverableError).retry(3),
   *     watchBackoff: new ExponentialBackoff(),
   *   },
   * });
   * ```
   *
   * Here's how you can disable all fault-handling logic:
   *
   * ```ts
   * import { Etcd3 } from 'etcd3';
   * import { Policy } from 'cockatiel';
   *
   * const etcd = new Etcd3({
   *   faultHandling: {
   *     host: () => Policy.noop,
   *     global: Policy.noop,
   *   },
   * });
   * ```
   */
  faultHandling?: Partial<{
    host: (hostname: string) => IPolicy<IDefaultPolicyContext>;
    global: IPolicy<IDefaultPolicyContext>;
    watchBackoff: IBackoff<unknown>;
  }>;
}
