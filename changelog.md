## 0.2.2 2017-07-10

 - **bug**: fix critical installation issue from 0.2.1
 - **chore**: update grpc to 1.4.x

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
