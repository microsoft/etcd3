/**
 * Thrown when an internal assertion fails.
 */
export class ClientRuntimeError extends Error {
  constructor(message: string) {
    super(`${message} Please report this error at https://github.com/mixer/etcd3`);
  }
}

/**
 * A GRPCGenericError is rejected via the connection when some error occurs
 * that we can't be more specific about.
 */
export class GRPCGenericError extends Error {}

/**
 * GRPCConnectFailed is thrown when connecting to GRPC fails.
 * @see https://github.com/grpc/grpc/blob/v1.4.x/src/node/src/constants.js#L151-L158
 */
export class GRPCConnectFailedError extends GRPCGenericError {}

/**
 * GRPCProtocolError is thrown when a protocol error occurs on the other end,
 * indicating that the external implementation is incorrect or incompatible.
 */
export class GRPCProtocolError extends GRPCGenericError {}

/**
 * GRPCInternalError is thrown when a internal error occurs on either end.
 * @see https://github.com/grpc/grpc/blob/v1.4.x/src/node/src/constants.js#L145-L150
 */
export class GRPCInternalError extends GRPCGenericError {}

/**
 * GRPCCancelledError is emitted when an ongoing call is cancelled.
 * @see https://github.com/grpc/grpc/blob/v1.4.x/src/node/src/constants.js#L48-L49
 */
export class GRPCCancelledError extends GRPCGenericError {}

/**
 * Unknown error.
 * @see https://github.com/grpc/grpc/blob/v1.4.x/src/node/src/constants.js#L50-L57
 */
export class GRPCUnknownError extends GRPCGenericError {}

/**
 * Client specified an invalid argument.
 * @see https://github.com/grpc/grpc/blob/v1.4.x/src/node/src/constants.js#L58-L64
 */
export class GRPCInvalidArgumentError extends GRPCGenericError {}

/**
 * Deadline expired before operation could complete.
 * @see https://github.com/grpc/grpc/blob/v1.4.x/src/node/src/constants.js#L65-L72
 */
export class GRPCDeadlineExceededError extends GRPCGenericError {}

/**
 * Some requested entity (e.g., file or directory) was not found.
 * @see https://github.com/grpc/grpc/blob/v1.4.x/src/node/src/constants.js#L73-L74
 */
export class GRPCNotFoundError extends GRPCGenericError {}

/**
 * Some entity that we attempted to create (e.g., file or directory) already exists.
 * @see https://github.com/grpc/grpc/blob/v1.4.x/src/node/src/constants.js#L75-L79
 */
export class GRPCAlreadyExistsError extends GRPCGenericError {}

/**
 * Some resource has been exhausted, perhaps a per-user quota, or
 * perhaps the entire file system is out of space.
 * @see https://github.com/grpc/grpc/blob/v1.4.x/src/node/src/constants.js#L89-L93
 */
export class GRPCResourceExhastedError extends GRPCGenericError {}

/**
 * Operation was rejected because the system is not in a state
 * required for the operation's execution.
 * @see https://github.com/grpc/grpc/blob/v1.4.x/src/node/src/constants.js#L94-L116
 */
export class GRPCFailedPreconditionError extends GRPCGenericError {}

/**
 * The operation was aborted, typically due to a concurrency issue
 * like sequencer check failures, transaction aborts, etc.
 * @see https://github.com/grpc/grpc/blob/v1.4.x/src/node/src/constants.js#L117-L124
 */
export class GRPCAbortedError extends GRPCGenericError {}

/**
 * Operation is not implemented or not supported/enabled in this service.
 * @see https://github.com/grpc/grpc/blob/v1.4.x/src/node/src/constants.js#L143-L144
 */
export class GRPCNotImplementedError extends GRPCGenericError {}

/**
 * Operation was attempted past the valid range.  E.g., seeking or reading
 * past end of file.
 * @see https://github.com/grpc/grpc/blob/v1.4.x/src/node/src/constants.js#L125-L142
 */
export class GRPCOutOfRangeError extends GRPCGenericError {}

/**
 * Unrecoverable data loss or corruption.
 * @see https://github.com/grpc/grpc/blob/v1.4.x/src/node/src/constants.js#L159-L160
 */
export class GRPCDataLossError extends GRPCGenericError {}

/**
 * EtcdError is an application error returned by etcd.
 */
export class EtcdError extends Error {}

/**
 * EtcdLeaseInvalidError is thrown when trying to renew a lease that's
 * expired.
 */
export class EtcdLeaseInvalidError extends Error {
  constructor(leaseID: string) {
    super(`Lease ${leaseID} is expired or revoked`);
  }
}

/**
 * EtcdRoleExistsError is thrown when trying to create a role that already exists.
 */
export class EtcdRoleExistsError extends Error {}

/**
 * EtcdUserExistsError is thrown when trying to create a user that already exists.
 */
export class EtcdUserExistsError extends Error {}

/**
 * EtcdRoleNotGrantedError is thrown when trying to revoke a role from a user
 * to which the role is not granted.
 */
export class EtcdRoleNotGrantedError extends Error {}

/**
 * EtcdRoleNotFoundError is thrown when trying to operate on a role that does
 * not exist.
 */
export class EtcdRoleNotFoundError extends Error {}

/**
 * EtcdUserNotFoundError is thrown when trying to operate on a user that does
 * not exist.
 */
export class EtcdUserNotFoundError extends Error {}

/**
 * EtcdLockFailedError is thrown when we fail to aquire a lock.
 */
export class EtcdLockFailedError extends Error {}

/**
 * EtcdAuthenticationFailedError is thrown when an invalid username/password
 * combination is submitted.
 *
 * @see https://github.com/grpc/grpc/blob/v1.4.x/src/node/src/constants.js#L161-L165
 */
export class EtcdAuthenticationFailedError extends Error {}

/**
 * EtcdInvalidAuthTokenError is thrown when an invalid or expired authentication
 * token is presented.
 */
export class EtcdInvalidAuthTokenError extends Error {}

/**
 * EtcdPermissionDeniedError is thrown when the user attempts to modify a key
 * that they don't have access to.
 *
 * Also can be emitted from GRPC.
 *
 * @see https://github.com/grpc/grpc/blob/v1.4.x/src/node/src/constants.js#L80-L88
 */
export class EtcdPermissionDeniedError extends Error {}

/**
 * EtcdWatchStreamEnded is emitted when a watch stream closes gracefully.
 * This is an unexpected occurrence.
 *
 * @see https://github.com/mixer/etcd3/issues/72#issuecomment-386851271
 */
export class EtcdWatchStreamEnded extends Error {
  constructor() {
    super('The etcd watch stream was unexpectedly ended');
  }
}

/**
 * An STMConflictError is thrown from the `SoftwareTransaction.transact`
 * if we continue to get conflicts and exceed the maximum number
 * of retries.
 */
export class STMConflictError extends Error {
  constructor() {
    super('A conflict occurred executing the software transaction');
  }
}

interface IErrorCtor {
  new (message: string): Error;
}

/**
 * Mapping of GRPC error messages to typed error. GRPC errors are untyped
 * by default and sourced from within a mess of C code.
 */
const grpcMessageToError = new Map<string, IErrorCtor>([
  ['Connect Failed', GRPCConnectFailedError],
  ['Channel Disconnected', GRPCConnectFailedError],
  ['Endpoint read failed', GRPCProtocolError],
  ['Got config after disconnection', GRPCProtocolError],
  ['Failed to create subchannel', GRPCProtocolError],
  ['Attempt to send initial metadata after stream was closed', GRPCProtocolError],
  ['Attempt to send message after stream was closed', GRPCProtocolError],
  ['Last stream closed after sending GOAWAY', GRPCProtocolError],
  ['Failed parsing HTTP/2', GRPCProtocolError],
  ['TCP stream shutting down', GRPCProtocolError],
  ['Secure read failed', GRPCProtocolError],
  ['Handshake read failed', GRPCProtocolError],
  ['Handshake write failed', GRPCProtocolError],
  ['FD shutdown', GRPCInternalError],
  ['Failed to load file', GRPCInternalError],
  ['Unable to configure socket', GRPCInternalError],
  ['Failed to add port to server', GRPCInternalError],
  ['Failed to prepare server socket', GRPCInternalError],
  ['Call batch failed', GRPCInternalError],
  ['Missing :authority or :path', GRPCInternalError],
  ['Cancelled before creating subchannel', GRPCCancelledError],
  ['Pick cancelled', GRPCCancelledError],
  ['Disconnected', GRPCCancelledError],
  ['etcdserver: role name already exists', EtcdRoleExistsError],
  ['etcdserver: user name already exists', EtcdUserExistsError],
  ['etcdserver: role is not granted to the user', EtcdRoleNotGrantedError],
  ['etcdserver: role name not found', EtcdRoleNotFoundError],
  ['etcdserver: user name not found', EtcdUserNotFoundError],
  ['etcdserver: authentication failed, invalid user ID or password', EtcdAuthenticationFailedError],
  ['etcdserver: permission denied', EtcdPermissionDeniedError],
  ['etcdserver: invalid auth token', EtcdInvalidAuthTokenError],
  ['etcdserver: requested lease not found', EtcdLeaseInvalidError],
]);

function getMatchingGrpcError(message: string): IErrorCtor | null {
  for (const [key, value] of grpcMessageToError) {
    if (message.includes(key)) {
      return value;
    }
  }

  return null;
}

function rewriteErrorName(str: string, ctor: new (...args: any[]) => Error): string {
  return str.replace(/^Error:/, `${ctor.name}:`);
}

/**
 * Tries to convert an Etcd error string to an etcd error.
 */
export function castGrpcErrorMessage(message: string): Error {
  const ctor = getMatchingGrpcError(message) || EtcdError;
  return new ctor(message);
}

/**
 * Tries to convert GRPC's generic, untyped errors to typed errors we can
 * consume. Yes, this method is abhorrent.
 */
export function castGrpcError(err: Error): Error {
  if ((<any>err).constructor !== Error) {
    return err; // it looks like it's already some kind of typed error
  }

  let ctor = getMatchingGrpcError(err.message);
  if (!ctor) {
    ctor = err.message.includes('etcdserver:') ? EtcdError : GRPCGenericError;
  }

  const castError = new ctor(rewriteErrorName(err.message, ctor));
  castError.stack = rewriteErrorName(String(err.stack), ctor);
  return castError;
}
