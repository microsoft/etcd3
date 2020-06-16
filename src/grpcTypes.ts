/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
import * as grpc from 'grpc';

/**
 * ChannelOptions may be passed into the Client to configure GRPC internals.
 */
// tslint:disable-next-line: interface-name
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

// tslint:disable-next-line: interface-name
export interface StatusMessage {
  code: number;
  details: string;
  metadata: grpc.Metadata;
}
