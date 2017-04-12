'use strict';

/**
 * This script parses downloaded protobuf files to output TypeScript typings
 * and methods to call declared the declared types.
 *
 * Usage:
 *
 *  > node bin/generate-methods proto/rpc.proto > src/methods.ts
 *
 * protobufjs does have a TypeScript generator but its output isn't very useful
 * for grpc, much less this client. Rather than reprocessing it, let's just
 * create the output ourselves since it's pretty simple (~100 lines of code).
 */

const changeCase = require('change-case');
const pbjs = require('protobufjs');
const fs = require('fs');
const _ = require('lodash');

const contents = fs.readFileSync(process.argv[2]).toString();
const lines = contents.split('\n');

const singleLineCommentRe = /\/\/\s*(.+)$/;
const singleLineCommentStandaloneRe = /^\s*\/\/\s*/;
const indentation = '  ';

const enums = [];
const services = {};

const pbTypeAliases = {
  bool: 'boolean',
  string: 'string',
  bytes: 'Buffer',
  Type: 'PermissionType',
};

const numericTypes = [
  'double',
  'float',
  'int32',
  'int64',
  'uint32',
  'uint64',
  'sint32',
  'sint64',
  'fixed32',
  'fixed64',
  'sfixed32',
  'sfixed64',
];

class MessageCollection {
  constructor() {
    this._messages = {};
  }

  add(name, node) {
    this._messages[stripPackageNameFrom(name)] = node;
  }

  find(name) {
    return this._messages[stripPackageNameFrom(name)];
  }
}

const messages = new MessageCollection();

function emit(string) {
  if (string) {
    process.stdout.write(string);
  }

  return emit;
}

function firstToLower(str) {
  return str.charAt(0).toLowerCase() + str.slice(1);
}

function stripPackageNameFrom(name) {
  if (name.includes('.')) {
    name = name.replace(/^.+\./, '');
  }

  return name;
}

function formatType(type, isInResponse = false) {
  if (type in pbTypeAliases) {
    return pbTypeAliases[type];
  }

  // grpc unmarshals number as strings, but we want to let people provide them as Numbers.
  if (numericTypes.includes(type)) {
    return isInResponse ? 'string' : 'string | number';
  }

  type = stripPackageNameFrom(type);
  if (enums.includes(type)) {
    return type;
  }

  return `I${type}`;
}

function getLineContaining(substring, from = 0) {
  return lines.findIndex((l, i) => i >= from && l.includes(substring));
}

function indent(level) {
  let out = '';
  for (let i = 0; i < level; i++) {
    out += indentation;
  }
  return out;
}

function getCommentPrefixing(substring, from = 0, indentation = 1) {
  // This is a hack! Protobufjs doesn't parse comments into its AST, and it
  // looks like when it does it won't parse the format of
  // comments that etcd uses: https://git.io/vSKU0

  const comments = [];
  const end = getLineContaining(substring, from);
  if (singleLineCommentRe.test(lines[end])) {
    const [, contents] = singleLineCommentRe.exec(lines[end]);
    comments.push(` * ${contents}`);
  } else {
    for (let i = end - 1; singleLineCommentStandaloneRe.test(lines[i]); i--) {
      comments.unshift(lines[i].replace(singleLineCommentStandaloneRe, ' * '));
    }
  }

  if (comments.length === 0) {
    return '';
  }

  return ['/**', ...comments, ' */']
    .map(line => `${indent(indentation)}${line}`)
    .join('\n') + '\n';
}

function generateMethodCalls(node, name) {
  services[name] = `${name}Client`;
  emit(`export class ${services[name]} {\n`)
    (`${indent(1)}constructor(private client: ICallable) {}\n`)

  _.forOwn(node.methods, (method, mname) => {
    const req = messages.find(method.requestType);
    const res = messages.find(method.responseType);
    const loweredName = firstToLower(mname);

    const requestTsType = req.empty ? 'void' : formatType(method.requestType);
    const responseTsType = res.empty ? 'void' : formatType(method.responseType);
    const streaming = method.responseStream || method.requestStream;

    emit(getCommentPrefixing(`rpc ${mname}(`));
    emit(`${indent(1)}public ${loweredName}(`);
    if (!method.requestStream && !req.empty) {
      emit(`req: ${requestTsType}`);
    }
    emit('): ');

    if (method.responseStream && !method.requestStream) {
      emit(`Promise<IResponseStream<${responseTsType}>> {\n`)
        (`${indent(2)}return this.client.getConnection('${name}').then(cnx => {\n`)
        (`${indent(3)}return cnx.${loweredName}(${req.empty ? '{}' : 'req'});\n`)
        (`${indent(2)}});\n`)
    } else if (method.responseStream && method.requestStream) {
      emit(`Promise<IDuplexStream<${requestTsType}, ${responseTsType}>> {\n`)
        (`${indent(2)}return this.client.getConnection('${name}').then(cnx => {\n`)
        (`${indent(3)}const stream = cnx.${loweredName}();\n`)
        (`${indent(3)}return stream;\n`)
        (`${indent(2)}});\n`)
    } else if (method.requestStream && !method.responseStream) {
      throw new Error('request-only stream requets are not supported');
    } else {
      emit(`Promise<${responseTsType}> {\n`)
        (`${indent(2)}return this.client.exec('${name}', '${loweredName}', ${req.empty ? '{}' : 'req'});\n`);
    }

    emit(`${indent(1)}}\n\n`);
  });

  emit('}\n\n');
}

function generateInterface(node, name) {
  const message = messages.find(name);
  if (message.empty) {
    return;
  }

  emit(`export interface I${name} {\n`);
  _.forOwn(node.fields, (field, fname) => {
    emit(getCommentPrefixing(`${fname} = ${field.id}`, getLineContaining(`message ${name}`)))
      (`${indent(1)}${fname}${message.response ? '' : '?'}: `)
      (`${formatType(field.type, message.response)}${field.rule === 'repeated' ? '[]' : '' };\n`);
  });
  emit('}\n\n');
}

function generateEnum(node, name) {
  enums.push(name);
  emit(`export enum ${name in pbTypeAliases ? pbTypeAliases[name] : name} {\n`);
  _.forOwn(node.values, (count, fname) => {
    emit(getCommentPrefixing(`${fname} = ${count}`, getLineContaining(`enum ${fname}`)))
      (`${indent(1)}${fname} = ${count},\n`);
  });
  emit('}\n\n');
}

function walk(ast, iterator, path = []) {
  _.forOwn(ast, (node, name) => {
    if (!node) {
      return;
    }
    if (node.nested) {
      walk(node.nested, iterator, path.concat(name));
    }

    iterator(node, name, path);
  });
}

function markResponsesFor(message) {
  message.response = true;

  _(message.node.fields)
    .values()
    .map(f => messages.find(f.type))
    .filter(Boolean)
    .forEach(markResponsesFor);
}

function prepareForGeneration(ast) {
  walk(ast, (node, name) => {
    if (node.values) {
      enums.push(name);
    }

    if (node.fields) {
      messages.add(name, {
        empty: _.isEmpty(node.fields),
        node,
        response: false,
      });
    }
  });

  walk(ast, (node, name) => {
    if (node.methods) {
      _(node.methods)
        .values()
        .map(m => messages.find(m.responseType))
        .filter(Boolean)
        .forEach(markResponsesFor);
    }
  });
}

function codeGen(ast) {
  walk(ast, (node, name) => {
    if (node.methods) {
      generateMethodCalls(node, name);
    }
    if (node.fields) {
      generateInterface(node, name);
    }
    if (node.values) {
      generateEnum(node, name);
    }
  });

  emit('export const Services = {\n');
  _.forOwn(services, (ctor, name) => {
    emit(`${indent(1)}${name}: ${ctor},\n`);
  });
  emit('};\n');
}

new pbjs.Root().load(process.argv[2], { keepCase: true }).then(ast => {
  prepareForGeneration(ast.nested);
  emit(fs.readFileSync(`${__dirname}/fixture/rpc-prefix.txt`, 'utf8'));
  emit('\n');
  codeGen(ast.nested);
}).catch(err => console.error(err.stack));
