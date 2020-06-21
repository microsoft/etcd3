# etcd3 [![Run Tests](https://github.com/microsoft/etcd3/workflows/Run%20Tests/badge.svg)](https://github.com/microsoft/etcd3/actions?query=workflow%3A%22Run+Tests%22)

etcd3 aims to be (with its first stable release) a high-quality, production-ready client for the Protocol Buffer-based etcdv3 API. It includes [load balancing](https://microsoft.github.io/etcd3/interfaces/options_.ioptions.html), [reconnections](https://microsoft.github.io/etcd3/interfaces/options_.ioptions.html#backoffstrategy), [transactions](https://microsoft.github.io/etcd3/classes/builder_.comparatorbuilder.html), [software transactional memory](https://microsoft.github.io/etcd3/classes/etcd3.html#stm), [high-level query builders](https://microsoft.github.io/etcd3/classes/etcd3.html#delete) and [lease management](https://microsoft.github.io/etcd3/classes/lease_.lease.html), [watchers](https://microsoft.github.io/etcd3/classes/watch_.watchbuilder.html), [mocking](https://microsoft.github.io/etcd3/classes/etcd3.html#mock), and is type-safe for TypeScript consumers.

### Quickstart

Install via:

```
npm install --save etcd3
```

Start CRUD-ing!

```js
const { Etcd3 } = require('etcd3');
const client = new Etcd3();

(() => {
  await client.put('foo').value('bar');

  const fooValue = await client.get('foo').string();
  console.log('foo was:', fooValue);

  const allFValues = client.getAll().prefix('f').keys()
  console.log('all our keys starting with "f":', allFValues);

  await client.delete().all();
})
```

### API Documentation

Our [TypeDoc docs are available here](https://microsoft.github.io/etcd3/classes/etcd3.html).

Our [test cases](https://github.com/microsoft/etcd3/blob/master/test/) are also readable.

### Running tests

```sh
$ npm install
$ docker-compose up
$ npm test
$ docker-compose down
```

### Contributing

Running tests for this module requires running an etcd3 server locally. The tests try to use the default port initially, and you can configure this by setting the `ETCD_ADDR` environment variable, like `export ETCD_ADDR=localhost:12345`.

This project has adopted the [Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/). For more information see the [Code of Conduct FAQ](https://opensource.microsoft.com/codeofconduct/faq/) or contact [opencode@microsoft.com](mailto:opencode@microsoft.com) with any additional questions or comments.
