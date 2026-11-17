import sodium from 'libsodium-wrappers';
import {fixture} from './exchange-fixture.mjs';
import {readFile,writeFile} from 'node:fs/promises';
const f=await fixture(sodium);
if (process.argv[2] === 'generate') await writeFile('packet.json',JSON.stringify(await f.generate('fresh Node to browser')));
else if (process.argv[2] === 'open') {
 const packet=JSON.parse(await readFile('browser-packet.json','utf8'));
 if (await f.open(packet) !== 'fresh browser to Node') throw Error('wrong plaintext');
 console.log('browser to Node candidate key and content opened');
} else throw Error('expected generate or open');
