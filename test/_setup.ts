import * as chai from 'chai';

import { SharedPool } from '../src/shared-pool';

chai.use(require('chai-subset')); // tslint:disable-line

(<any> SharedPool).deterministicInsertion = true;
