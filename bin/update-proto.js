/**
 * This script downloads the latest protobuf files from the etcd repo.
 *
 * Usage:
 *
 *  > node bin/update-proto ./proto
 *
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import _ from 'lodash';

/**
 * Files to fetch and concatenate.
 * @type {String[]}
 */
const files = [
  {
    path: 'api/authpb/auth.proto',
    prefix: 'package authpb;\n',
  },
  {
    path: 'api/mvccpb/kv.proto',
    prefix: 'package mvccpb;\n',
  },
  {
    path: 'api/etcdserverpb/rpc.proto',
    prefix: 'package etcdserverpb;\nimport "./kv.proto";\nimport "./auth.proto";\n',
  },
];

/**
 * Matches lines that should be stripped out from the combined proto file.
 * @type {RegExp[]}
 */
const ignores = [/^import .+/, /^option .+/, /^package .+/, /^syntax .+/];

/**
 * Filters out lines that should be ignored when transforming the proto files.
 */
const filterRemovedLines = line => !ignores.some(re => re.test(line));

const uppercaseEnumFieldRe = /^(\s*)([A-Z_]+)(\s*=\s*[0-9]+;.*)$/;

/**
 * Etcd provides all enums as UPPER_CASE. We change them to UpperCamelCase here
 * to match TypeScript conventions better.
 */
function lowerCaseEnumFields(line) {
  return line.replace(uppercaseEnumFieldRe, (_match, indentation, name, value) => {
    return `${indentation}${_.upperFirst(_.camelCase(name))}${value}`;
  });
}

const baseUrl = 'https://raw.githubusercontent.com/etcd-io/etcd/main';

Promise.all(
  files.map(f => {
    return fetch(`${baseUrl}/${f.path}`)
      .then(async res => {
        if (!res.ok) {
          throw new Error(`Failed to download ${f.path}: ${res.status} ${res.statusText}`);
        }
        return res.text();
      })
      .then(contents => {
        return (
          'syntax = "proto3";\n' +
          f.prefix +
          contents
            .split(/\r?\n/g)
            .filter(filterRemovedLines)
            .map(lowerCaseEnumFields)
            .join('\n')
            .replace(/\n\n+/g, '\n')
        );
      })
      .then(contents => {
        return fs.writeFile(path.join(process.argv[2], path.basename(f.path)), contents);
      });
  }),
).catch(err => {
  console.error(err.stack);
  process.exitCode = 1;
});
