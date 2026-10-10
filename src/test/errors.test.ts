/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
import { describe, expect, it } from 'vitest';

import { castGrpcError, castGrpcErrorMessage, EtcdLeaseInvalidError } from '../errors.js';

const requestedLeaseNotFound = '5 NOT_FOUND: etcdserver: requested lease not found';
const genericLeaseNotFoundMessage = 'The requested lease was not found';

describe('gRPC error casting', () => {
  it.each([
    ['gRPC error message', () => castGrpcErrorMessage(requestedLeaseNotFound)],
    ['gRPC error', () => castGrpcError(new Error(requestedLeaseNotFound))],
  ])('casts a requested lease not found %s without inventing a lease ID', (_source, cast) => {
    const error = cast();

    expect(error).toBeInstanceOf(EtcdLeaseInvalidError);
    expect(error.message).toBe(genericLeaseNotFoundMessage);
  });

  it('preserves the lease ID message when one is supplied directly', () => {
    expect(new EtcdLeaseInvalidError('123')).toMatchObject({
      message: 'Lease 123 is expired or revoked',
    });
  });

  it('keeps normalized lease errors consistent with their original stack frames', () => {
    const original = new Error(requestedLeaseNotFound);
    original.stack = `Error: ${requestedLeaseNotFound}\n    at originalCall (errors.test.ts:1:1)`;

    const error = castGrpcError(original);

    expect(error).toBeInstanceOf(EtcdLeaseInvalidError);
    expect(error.stack).toBe(
      `${error.name}: ${genericLeaseNotFoundMessage}\n    at originalCall (errors.test.ts:1:1)`,
    );
  });
});
