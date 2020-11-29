# Changelog

## 1.1.0 2020-11-28

- **feat:** implement elections

  Implementation of elections, as seen in etcd's Go client. Elections are most commonly used if you need a single server in charge of a certain task; you run an election on every server where your program is running, and among them they will choose one "leader".

  There are two main entrypoints: campaigning via Election.campaign, and observing the leader via Election.observe.

  ```js
  const os = require('os');
  const client = new Etcd3();
  const election = client.election('singleton-job');

  function runCampaign() {
    const campaign = election.campaign(os.hostname());
    campaign.on('elected', () => {
      // This server is now the leader! Let's start doing work
      doSomeWork();
    });
    campaign.on('error', error => {
      // An error happened that caused our campaign to fail. If we were the
      // leader, make sure to stop doing work (another server is the leader
      // now) and create a new campaign.
      console.error(error);
      stopDoingWork();
      setTimeout(runCampaign, 5000);
    });
  }

  async function observeLeader() {
    const observer = await election.observe();
    console.log('The current leader is', observer.leader());
    observer.on('change', leader => console.log('The new leader is', leader));
    observer.on('error', () => {
      // Something happened that fatally interrupted observation.
      setTimeout(observeLeader, 5000);
    });
  }
  ```

  Thanks to [@yujuiting](https://github.com/yujuiting) for their help with the initial implementation. (see [#66](https://github.com/microsoft/etcd3/pull/66), [#85](https://github.com/microsoft/etcd3/issues/85)).

- **fix:** **deprecation:** `watcherBuilder.ignore()` was available for "ignoring" types of events, but it actually did the opposite: it was an include-list, rather than a deny-list. It's deprecated in favor of `watchBuilder.only()`
- **fix:** buffers not allowed in typings `Namespace.get(<key>)`
- **fix:** prevent user errors in watcher event listeners from causing backoffs in the underlying stream

## 1.0.2 2020-09-18

- **fix:** update version of cockatiel to fix incompatible TypeScript types (see [#128](https://github.com/microsoft/etcd3/issues/128))
- **fix:** don't include the deadline in inherited lease call options (see [#131](https://github.com/microsoft/etcd3/issues/131))
- **feat:** allow passing a set of default CallOptions in new Etcd3() (see [#133](https://github.com/microsoft/etcd3/issues/133))

  When constructing `Etcd3`, you can now pass `defaultCallOptions`. This can be an object, or a function which will be called for each etcd method call and should return an object. As a function, it will be called with a context object, which looks like:

  ```js
  {
    service: 'KV',   // etcd service name
    method: 'range', // etcd method name
    isStream: false, // whether the call create a stream
    params: { ... }, // arguments given to the call
  }
  ```

  For example, this will set a 10 second timeout on all calls which are not streams:

  ```js
  const etcd3 = new Etcd3({
    defaultCallOptions: context => (context.isStream ? {} : Date.now() + 10000),
  });
  ```

  The default options are shallow merged with any call-specific options. For example this will always result in a 5 second timeout, regardless of what the `defaultCallOptions` contains:

  ```js
  etcd3.get('foo').options({ deadline: Date.now() + 5000 });
  ```

## 1.0.1 2020-06-21

- **fix:** `proto` files not included in npm package

## 1.0.0 2020-06-21

- **breaking**: **chore:** Node < 10 is no longer supported
- **breaking**: **chore:** `bignumber.js`, used to handle 64-bit numbers returned from etcd, updated from 5.x to 9.0.0
- **breaking**: **chore:** TypeScript is updated to 3.9, and the types of some function signatures have been narrowed
- **breaking**: **chore:** grpc has been updated from `grpc@1.24` to `@grpc/grpc-js@1.0.05`. This affects the optional `grpcOptions` that the client can be configured with. The previous package was a couple years old, so you may additionally see different behavior of grpc on your network.

  Thank you to [@pauliusuza](https://github.com/pauliusuza) for his help updating everything

- **breaking**: `retry` and `backoffStrategy` options have been deprecated in favor of a new `faultHandling` option.
- **breaking**: `GRPCConnectFailedError` has been removed in favor of more accurate, specific GRPC error types.
- **feat**: add `faultHandling` option that allows configuring error handling through [Cockatiel](https://github.com/connor4312/cockatiel) policies. (see [#121](https://github.com/microsoft/etcd3/issues/121))

  There are two policies: per-host, and global. Calls will call through the global policy, and then to a host policy. Each time the global policy retries, it will pick a new host to run the call on.

  The recommended setup for this is to put a retry policy on the `global` slot, and a circuit-breaker policy guarding each `host`. Additionally, you can configure a backoff that the watch manager will use for reconnecting watch streams.

  By default, `global` is set to a three-retry policy and `host` is a circuit breaker that will open (stop sending requests) for five seconds after three consecutive failures. The watch backoff defaults to Cockatiel's default exponential options (a max 30 second delay on a decorrelated jitter). If you would like to disable these policies, you can pass `Policy.noop` from Cockatiel to the `global` and `host` options.

  **Notably**, with the default options, you may now receive `BrokenCircuitError`s from Cockatiel if calls to a host repeatedly fail.

  For example, this is how you would manually specify the default options:

  ```ts
  import { Etcd3, isRecoverableError } from 'etcd3';
  import { Policy, ConsecutiveBreaker, ExponentialBackoff } from 'cockatiel';

  new Etcd3({
    faultHandling: {
      host: () =>
        Policy.handleWhen(isRecoverableError).circuitBreaker(5_000, new ConsecutiveBreaker(3)),
      global: Policy.handleWhen(isRecoverableError).retry(3),
      watchBackoff: new ExponentialBackoff(),
    },
  });
  ```

  Here's how you can disable all fault-handling logic:

  ```ts
  import { Etcd3 } from 'etcd3';
  import { Policy } from 'cockatiel';

  new Etcd3({
    faultHandling: {
      host: () => Policy.noop,
      global: Policy.noop,
    },
  });
  ```

- **feat**: export an `isRecoverableError` function that can be used to detect whether the given error is transient, as defined by grpc. Useful when creating retry policies. Recoverable errors will have the exported symbol `RecoverableError` as one of their properties.
- **feat**: add `SingleRangeBuilder.exists()` that returns if the given key exists
- **feat**: allow apply call options to authentication token exchange (see [#111](https://github.com/microsoft/etcd3/issues/111))
- **feat**: allow disabling automatic lease keep-alives (see [#110](https://github.com/microsoft/etcd3/issues/110))
- **fix**: errors when creating watchers not being handled correctly (see [#114](https://github.com/microsoft/etcd3/issues/114))
- **fix**: mark leases as lost if the watch connection is alive but etcd is unresponsive (see [#110](https://github.com/microsoft/etcd3/issues/110))

## 0.2.13 2019-07-03

- **bug**: fixed comparisons breaking in STM when using namespaces (see [#90](https://github.com/microsoft/etcd3/issues/90))
- **feat**: allow retrieving lock lease IDs (see [#75](https://github.com/microsoft/etcd3/issues/75))
- **bug**: fixed using `lease.put` in transactions not applying the lease to the target key (see [#92](https://github.com/microsoft/etcd3/issues/92))
- **bug**: call `markFailed` on the mock instance, rather than the real connection pool, whilst mocking (see [#94](https://github.com/microsoft/etcd3/issues/94))
- **chore**: update dependencies, including grpc and Typescript versions

## 0.2.12 2019-07-03

- **bug**: fix `grpc.load` deprecation error (see [#81](https://github.com/microsoft/etcd3/issues/81), [#91](https://github.com/microsoft/etcd3/issues/91)) thanks to [@RezoChiang](https://github.com/RezoChiang)
- **feat**: allow setting the starting revision when watching (see [#88](https://github.com/microsoft/etcd3/issues/88)) thanks to [@nlsun](https://github.com/nlsun)
- **fix**: refresh the lastKeepAlive counter when calling keepAliveOnce() on leases (see [#80](https://github.com/microsoft/etcd3/issues/80)) thanks to [@tannineo](https://github.com/tannineo)

## 0.2.11 2018-05-21

- **bug**: fix backoffs not triggering on stream failures ([#76](https://github.com/microsoft/etcd3/pull/76))

## 0.2.10 2018-05-05

- **feat**: update grpc with Node 10 support (see [#73](https://github.com/microsoft/etcd3/pulls/73)) thanks to [@XadillaX](https://github.com/XadillaX)
- **feat**: add `lease.release()` to let leases expire automatically (see [#69](https://github.com/microsoft/etcd3/issues/69))
- **bug**: update docs and throw if a lease TTL is not provided (see [#68](https://github.com/microsoft/etcd3/issues/68))
- **bug**: forcefully terminate watch streams on close (see [#62](https://github.com/microsoft/etcd3/issues/62))
- **bug**: reestablish watch streams if they're closed gracefully (see [#79](https://github.com/microsoft/etcd3/issues/79))
- **bug**: fix synax error in watcher docs(see [#71](https://github.com/microsoft/etcd3/pulls/71)) thanks to [@monkbroc](https://github.com/monkbroc)

## 0.2.9 2018-02-09

- **bug**: lock to grpc@1.9.0 due to upstream regression (see [#59](https://github.com/microsoft/etcd3/issues/59))

## 0.2.7 2017-12-30

- **bug**: when we detect a lease is lost by touching a key, mark the lease as revoked ([#50](https://github.com/microsoft/etcd3/pull/50))
- **bug**: when a lease is lost, make sure the lease state is revoked ([#52](https://github.com/microsoft/etcd3/pull/52))
- **bug**: fixed successive watches not attaching ([#51](https://github.com/microsoft/etcd3/pull/51))

## 0.2.6 2017-11-11

- **feature**: add software transactional memory ([#39](https://github.com/microsoft/etcd3/pull/39))
- **feature**: allow password auth over insecure channels ([#41](https://github.com/microsoft/etcd3/pull/41)) thanks to [@reptilbud](https://github.com/reptilbud)
- **feature**: allow GRPC call options to be passed into operations ([#43](https://github.com/microsoft/etcd3/issues/43), [`cc456cc`](https://github.com/microsoft/etcd3/commit/cc456cc))
- **bug**: fix incorrect watcher catchup logic in very large etcd revisions ([`66b1e90`](https://github.com/microsoft/etcd3/commit/66b1e9050bb03f8d8760b07d7764529a262ccb0b))
- **bug**: automatically refresh access tokens if they are expired or invalidated ([`9127329`](https://github.com/microsoft/etcd3/commit/9127329963042693a60a8e3568c0230937ccc952))
- **bug**: call stack error in etcd3's codegen ([#44](https://github.com/microsoft/etcd3/issues/44), [`8856981`](https://github.com/microsoft/etcd3/commit/8856981))
- **bug**: lock and STM typings not being exported ([#45](https://github.com/microsoft/etcd3/issues/45), [`4578138`](https://github.com/microsoft/etcd3/commit/4578138))
- **bug**: old data sometimes being replayed incorrectly when watchers reconnect ([#42](https://github.com/microsoft/etcd3/issues/42), [`7474f96`](https://github.com/microsoft/etcd3/commit/7474f96))

## 0.2.5 2017-09-30

- **feature**: allow passing GRPC options to the client constructor ([#36](https://github.com/microsoft/etcd3/issues/36))
- **bug**: watchers response ack's could be delivered incorrectly when watching keys concurrently ([#33](https://github.com/microsoft/etcd3/pull/33), [#30](https://github.com/microsoft/etcd3/issues/30)) thanks to [@styleex](https://github.com/styleex)
- **bug**: watchers not receiving events after reconnection in rare cases ([#33](https://github.com/microsoft/etcd3/pull/33), [#31](https://github.com/microsoft/etcd3/issues/31)) thanks to [@styleex](https://github.com/styleex)
- **bug**: error thrown when the connection pool is drain / no servers are available ([#33](https://github.com/microsoft/etcd3/pull/33), [#7](https://github.com/microsoft/etcd3/issues/7)) thanks to [@SimonSchick](https://github.com/SimonSchick)
- **bug**: fix possibly unhandled rejection in the connection pool ([#35](https://github.com/microsoft/etcd3/issues/35))
- **chore**: update grpc to 1.6, and update development dependencies

## 0.2.4 2017-08-02

- **bug**: connections failing when an `https` prefix is provided ([#29](https://github.com/microsoft/etcd3/pull/29)) thanks to [@jmreicha](https://github.com/jmreicha)
- **bug**: connections failing when using SSL without a custom root cert ([#29](https://github.com/microsoft/etcd3/pull/29)) thanks to [@jmreicha](https://github.com/jmreicha)
- **feature**: throw a more meaningful error when using credentials without SSL ([#29](https://github.com/microsoft/etcd3/pull/29))
- **test**: run tests with Node 8 and etcd3.2 ([#27](https://github.com/microsoft/etcd3/pull/27)) thanks to [@shakefu](https://github.com/shakefu)

## 0.2.3 2017-07-19

- **bug**: fix being unable to set lock TTLs ([#26](https://github.com/microsoft/etcd3/pull/26))

## 0.2.2 2017-07-10

- **bug**: fix critical installation issue from 0.2.1 ([#23](https://github.com/microsoft/etcd3/issues/23), [#24](https://github.com/microsoft/etcd3/pull/24))
- **chore**: update grpc to 1.4.x ([#24](https://github.com/microsoft/etcd3/pull/24))

## ~~0.2.1 2017-07-10~~

- **breaking**: `client.watch()` is now a function to construct high-level watchers ([#12](https://github.com/microsoft/etcd3/pull/12))
- **feature**: add namespacing capability ([#12](https://github.com/microsoft/etcd3/pull/12))
- **feature**: add high-level watchers ([#16](https://github.com/microsoft/etcd3/pull/16))
- **chore**: use [prettier](https://github.com/prettier/prettier) formatting for all code ([#16](https://github.com/microsoft/etcd3/pull/18))

## 0.2.0 2017-06-03

- **breaking**: return strings from `client.get()` and maps of strings from `client.getAll()` by default ([#6](https://github.com/microsoft/etcd3/pull/6))
- **breaking**: enums (which were not correctly typed in 0.1.x) have had their typings corrected and their capitalization has changed to UpperCameCase to align with TypeScript/JavaScript conventions ([#6](https://github.com/microsoft/etcd3/pull/6))
- **feature**: add transaction builder ([#4](https://github.com/microsoft/etcd3/pull/4))
- **feature**: add distributed locking ([#5](https://github.com/microsoft/etcd3/pull/5))
- **feature**: add support for password auth, TLS, client credentials ([#11](https://github.com/microsoft/etcd3/pull/11))
- **feature**: add high-level role management structures ([#11](https://github.com/microsoft/etcd3/pull/11))
- **bug**: fix enum typings being incorrect ([#11](https://github.com/microsoft/etcd3/pull/11))
- **doc**: update URLs in the readme and package.json

## 0.1.2 2017-04-13

- **bug**: fix files being incorrectly ignored in the npm package

## 0.1.1

- Initial release
