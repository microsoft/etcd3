# etcd3 [![Build Status](https://travis-ci.org/mixer/etcd3.svg?branch=master)](https://travis-ci.org/mixer/etcd3)

etcd3 aims to be (with its first stable release) a high-quality, production-ready client for the Protocol Buffer-based etcdv3 API. It includes [load balancing](https://mixer.github.io/etcd3/interfaces/options_.ioptions.html), [reconnections](https://mixer.github.io/etcd3/interfaces/options_.ioptions.html#backoffstrategy), [transactions](https://mixer.github.io/etcd3/classes/builder_.comparatorbuilder.html), [software transactional memory](https://mixer.github.io/etcd3/classes/index_.etcd3.html#stm), [high-level query builders](https://mixer.github.io/etcd3/classes/index_.etcd3.html#delete) and [lease management](https://mixer.github.io/etcd3/classes/lease_.lease.html), [watchers](https://mixer.github.io/etcd3/classes/watch_.watchbuilder.html), [mocking](https://mixer.github.io/etcd3/classes/index_.etcd3.html#mock), and is type-safe for TypeScript consumers.

### Quickstart

Install via:

```
npm install --save etcd3
```

Start CRUD-ing!

```js
const { Etcd3 } = require('etcd3');
const client = new Etcd3();

client.put('foo').value('bar')
  .then(() => client.get('foo').string())
  .then(value => console.log('foo was:', value))
  .then(() => client.getAll().prefix('f').strings())
  .then(keys => console.log('all our keys starting with "f":', keys))
  .then(() => client.delete().all());
```

### API Documentation

Our [TypeDoc docs are available here](https://mixer.github.io/etcd3/classes/index_.etcd3.html).

Our [test cases](https://github.com/mixer/etcd3/blob/master/test/) are also quite readable.

### Contributing

Running tests for this module requires running an etcd3 server locally. The tests try to use the default port initially, and you can configure this by setting the `ETCD_ADDR` environment variable, like `export ETCD_ADDR=localhost:12345`.
