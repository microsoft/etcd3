import * as fs from 'fs';

import { IOptions } from '../src';

const rootCertificate = fs.readFileSync(`${__dirname}/certs/certs/ca.crt`);

/**
 * Returns the host to test against.
 */
export function getHost(): string {
  return process.env.ETCD_ADDR || '127.0.0.1:2379';
}

/**
 * Returns etcd options to use for connections.
 */
export function getOptions(defaults: Partial<IOptions> = {}): IOptions {
  return {
    hosts: getHost(),
    credentials: { rootCertificate },
    ...defaults,
  };
}
