import {openLocalWorkspace} from '../../../src/loro/app/bootstrap.web.ts';
import {openSequences} from '../../../src/loro/app/sequences.web.ts';
import {openLocalWorkspace as oldOpen} from './original-bootstrap.ts';
import {openSequences as oldSequences} from './sequences.web.ts';
Object.assign(window,{proof:{openLocalWorkspace,openSequences,oldOpen,oldSequences}});
