import * as chai from 'chai';

import { SharedPool } from '../src/shared-pool';

chai.use(require('chai-subset'));

(<any> SharedPool).deterministicInsertion = true;
