/**
 * Thrown when an internal assertion fails.
 */
export class ClientRuntimeError extends Error {
  constructor(message: string) {
    super(
      `${message} Please report this error at https://github.com/mixer/etcd3`,
    );
  }
}

/**
 * A GRPCGenericError is rejected via the connection when some error occurs
 * that we can't be more specific about.
 */
export class GRPCGenericError extends Error {}

/**
 * GRPCConnectFailed is thrown when connecting to GRPC fails.
 */
export class GRPCConnectFailedError extends GRPCGenericError {}

/**
 * GRPCProtocolError is thrown when a protocol error occurs on the other end,
 * indicating that the external implementation is incorrect or incompatible.
 */
export class GRPCProtocolError extends GRPCGenericError {}

/**
 * GRPCInternalError is thrown when a internal error occurs on either end.
 */
export class GRPCInternalError extends GRPCGenericError {}

/**
 * GRPCCancelledError is emitted when an ongoing call is cancelled.
 */
export class GRPCCancelledError extends GRPCGenericError {}

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
 */
export class EtcdAuthenticationFailedError extends Error {}

/**
 * EtcdPermissionDeniedError is thrown when the user attempts to modify a key
 * that they don't have access to.
 */
export class EtcdPermissionDeniedError extends Error {}

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
  [
    'Attempt to send initial metadata after stream was closed',
    GRPCProtocolError,
  ],
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
  [
    'etcdserver: authentication failed, invalid user ID or password',
    EtcdAuthenticationFailedError,
  ],
  ['etcdserver: permission denied', EtcdPermissionDeniedError],
]);

function getMatchingGrpcError(err: Error): IErrorCtor | null {
  for (const [key, value] of grpcMessageToError) {
    if (err.message.includes(key)) {
      return value;
    }
  }

  return null;
}

function rewriteErrorName(
  str: string,
  ctor: new (...args: any[]) => Error,
): string {
  return str.replace(/^Error:/, `${ctor.name}:`);
}

/**
 * Tries to convert GRPC's generic, untyped errors to typed errors we can
 * consume. Yes, this method is abhorrent.
 */
export function castGrpcError(err: Error): Error {
  if ((<any>err).constructor !== Error) {
    return err; // it looks like it's already some kind of typed error
  }

  let ctor = getMatchingGrpcError(err);
  if (!ctor) {
    ctor = err.message.includes('etcdserver:') ? EtcdError : GRPCGenericError;
  }

  const castError = new ctor(rewriteErrorName(err.message, ctor));
  castError.stack = rewriteErrorName(String(err.stack), ctor);
  return castError;
}
