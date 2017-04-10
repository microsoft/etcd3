'use strict';

/**
 * This script downloads the latest protobuf files from the etcd repo.
 *
 * Usage:
 *
 *  > node bin/update-proto ./proto
 *
 */

const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');

/**
 * Matches lines that should be stripped out from the combined proto file.
 * @type {RegExp[]}
 */
const ignores = [
  /^import .+/,
  /^option .+/,
  /^package .+/,
  /^syntax .+/,
];

/**
 * Files to fetch and concatenate.
 * @type {String[]}
 */
const files = [
  {
    path: 'auth/authpb/auth.proto',
    prefix: 'package authpb;\n',
  },
  {
    path: 'mvcc/mvccpb/kv.proto',
    prefix: 'package mvccpb;\n',
  },
  {
    path: 'etcdserver/etcdserverpb/rpc.proto',
    prefix: 'package etcdserverpb;\nimport "./kv.proto";\nimport "./auth.proto";\n',
  },
];

const baseUrl = 'https://raw.githubusercontent.com/coreos/etcd/master';

Promise.all(files.map(f => {
  return fetch(`${baseUrl}/${f.path}`)
    .then(res => res.text())
    .then(contents => {
      return 'syntax = "proto3";\n' + f.prefix + contents
        .split(/\r?\n/g)
        .filter(line => !ignores.some(re => re.test(line)))
        .join('\n')
        .replace(/\n\n+/g, '\n');
    })
    .then(contents => {
      fs.writeFileSync(
        path.join(process.argv[2], path.basename(f.path)),
        contents
      );
    });
})).then(() => process.exit(0));
