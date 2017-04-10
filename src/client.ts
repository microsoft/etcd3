import { SharedPool } from './shared-pool';

/**
 * Super primitive client descriptor. Used for some basic type-safety when
 * wrapping in an RPC client.
 */
export interface IRawGRPC {
  [method: string]: (req: any, callback: (err: Error, res: any) => void) => void;
}

/**
 * Client is the base client that all 'sub-clients' extend from.
 */
export abstract class Client {

  constructor(protected pool: SharedPool<IRawGRPC>) {}

  /**
   * Runs a method call on the client, returning a promise
   */
  public async exec(method: string, payload: any): Promise<any> {
    return this.pool.pull().then(client => {
      return new Promise((resolve, reject) => {
        client[method](payload, (err, res) => {
          if (err) {
            reject(err);
          } else {
            resolve(res);
          }
        });
      });
    });
  }
}
