import { ConnectionPool } from './connection-pool';
import { IOptions } from './options';
import * as RPC from './rpc';

export class Etcd3 {

  private pool = new ConnectionPool(this.options);

  public readonly kv = new RPC.KVClient(this.pool);
  public readonly lease = new RPC.LeaseClient(this.pool);
  public readonly auth = new RPC.AuthClient(this.pool);
  public readonly maintenance = new RPC.MaintenanceClient(this.pool);
  public readonly watch = new RPC.WatchClient(this.pool);
  public readonly cluest = new RPC.ClusterClient(this.pool);

  constructor(private options: IOptions) {}
}
