## 0.2.11 2018-05-21

 - **bug**: fix backoffs not triggering on stream failures ([#76](https://github.com/mixer/etcd3/pull/76))

## 0.2.10 2018-05-05

 - **feat**: update grpc with Node 10 support (see [#73](https://github.com/mixer/etcd3/pulls/73)) thanks to [@XadillaX](https://github.com/XadillaX)
 - **feat**: add `lease.release()` to let leases expire automatically (see [#69](https://github.com/mixer/etcd3/issues/69))
 - **bug**: update docs and throw if a lease TTL is not provided (see [#68](https://github.com/mixer/etcd3/issues/68))
 - **bug**: forcefully terminate watch streams on close (see [#62](https://github.com/mixer/etcd3/issues/62))
 - **bug**: reestablish watch streams if they're closed gracefully (see [#79](https://github.com/mixer/etcd3/issues/79))
 - **bug**: fix synax error in watcher docs(see [#71](https://github.com/mixer/etcd3/pulls/71)) thanks to [@monkbroc](https://github.com/monkbroc)

## 0.2.9 2018-02-09

 - **bug**: lock to grpc@1.9.0 due to upstream regression (see [#59](https://github.com/mixer/etcd3/issues/59))

## 0.2.7 2017-12-30

 - **bug**: when we detect a lease is lost by touching a key, mark the lease as revoked ([#50](https://github.com/mixer/etcd3/pull/50))
 - **bug**: when a lease is lost, make sure the lease state is revoked ([#52](https://github.com/mixer/etcd3/pull/52))
 - **bug**: fixed successive watches not attaching ([#51](https://github.com/mixer/etcd3/pull/51))

## 0.2.6 2017-11-11

 - **feature**: add software transactional memory ([#39](https://github.com/mixer/etcd3/pull/39))
 - **feature**: allow password auth over insecure channels ([#41](https://github.com/mixer/etcd3/pull/41)) thanks to [@reptilbud](https://github.com/reptilbud)
 - **feature**: allow GRPC call options to be passed into operations ([#43](https://github.com/mixer/etcd3/issues/43), [`cc456cc`](https://github.com/mixer/etcd3/commit/cc456cc))
  - **bug**: fix incorrect watcher catchup logic in very large etcd revisions ([`66b1e90`](https://github.com/mixer/etcd3/commit/66b1e9050bb03f8d8760b07d7764529a262ccb0b))
  - **bug**: automatically refresh access tokens if they are expired or invalidated ([`9127329`](https://github.com/mixer/etcd3/commit/9127329963042693a60a8e3568c0230937ccc952))
  - **bug**: call stack error in etcd3's codegen ([#44](https://github.com/mixer/etcd3/issues/44), [`8856981`](https://github.com/mixer/etcd3/commit/8856981))
  - **bug**: lock and STM typings not being exported ([#45](https://github.com/mixer/etcd3/issues/45), [`4578138`](https://github.com/mixer/etcd3/commit/4578138))
  - **bug**: old data sometimes being replayed incorrectly when watchers reconnect ([#42](https://github.com/mixer/etcd3/issues/42), [`7474f96`](https://github.com/mixer/etcd3/commit/7474f96))

## 0.2.5 2017-09-30

 - **feature**: allow passing GRPC options to the client constructor ([#36](https://github.com/mixer/etcd3/issues/36))
 - **bug**: watchers response ack's could be delivered incorrectly when watching keys concurrently ([#33](https://github.com/mixer/etcd3/pull/33), [#30](https://github.com/mixer/etcd3/issues/30)) thanks to [@styleex](https://github.com/styleex)
 - **bug**: watchers not receiving events after reconnection in rare cases ([#33](https://github.com/mixer/etcd3/pull/33), [#31](https://github.com/mixer/etcd3/issues/31)) thanks to [@styleex](https://github.com/styleex)
 - **bug**: error thrown when the connection pool is drain / no servers are available ([#33](https://github.com/mixer/etcd3/pull/33), [#7](https://github.com/mixer/etcd3/issues/7)) thanks to [@SimonSchick](https://github.com/SimonSchick)
 - **bug**: fix possibly unhandled rejection in the connection pool ([#35](https://github.com/mixer/etcd3/issues/35))
 - **chore**: update grpc to 1.6, and update development dependencies

## 0.2.4 2017-08-02

 - **bug**: connections failing when an `https` prefix is provided ([#29](https://github.com/mixer/etcd3/pull/29)) thanks to [@jmreicha](https://github.com/jmreicha)
 - **bug**: connections failing when using SSL without a custom root cert ([#29](https://github.com/mixer/etcd3/pull/29)) thanks to [@jmreicha](https://github.com/jmreicha)
 - **feature**: throw a more meaningful error when using credentials without SSL ([#29](https://github.com/mixer/etcd3/pull/29))
 - **test**: run tests with Node 8 and etcd3.2 ([#27](https://github.com/mixer/etcd3/pull/27)) thanks to [@shakefu](https://github.com/shakefu)

## 0.2.3 2017-07-19

 - **bug**: fix being unable to set lock TTLs ([#26](https://github.com/mixer/etcd3/pull/26))

## 0.2.2 2017-07-10

 - **bug**: fix critical installation issue from 0.2.1 ([#23](https://github.com/mixer/etcd3/issues/23), [#24](https://github.com/mixer/etcd3/pull/24))
 - **chore**: update grpc to 1.4.x ([#24](https://github.com/mixer/etcd3/pull/24))

## ~~0.2.1 2017-07-10~~

 - **breaking**: `client.watch()` is now a function to construct high-level watchers ([#12](https://github.com/mixer/etcd3/pull/12))
 - **feature**: add namespacing capability ([#12](https://github.com/mixer/etcd3/pull/12))
 - **feature**: add high-level watchers ([#16](https://github.com/mixer/etcd3/pull/16))
 - **chore**: use [prettier](https://github.com/prettier/prettier) formatting for all code ([#16](https://github.com/mixer/etcd3/pull/18))

## 0.2.0 2017-06-03

 - **breaking**: return strings from `client.get()` and maps of strings from `client.getAll()` by default ([#6](https://github.com/mixer/etcd3/pull/6))
 - **breaking**: enums (which were not correctly typed in 0.1.x) have had their typings corrected and their capitalization has changed to UpperCameCase to align with TypeScript/JavaScript conventions ([#6](https://github.com/mixer/etcd3/pull/6))
 - **feature**: add transaction builder ([#4](https://github.com/mixer/etcd3/pull/4))
 - **feature**: add distributed locking ([#5](https://github.com/mixer/etcd3/pull/5))
 - **feature**: add support for password auth, TLS, client credentials ([#11](https://github.com/mixer/etcd3/pull/11))
 - **feature**: add high-level role management structures ([#11](https://github.com/mixer/etcd3/pull/11))
 - **bug**: fix enum typings being incorrect ([#11](https://github.com/mixer/etcd3/pull/11))
 - **doc**: update URLs in the readme and package.json

## 0.1.2 2017-04-13

 - **bug**: fix files being incorrectly ignored in the npm package

## 0.1.1

 - Initial release
