/* tslint:disable */
import { PackageDefinition } from '@grpc/proto-loader';
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
 * The deadline of an operation. If it is a date, the deadline is reached at
 * the date and time specified. If it is a finite number, it is treated as
 * a number of milliseconds since the Unix Epoch. If it is Infinity, the
 * deadline will never be reached. If it is -Infinity, the deadline has already
 * passed.
 */
export type Deadline = number | Date;

/**
 * Options that can be set on a call.
 */
export interface CallOptions {
  /**
   * The deadline for the entire call to complete.
   */
  deadline?: Deadline;
  /**
   * Server hostname to set on the call. Only meaningful if different from
   * the server address used to construct the client.
   */
  host?: string;
  /**
   * Indicates which properties of a parent call should propagate to this
   * call. Bitwise combination of flags in `grpc.propagate`.
   */
  propagate_flags: number;
  /**
   * The credentials that should be used to make this particular call.
   */
  credentials: CallCredentials;
}

/**
 * Describes some generic GRPC call or service function. This is super generic,
 * you'll probably want to override or cast these based on your specific typing.
 */
export type grpcCall =
  // Simple GRPC call, one request and one response.
  | ((args: object, callback: (err: Error | null, result: any) => void) => void)
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
  constructor(address: string, credentials: ChannelCredentials, options?: ChannelOptions);

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
 * Load a gRPC package definition as a gRPC object hierarchy
 * @param packageDef The package definition object
 * @return The resulting gRPC object
 */
export function loadPackageDefinition(
  packageDefinition: PackageDefinition,
): { [namespace: string]: { [service: string]: typeof Client } };

/**
 * Tears down a GRPC client.
 */
export function closeClient(client: Client): void;

/**
 * Runs the callback after the connection is established.
 */
export function waitForClientRead(
  client: Client,
  deadline: Date | Number,
  callback: (err: Error | null) => void,
): void;

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
  export function createSsl(
    rootCerts?: Buffer,
    privateKey?: Buffer,
    certChain?: Buffer,
  ): CallCredentials;

  /**
   * Combine any number of CallCredentials into a single CallCredentials object.
   */
  export function combineCallCredentials(...credentials: CallCredentials[]): CallCredentials;

  /**
   * Combine a ChannelCredentials with any number of CallCredentials into a
   * single ChannelCredentials object.
   */
  export function combineChannelCredentials(
    channelCredential: ChannelCredentials,
    ...callCredentials: CallCredentials[]
  ): ChannelCredentials;

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

export const status: Readonly<{
  OK: 0;
  CANCELLED: 1;
  UNKNOWN: 2;
  INVALID_ARGUMENT: 3;
  DEADLINE_EXCEEDED: 4;
  NOT_FOUND: 5;
  ALREADY_EXISTS: 6;
  PERMISSION_DENIED: 7;
  RESOURCE_EXHAUSTED: 8;
  FAILED_PRECONDITION: 9;
  ABORTED: 10;
  OUT_OF_RANGE: 11;
  UNIMPLEMENTED: 12;
  INTERNAL: 13;
  UNAVAILABLE: 14;
  DATA_LOSS: 15;
  UNAUTHENTICATED: 16;
}>;

export interface StatusMessage {
  code: number;
  details: string;
  metadata: Metadata;
}

/**
 * ChannelOptions may be passed into the Client to configure GRPC internals.
 */
export interface ChannelOptions {
  /**
   * If non-zero, allow the use of SO_REUSEPORT if it's available (default 1)
   */
  'grpc.so_reuseport'?: number;

  /**
   * Default authority to pass if none specified on call construction.
   */
  'grpc.default_authority'?: string;

  /**
   * If non-zero, enable census for tracing and stats collection.
   */
  'grpc.census'?: number;

  /**
   * Enable/disable support for deadline checking.
   *
   * Defaults to 1, unless GRPC_ARG_MINIMAL_STACK is enabled
   *  in which case it defaults to 0
   */
  'grpc.enable_deadline_checking'?: number;

  /**
   * If non-zero, enable load reporting.
   */
  'grpc.loadreporting'?: number;

  /**
   * Enable/disable support for per-message compression.
   *
   * Defaults to 1, unless GRPC_ARG_MINIMAL_STACK is enabled, in which
   * case it defaults to 0.
   */
  'grpc.per_message_compression'?: number;

  /**
   * If non-zero, expand wildcard addresses to a list of local addresses.
   */
  'grpc.expand_wildcard_addrs'?: number;

  /**
   * (Not Documented)
   */
  'grpc.grpclb_timeout_ms'?: number;

  /**
   * Should BDP probing be performed?
   */
  'grpc.http2.bdp_probe'?: number;

  /**
   * Should we allow receipt of true-binary data on http2 connections
   *  Defaults to on (1)
   */
  'grpc.http2.true_binary'?: number;

  /**
   * How much memory to use for hpack decoding.
   *
   * Int valued, bytes.
   */
  'grpc.http2.hpack_table_size.decoder'?: number;

  /**
   * How much memory to use for hpack encoding.
   *
   * Int valued, bytes.
   */
  'grpc.http2.hpack_table_size.encoder'?: number;

  /**
   * Initial stream ID for http2 transports.
   *
   * Int valued.
   */
  'grpc.http2.initial_sequence_number'?: number;

  /**
   * How big a frame are we willing to receive via HTTP2.
   *
   * Min 16384, max 16777215. Larger values give lower CPU usage for large
   * messages, but more head of line blocking for small messages.
   */
  'grpc.http2.max_frame_size'?: number;

  /**
   * How many misbehaving pings the server can bear before sending goaway and
   * closing the transport? (0 indicates that the server can bear an infinit
   * number of misbehaving pings)
   */
  'grpc.http2.max_ping_strikes'?: number;

  /**
   * How many pings can we send before needing to send a data frame or header
   * frame? (0 indicates that an infinite number of pings can be sent without
   * sending a data frame or header frame)
   */
  'grpc.http2.max_pings_without_data'?: number;

  /**
   * Minimum allowed time between two pings without sending any data frame.
   *
   * Int valued, seconds
   */
  'grpc.http2.min_ping_interval_without_data_ms'?: number;

  /**
   * Minimum time (in milliseconds) between successive ping frames being sent.
   */
  'grpc.http2.min_time_between_pings_ms'?: number;

  /**
   * Channel arg to override the http2 :scheme header.
   */
  'grpc.http2_scheme'?: string;

  /**
   * Amount to read ahead on individual streams.
   *
   * Defaults to 64kb, larger values can help throughput on high-latency
   * connections. NOTE: at some point we'd like to auto-tune this,
   * and this parameter will become a no-op. Int valued, bytes.
   */
  'grpc.http2.lookahead_bytes'?: number;

  /**
   * How much data are we willing to queue up per stream i
   *  GRPC_WRITE_BUFFER_HINT is set? This is an upper bound.
   */
  'grpc.http2.write_buffer_size'?: number;

  /**
   * The time between the first and second connection attempts, in ms.
   */
  'grpc.initial_reconnect_backoff_ms'?: number;

  /**
   * Is it permissible to send keepalive pings without any outstanding streams.
   *
   * Int valued, 0(false)/1(true).
   */
  'grpc.keepalive_permit_without_calls'?: number;

  /**
   * After a duration of this time the client/server pings its peer to
   * see if the transport is still alive.
   *
   * Int valued, milliseconds.
   */
  'grpc.keepalive_time_ms'?: number;

  /**
   * After waiting for a duration of this time, if the keepalive ping sender
   * does not receive the ping ack, it will close the transport.
   *
   * Int valued, milliseconds.
   */
  'grpc.keepalive_timeout_ms'?: number;

  /**
   * LB policy name.
   */
  'grpc.lb_policy_name'?: string;

  /**
   * Maximum number of concurrent incoming streams to allow on a http2 connection.
   *
   * Int valued.
   */
  'grpc.max_concurrent_streams'?: number;

  /**
   * Grace period after the chennel reaches its max age.
   *
   * Int valued, milliseconds. INT_MAX means unlimited.
   */
  'grpc.max_connection_age_grace_ms'?: number;

  /**
   * Maximum time that a channel may exist.
   *
   * Int valued, milliseconds. INT_MAX means unlimited.
   */
  'grpc.max_connection_age_ms'?: number;

  /**
   * Maximum time that a channel may have no outstanding rpcs.
   *
   * Int valued, milliseconds. INT_MAX means unlimited.
   */
  'grpc.max_connection_idle_ms'?: number;

  /**
   * Maximum metadata size, in bytes.
   *
   * Note this limit applies to the max sum of all metadata key-value
   * entries in a batch of headers.
   */
  'grpc.max_metadata_size'?: number;

  /**
   * Maximum message length that the channel can receive.
   *
   * Int valued, bytes. -1 means unlimited.
   */
  'grpc.max_receive_message_length'?: number;

  /**
   * The maximum time between subsequent connection attempts, in ms.
   */
  'grpc.max_reconnect_backoff_ms'?: number;

  /**
   * Maximum message length that the channel can send.
   *
   * Int valued, bytes. -1 means unlimited.
   */
  'grpc.max_send_message_length'?: number;

  /**
   * The minimum time between subsequent connection attempts, in ms.
   */
  'grpc.min_reconnect_backoff_ms'?: number;

  /**
   * Request that optional features default to off (regardless of what they
   * usually default to) - to enable tight control over what gets enabled.
   */
  'grpc.minimal_stack'?: boolean;

  /**
   * String defining the optimization target for a channel.
   *
   * Can be:
   *   "latency" - attempt to minimize latency at the cost of throughput
   *   "blend" - try to balance latency and throughput
   *   "throughput" - attempt to maximize throughput at the expense of latency
   *
   * Defaults to "blend". In the current implementation "blend"
   * is equivalent to "latency".
   */
  'grpc.optimization_target'?: 'latency' | 'blend' | 'throughput';

  /**
   * Primary user agent: goes at the start of the user-agent metadata sent on each request.
   */
  'grpc.primary_user_agent'?: string;

  /**
   * Secondary user agent: goes at the end of the user-agent metadata sent on each request.
   */
  'grpc.secondary_user_agent'?: string;

  /**
   * Service config data in JSON form.
   *
   * This value will be ignored if the name resolver returns a service config.
   */
  'grpc.service_config'?: string;

  /**
   * Disable looking up the service config via the name resolver.
   */
  'grpc.service_config_disable_resolution'?: boolean;

  /**
   * (Not Documented)
   */
  'grpc.experimental.tcp_max_read_chunk_size'?: number;

  /**
   * (Not Documented)
   */
  'grpc.experimental.tcp_min_read_chunk_size'?: number;

  /**
   * Channel arg (integer) setting how large a slice to try and read from the wire each time recvmsg (or equivalent) is called.
   */
  'grpc.experimental.tcp_read_chunk_size'?: number;

  /**
   * If non-zero, Cronet transport will coalesce packets to fewer frames when possible.
   */
  'grpc.use_cronet_packet_coalescing'?: number;

  /**
   * If non-zero, grpc server's cronet compression workaround will be enabled.
   */
  'grpc.workaround.cronet_compression'?: number;

  /**
   * Default compression algorithm for the channel.
   *
   * Its value is an int from the grpc_compression_algorithm enum.
   */
  'grpc.default_compression_algorithm'?: number;

  /**
   * Default compression level for the channel.
   *
   * Its value is an int from the grpc_compression_level enum.
   * @see https://grpc.io/grpc/cpp/compression__types_8h.html#a14a79ed6b5ebd7e1dda7c2684f499cc7
   */
  'grpc.default_compression_level'?: number;

  /**
   * Compression algorithms supported by the channel.
   *
   * Its value is a bitset (an int). Bits correspond to algorithms in
   * grpc_compression_algorithm. For example, its LSB corresponds to
   * GRPC_COMPRESS_NONE, the next bit to GRPC_COMPRESS_DEFLATE, etc. Unset bits
   * disable support for the algorithm. By default all algorithms are
   * supported. It's not possible to disable GRPC_COMPRESS_NONE
   * (the attempt will be ignored).
   */
  'grpc.compression_enabled_algorithms_bitset'?: number;

  /**
   * This should be used for testing only.
   *
   * The caller of the secure_channel_create functions may override the target
   * name used for SSL host name checking using this channel argument which is
   * of type GRPC_ARG_STRING. If this argument is not specified, the name used
   * for SSL host name checking will be the target parameter (assuming that the
   * secure channel is an SSL channel). If this parameter is specified and the
   * underlying is not an SSL channel, it will just be ignored.
   */
  'grpc.ssl_target_name_override'?: string;
}
