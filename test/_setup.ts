import * as chai from 'chai';

import { SharedPool } from '../src/shared-pool';

chai.use(require('chai-subset')); // tslint:disable-line
chai.use(require('chai-as-promised')); // tslint:disable-line

(<any>SharedPool).deterministicInsertion = true;
