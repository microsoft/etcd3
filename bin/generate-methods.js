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
const templates = {};

const pbTypeAliases = {
  bool: 'boolean',
  string: 'string',
  bytes: 'Buffer',
  Type: 'Permission',
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
    process.stdout.write(string.replace(/\n\n+/g, '\n\n'));
  }

  return emit;
}

function template(name, params) {
  if (!templates[name]) {
    templates[name] = _.template(fs.readFileSync(`${__dirname}/template/${name}.tmpl`, 'utf8'));
  }

  params = Object.assign(params || {}, {
    getCommentPrefixing,
    getLineContaining,
    formatType,
    aliases: pbTypeAliases,
  });

  emit(
    templates[name](params)
      .replace(/^\-\- *\n/gm, '')
      .replace(/^\-\-/gm, '')
  );
}

function stripPackageNameFrom(name) {
  if (name.includes('.')) {
    name = name.replace(/^.+\./, '');
  }

  return name;
}

function formatTypeInner(type, isInResponse) {
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

function formatType(type, isInResponse = false) {
  const isEnum = enums.includes(type);
  const formatted = formatTypeInner(type, isInResponse);

  // grpc unmarshals enums as their string representations.
  if (isEnum) {
    return isInResponse
      ? `keyof typeof ${formatted}`
      : `(${formatted} | keyof typeof ${formatted})`;
  }

  return formatted;
}

function getLineContaining(substring, from = 0) {
  return lines.findIndex((l, i) => i >= from && l.includes(substring));
}

function indent(level) {
  let out = '';
  for (let i = 0; i < level; i += 1) {
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

  return ['/**', ...comments, ' */'].map(line => `${indent(indentation)}${line}`).join('\n');
}

function generateMethodCalls(node, name) {
  services[name] = `${name}Client`;
  template('class-header', { name });

  _.forOwn(node.methods, (method, mname) => {
    const req = messages.find(method.requestType);
    const res = messages.find(method.responseType);

    const params = {
      name: mname,
      req,
      requestTsType: req.empty ? 'void' : formatType(method.requestType),
      res,
      responseTsType: res.empty ? 'void' : formatType(method.responseType),
      service: name,
    };

    if (method.responseStream && !method.requestStream) {
      template('response-stream-method', params);
    } else if (method.responseStream && method.requestStream) {
      template('duplex-stream-method', params);
    } else if (method.requestStream && !method.responseStream) {
      throw new Error('request-only stream requets are not supported');
    } else {
      template('basic-method', params);
    }
  });

  emit('}\n\n');
}

function generateInterface(node, name) {
  const message = messages.find(name);
  if (message.empty) {
    return;
  }

  template('interface', { name, node, message });
}

function generateEnum(node, name) {
  template('enum', { name, node });
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

  template('service-map', { services });
}

new pbjs.Root()
  .load(process.argv[2], { keepCase: true })
  .then(ast => {
    prepareForGeneration(ast.nested);
    template('rpc-prefix');
    codeGen(ast.nested);
  })
  .catch(err => console.error(err.stack));
