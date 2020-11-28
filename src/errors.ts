/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

export class ClientRuntimeError extends Error {
  constructor(message: string) {
    super(`${message} Please report this error at https://github.com/microsoft/etcd3`);
  }
}

/**
 * Thrown if a method is called after the client is closed.
 */
export class ClientClosedError extends Error {
  constructor(namespace: string) {
    super(`Tried to call a ${namespace} method on etcd3, but the client was already closed`);
  }
}

/**
 * Symbol present on transient errors which will be resolved through default
 * fault handling.
 */
export const RecoverableError = Symbol('RecoverableError');

/**
 * Returns whether the error is a network or server error that should trigger
 * fault-handling policies.
 */
export const isRecoverableError = (error: Error) => RecoverableError in error;

/**
 * A GRPCGenericError is rejected via the connection when some error occurs
 * that we can't be more specific about.
 */
export class GRPCGenericError extends Error {}

/**
 * GRPCProtocolError is thrown when a protocol error occurs on the other end,
 * indicating that the external implementation is incorrect or incompatible.
 */
export class GRPCProtocolError extends GRPCGenericError {}

/**
 * GRPCInternalError is thrown when a internal error occurs on either end.
 * @see https://grpc.github.io/grpc/core/md_doc_statuscodes.html
 */
export class GRPCInternalError extends GRPCGenericError {
  [RecoverableError] = true;
}

/**
 * GRPCCancelledError is emitted when an ongoing call is cancelled.
 * @see https://grpc.github.io/grpc/core/md_doc_statuscodes.html
 */
export class GRPCCancelledError extends GRPCGenericError {
  [RecoverableError] = true;
}

/**
 * Unknown error.
 * @see https://grpc.github.io/grpc/core/md_doc_statuscodes.html
 */
export class GRPCUnknownError extends GRPCGenericError {
  [RecoverableError] = true;
}

/**
 * Client specified an invalid argument.
 * @see https://grpc.github.io/grpc/core/md_doc_statuscodes.html
 */
export class GRPCInvalidArgumentError extends GRPCGenericError {}

/**
 * Deadline expired before operation could complete.
 * @see https://grpc.github.io/grpc/core/md_doc_statuscodes.html
 */
export class GRPCDeadlineExceededError extends GRPCGenericError {
  [RecoverableError] = true;
}

/**
 * Some requested entity (e.g., file or directory) was not found.
 * @see https://grpc.github.io/grpc/core/md_doc_statuscodes.html
 */
export class GRPCNotFoundError extends GRPCGenericError {}

/**
 * Some entity that we attempted to create (e.g., file or directory) already exists.
 * @see https://grpc.github.io/grpc/core/md_doc_statuscodes.html
 */
export class GRPCAlreadyExistsError extends GRPCGenericError {}

/**
 * Some resource has been exhausted, perhaps a per-user quota, or
 * perhaps the entire file system is out of space.
 * @see https://grpc.github.io/grpc/core/md_doc_statuscodes.html
 */
export class GRPCResourceExhastedError extends GRPCGenericError {
  [RecoverableError] = true;
}

/**
 * Operation was rejected because the system is not in a state
 * required for the operation's execution.
 * @see https://grpc.github.io/grpc/core/md_doc_statuscodes.html
 */
export class GRPCFailedPreconditionError extends GRPCGenericError {}

/**
 * The operation was aborted, typically due to a concurrency issue
 * like sequencer check failures, transaction aborts, etc.
 * @see https://grpc.github.io/grpc/core/md_doc_statuscodes.html
 */
export class GRPCAbortedError extends GRPCGenericError {
  [RecoverableError] = true;
}

/**
 * Operation is not implemented or not supported/enabled in this service.
 * @see https://grpc.github.io/grpc/core/md_doc_statuscodes.html
 */
export class GRPCNotImplementedError extends GRPCGenericError {}

/**
 * Operation was attempted past the valid range.  E.g., seeking or reading
 * past end of file.
 * @see https://grpc.github.io/grpc/core/md_doc_statuscodes.html
 */
export class GRPCOutOfRangeError extends GRPCGenericError {}

/**
 * Unrecoverable data loss or corruption.
 * @see https://grpc.github.io/grpc/core/md_doc_statuscodes.html
 */
export class GRPCDataLossError extends GRPCGenericError {}

/**
 * Unrecoverable data loss or corruption.
 * @see https://grpc.github.io/grpc/core/md_doc_statuscodes.html
 */
export class GRPCUnavailableError extends GRPCGenericError {
  [RecoverableError] = true;
}

/**
 * The request does not have valid authentication credentials for the operation.
 * @see https://grpc.github.io/grpc/core/md_doc_statuscodes.html
 */
export class GRPCUnauthenticatedError extends GRPCGenericError {}

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
 * @see https://grpc.github.io/grpc/core/md_doc_statuscodes.html
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
 * @see https://grpc.github.io/grpc/core/md_doc_statuscodes.html
 */
export class EtcdPermissionDeniedError extends Error {}

/**
 * EtcdWatchStreamEnded is emitted when a watch stream closes gracefully.
 * This is an unexpected occurrence.
 *
 * @see https://github.com/microsoft/etcd3/issues/72#issuecomment-386851271
 */
export class EtcdWatchStreamEnded extends Error {
  constructor() {
    super('The etcd watch stream was unexpectedly ended');
  }
}

/**
 * Etcd leader election has no leader
 */
export class EtcdNoLeaderError extends Error {}

/**
 * Process in this etcd leader election is not a leader.
 */
export class EtcdNotLeaderError extends Error {}

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

type IErrorCtor = new (message: string) => Error;

/**
 * Mapping of GRPC error messages to typed error. GRPC errors are untyped
 * by default and sourced from within a mess of C code.
 */
const grpcMessageToError = new Map<string, IErrorCtor>([
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

/**
 * Error code mapping
 * @see https://grpc.github.io/grpc/core/md_doc_statuscodes.html
 */
const grpcCodeToError = new Map<number, IErrorCtor>([
  [1, GRPCCancelledError],
  [2, GRPCUnknownError],
  [3, GRPCInvalidArgumentError],
  [4, GRPCDeadlineExceededError],
  [5, GRPCNotFoundError],
  [6, GRPCAlreadyExistsError],
  [7, EtcdPermissionDeniedError],
  [8, GRPCResourceExhastedError],
  [9, GRPCFailedPreconditionError],
  [10, GRPCAbortedError],
  [11, GRPCOutOfRangeError],
  [12, GRPCNotImplementedError],
  [13, GRPCInternalError],
  [14, GRPCUnavailableError],
  [15, GRPCDataLossError],
  [16, GRPCUnauthenticatedError],
]);

function getMatchingGrpcError(message: string): IErrorCtor | undefined {
  for (const [key, value] of grpcMessageToError) {
    if (message.includes(key)) {
      return value;
    }
  }

  return undefined;
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
export function castGrpcError<T extends Error>(err: T): Error {
  if (err.constructor !== Error) {
    return err; // it looks like it's already some kind of typed error
  }

  let ctor = getMatchingGrpcError(err.message);
  if (!ctor && 'code' in err && typeof (err as any).code === 'number') {
    ctor = grpcCodeToError.get((err as any).code);
  }

  if (!ctor) {
    ctor = err.message.includes('etcdserver:') ? EtcdError : GRPCGenericError;
  }

  const castError = new ctor(rewriteErrorName(err.message, ctor));
  castError.stack = rewriteErrorName(String(err.stack), ctor);
  return castError;
}
