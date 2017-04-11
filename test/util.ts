/**
 * Returns etcd hosts to test against.
 */
export function getHosts(): string {
  return process.env.ETCD_ADDR || '127.0.0.1:2379';
}
