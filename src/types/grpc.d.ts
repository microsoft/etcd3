/* tslint:disable */

import { Duplex, Readable, Writable } from 'stream';

export class ChannelCredentials {
  private constructor();
}

export class CallCredentials {
  private constructor();
}

export class Service {
  private constructor();
}

/**
 * Describes some generic GRPC call or service function. This is super generic,
 * you'll probably want to override or cast these based on your specific typing.
 */
export type grpcCall =
  // Simple GRPC call, one request and one response.
  ((args: object, callback: (err: Error | null, result: any) => void) => void)
  // A readable stream call, where a request is made with one set of args.
  | ((args: object) => Readable)
  // A writeable stream call, where the client can write many data points
  // to the stream and await a single response from the server.
  | ((callback: (err: Error | null, result: any) => void) => Writable)
  // A duplex stream, where both the client and server send asynchronous calls.
  | (() => Duplex);

/**
 * Describes a handle to a GRPC client, returned from load(). Note that other
 * methods will be defined on the client per the protobuf definitions, but
 * these cannot be typed here.
 */
export class Client {
  /**
   * Creates a new instance of the client.
   */
  constructor(address: string, credentials: ChannelCredentials);

  /**
   * The Service associated with the client, used for creating GRPC servers.
   */
  service: Service;
}

export class Server {
  /**
   * Add a proto service to the server, with a corresponding implementation.
   */
  addService(service: Service, implementations: { [method: string]: grpcCall }): void;

  /**
   * Binds the server to the given port, with SSL enabled if credentials are given.
   */
  bind(port: string, credentials: ChannelCredentials): void;

  /**
   * Forcibly shuts down the server. The server will stop receiving new calls
   * and cancel all pending calls. When it returns, the server has shut down.
   * This method is idempotent with itself and tryShutdown, and it will trigger
   * any outstanding tryShutdown callbacks.
   */
  forceShutdown(): void;

  /**
   * Start the server and begin handling requests.
   */
  start(): void;

  /**
   * Gracefully shuts down the server. The server will stop receiving new
   * calls, and any pending calls will complete. The callback will be called
   * when all pending calls have completed and the server is fully shut down.
   * This method is idempotent with itself and forceShutdown.
   */
  tryShutdown(callback: () => void): void;
}

export interface LoadOptions {
  /**
   * Load this file with field names in camel case instead of their
   * original case. Defaults to false.
   */
  convertFieldsToCamelCase?: boolean;

  /**
   * Deserialize bytes values as base64 strings instead of Buffers.
   * Defaults to false.
   */
  binaryAsBase64?: boolean;

  /**
   * Deserialize long values as strings instead of objects. Defaults to true.
   */
  longsAsStrings?: boolean;

  /**
   * Deserialize enum values as strings instead of numbers. Defaults to true.
   */
  enumsAsStrings?: boolean;

  /**
   * Use the beta method argument order for client methods, with optional
   * arguments after the callback. Defaults to false. This option is only a
   * temporary stopgap measure to smooth an API breakage. It is deprecated,
   * and new code should not use it.
   */
  deprecatedArgumentOrder?: boolean;
}

/**
 * Load a gRPC object from a .proto file.
 */
export function load(
  filename: string,
  format?: 'proto' | 'json',
  options?: LoadOptions,
): { [namespace: string]: { [service: string]: typeof Client } };

/**
 * Tears down a GRPC client.
 */
export function closeClient(client: Client): void;

/**
 * Runs the callback after the connection is established.
 */
export function waitForClientRead(client: Client, deadline: Date | Number, callback: (err: Error | null) => void): void;

/**
 * Class for storing metadata. Keys are normalized to lowercase ASCII.
 */
export class Metadata {
  /**
   * Adds the given value for the given key. Normalizes the key.
   */
  add(key: string, value: string | Buffer): void;

  /**
   * Sets the given value for the given key, replacing any other values
   * associated with that key. Normalizes the key.
   */
  set(key: string, value: string | Buffer): void;

  /**
   * Sets the given value for the given key, replacing any other values
   * associated with that key. Normalizes the key.
   */
  remove(key: string): void;

  /**
   * Clone the metadata object.
   */
  clone(): Metadata;

  /**
   * Gets a list of all values associated with the key. Normalizes the key.
   */
  get(key: string): (string | Buffer)[];

  /**
   * Get a map of each key to a single associated value. This reflects
   * the most common way that people will want to see metadata.
   */
  getMap(): { [key: string]: string | Buffer };
}

export namespace credentials {

  /**
   * Create an insecure credentials object. This is used to create a channel
   * that does not use SSL. This cannot be composed with anything.
   */
  export function createInsecure(): CallCredentials;

  /**
   * Create an SSL Credentials object. If using a client-side certificate, both
   * the second and third arguments must be passed.
   */
  export function createSsl(rootCerts: Buffer, privateKey?: Buffer, certChain?: Buffer): CallCredentials;

  /**
   * Combine any number of CallCredentials into a single CallCredentials object.
   */
  export function combineCallCredentials(...credentials: CallCredentials[]): CallCredentials;

  /**
   * Combine a ChannelCredentials with any number of CallCredentials into a
   * single ChannelCredentials object.
   */
  export function combineChannelCredentials(channelCredential: ChannelCredentials,
    ...callCredentials: CallCredentials[]): ChannelCredentials;

  /**
   * Create a gRPC credential from a Google credential object.
   * todo(connor4312): type
   */
  export function createFromGoogleCredential(googleCredential: any): CallCredentials;

  /**
   * IMetadataGenerator can be passed into createFromMetadataGenerator.
   */
  export interface IMetadataGenerator {
    (
      target: { service_url: string },
      callback: (error: Error | null, metadata?: Metadata) => void,
    ): void;
  }

  /**
   * Create a gRPC credential from a Google credential object.
   * todo(connor4312): type
   */
  export function createFromMetadataGenerator(generator: IMetadataGenerator): CallCredentials;
}
