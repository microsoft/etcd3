
/**
 * A GRPCGenericError is rejected via the connection when some error occurs
 * that we can't be more specific about.
 */
export class GRPCGenericError extends Error {
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, GRPCGenericError.prototype);
  }
}

/**
 * GRPCConnectFailed is thrown when connecting to GRPC fails.
 */
export class GRPCConnectFailedError extends GRPCGenericError {
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, GRPCConnectFailedError.prototype);
  }
}

/**
 * GRPCProtocolError is thrown when a protocol error occurs on the other end,
 * indicating that the external implementation is incorrect or incompatible.
 */
export class GRPCProtocolError extends GRPCGenericError {
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, GRPCProtocolError.prototype);
  }
}

/**
 * GRPCInternalError is thrown when a internal error occurs on either end.
 */
export class GRPCInternalError extends GRPCGenericError {
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, GRPCInternalError.prototype);
  }
}

/**
 * GRPCCancelledError is emitted when an ongoing call is cancelled.
 */
export class GRPCCancelledError extends GRPCGenericError {
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, GRPCCancelledError.prototype);
  }
}

/**
 * Mapping of GRPC error messages to typed error. GRPC errors are untyped
 * by default and sourced from within a mess of C code.
 */
const grpcMessageToError: { [message: string]: new (message: string) => GRPCGenericError } = {
  'Connect Failed': GRPCConnectFailedError,
  'Channel Disconnected': GRPCConnectFailedError,
  'Endpoint read failed': GRPCProtocolError,
  'Got config after disconnection': GRPCProtocolError,
  'Failed to create subchannel': GRPCProtocolError,
  'Attempt to send initial metadata after stream was closed': GRPCProtocolError,
  'Attempt to send message after stream was closed': GRPCProtocolError,
  'Last stream closed after sending GOAWAY': GRPCProtocolError,
  'Failed parsing HTTP/2': GRPCProtocolError,
  'TCP stream shutting down': GRPCProtocolError,
  'Secure read failed': GRPCProtocolError,
  'Handshake read failed': GRPCProtocolError,
  'Handshake write failed': GRPCProtocolError,
  'FD shutdown': GRPCInternalError,
  'Failed to load file': GRPCInternalError,
  'Unable to configure socket': GRPCInternalError,
  'Failed to add port to server': GRPCInternalError,
  'Failed to prepare server socket': GRPCInternalError,
  'Call batch failed': GRPCInternalError,
  'Missing :authority or :path': GRPCInternalError,
  'Cancelled before creating subchannel': GRPCCancelledError,
  'Pick cancelled': GRPCCancelledError,
  Disconnected: GRPCCancelledError,
};

function rewriteErrorName(str: string, ctor: new (...args: any[]) => Error): string {
  return str.replace(/^Error:/, `${ctor.name}:`);
}

/**
 * Tries to convert GRPC's generic, untyped errors to typed errors we can consume.
 */
export function castGrpcError(err: Error): Error {
  if ((<any> err).constructor !== Error) {
    return err; // it looks like it's already some kind of typed error
  }

  const ctor = grpcMessageToError[err.message] || GRPCGenericError;
  const castError = new ctor(rewriteErrorName(err.message, ctor));
  castError.stack = rewriteErrorName(String(err.stack), ctor);
  return castError;
}
