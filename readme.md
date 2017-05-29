# etcd3 [![Build Status](https://travis-ci.org/WatchBeam/etcd3.svg?branch=master)](https://travis-ci.org/WatchBeam/etcd3)

etcd3 aims to be (with its first stable release) a high-quality, production-ready client for the Protocol Buffer-based etcdv3 API. It includes load balancing, reconnections, high-level query builders and lease management, mocking, and is type-safe for TypeScript consumers.

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

Our [test cases](https://github.com/WatchBeam/etcd3/blob/master/test/kv.test.ts) are also quite readable.

### Contributing

Running tests for this module requires running an etcd3 server locally. The tests try to use the default port initially, and you can configure this by setting the `ETCD_ADDR` environment variable, like `export ETCD_ADDR=localhost:12345`.
