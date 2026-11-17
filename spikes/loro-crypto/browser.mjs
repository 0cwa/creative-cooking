import { run } from './probe.mjs';
window.probeResult = run().then(result => { document.body.textContent = JSON.stringify(result); return result; }).catch(error => { document.body.textContent = error.stack; throw error; });
