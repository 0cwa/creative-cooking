// Bundle with libsodium-wrappers 0.7.15 and esbuild for an isolated browser test.
import sodium from 'libsodium-wrappers';
import {fixture} from './exchange-fixture.mjs';
window.ready = fixture(sodium).then(exchange => { window.exchange = exchange; });
