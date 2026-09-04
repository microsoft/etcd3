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

const rootFiles = ['api/authpb/auth.proto', 'api/mvccpb/kv.proto', 'api/etcdserverpb/rpc.proto'];
const outputNames = new Map([
  ['api/authpb/auth.proto', 'auth.proto'],
  ['api/mvccpb/kv.proto', 'kv.proto'],
  ['api/etcdserverpb/rpc.proto', 'rpc.proto'],
]);
const etcdApiImportPrefix = 'etcd/api/';
// These imports only define annotations, which are omitted from the local gRPC schema.
const metadataOnlyImports = new Set([
  'etcd/api/versionpb/version.proto',
  'google/api/annotations.proto',
  'protoc-gen-openapiv2/options/annotations.proto',
]);

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

function getInternalImportPath(importPath) {
  if (metadataOnlyImports.has(importPath)) {
    return undefined;
  }
  return importPath.startsWith(etcdApiImportPrefix) ? importPath.slice('etcd/'.length) : undefined;
}

function getOutputName(sourcePath) {
  return outputNames.get(sourcePath) ?? path.basename(sourcePath);
}

function importsFrom(contents) {
  return [...contents.matchAll(/^\s*import\s+(?:public\s+|weak\s+)?["']([^"']+)["'];/gm)].map(
    ([, importPath]) => importPath,
  );
}

function stripOptionDeclarations(contents) {
  let optionDepth;

  return contents
    .split(/\r?\n/g)
    .filter(line => {
      if (optionDepth !== undefined) {
        optionDepth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
        if (optionDepth <= 0 && line.includes(';')) {
          optionDepth = undefined;
        }
        return false;
      }

      if (!/^\s*option\b/.test(line)) {
        return true;
      }

      optionDepth = (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
      if (optionDepth <= 0 && line.includes(';')) {
        optionDepth = undefined;
      }
      return false;
    })
    .join('\n');
}

function stripVersionAnnotations(contents) {
  return contents.replace(/\s+\[\(versionpb\.[^)]+\)\s*=\s*"[^"]*"\]/g, '');
}

function transform(contents, sourcePath) {
  const packageName = contents.match(/^\s*package\s+([^;]+);/m)?.[1];
  if (!packageName) {
    throw new Error(`No package declaration in ${sourcePath}`);
  }

  const localImports = importsFrom(contents).map(importPath => {
    if (metadataOnlyImports.has(importPath)) {
      return '';
    }
    const internalImportPath = getInternalImportPath(importPath);
    if (internalImportPath) {
      return `import "./${getOutputName(internalImportPath)}";`;
    }
    if (importPath.startsWith('google/protobuf/')) {
      return `import "${importPath}";`;
    }
    throw new Error(`Cannot safely bundle external import ${importPath} from ${sourcePath}`);
  });

  const body = stripVersionAnnotations(stripOptionDeclarations(contents))
    .split(/\r?\n/g)
    .filter(line => {
      return !/^\s*(?:import|package|syntax)\b/.test(line);
    })
    .map(lowerCaseEnumFields)
    .join('\n')
    .replace(/^\n+/, '')
    .replace(/\n\n+/g, '\n');

  const imports = localImports.filter(Boolean).join('\n');
  return `syntax = "proto3";\npackage ${packageName};\n${imports ? `${imports}\n` : ''}\n${body}`;
}

async function fetchContents(sourcePath) {
  const response = await fetch(`${baseUrl}/${sourcePath}`);
  if (!response.ok) {
    throw new Error(`Failed to download ${sourcePath}: ${response.status} ${response.statusText}`);
  }
  return response.text();
}

async function main() {
  const files = new Map();

  async function fetchWithDependencies(sourcePath) {
    if (files.has(sourcePath)) {
      return;
    }

    const contents = await fetchContents(sourcePath);
    files.set(sourcePath, contents);
    await Promise.all(
      importsFrom(contents).map(getInternalImportPath).filter(Boolean).map(fetchWithDependencies),
    );
  }

  await Promise.all(rootFiles.map(fetchWithDependencies));

  const names = new Map();
  for (const sourcePath of files.keys()) {
    const outputName = getOutputName(sourcePath);
    const existingSourcePath = names.get(outputName);
    if (existingSourcePath && existingSourcePath !== sourcePath) {
      throw new Error(
        `Cannot bundle ${sourcePath}; ${outputName} already maps to ${existingSourcePath}`,
      );
    }
    names.set(outputName, sourcePath);
  }

  await Promise.all(
    [...files.entries()]
      .sort(([first], [second]) => first.localeCompare(second))
      .map(([sourcePath, contents]) => {
        return fs.writeFile(
          path.join(process.argv[2], getOutputName(sourcePath)),
          transform(contents, sourcePath),
        );
      }),
  );
}

main().catch(err => {
  console.error(err.stack);
  process.exitCode = 1;
});
