/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

// Uncomment for verbose GRPC traces:
// process.env.GRPC_VERBOSITY = 'DEBUG';
// process.env.GRPC_TRACE = 'all';

import { ConnectionPool } from '../connection-pool.js';

ConnectionPool.deterministicOrder = true;
