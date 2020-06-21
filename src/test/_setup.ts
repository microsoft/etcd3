/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
import * as chai from 'chai';
import { ConnectionPool } from '../connection-pool';

chai.use(require('chai-subset')); // tslint:disable-line
chai.use(require('chai-as-promised')); // tslint:disable-line

ConnectionPool.deterministicOrder = true;
