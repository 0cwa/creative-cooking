import {REVIEW_LIMITS} from './review.mjs';
import {canonicalReportBytes,validateReport} from './report.mjs';

const decoder = new TextDecoder('utf-8',{fatal:true});
const HEADER_LIMIT = 128 * 1024;
export const REPORT_FILE_LIMIT = 4 + HEADER_LIMIT + REVIEW_LIMITS.bytes;
const hexId = x => typeof x === 'string' && /^[0-9a-f]{64}$/.test(x);

// Four bytes of big-endian metadata length, JSON signed report and manifest,
// then original encrypted envelopes in the signed manifest order.
export function encodeReportFile(report,manifest,objects) {
  const header = canonicalReportBytes({version:1,report,manifest});
  if (header.length > HEADER_LIMIT) throw Error('TOO_LARGE');
  const size = 4 + header.length + objects.reduce((n,object) => n + object.bytes.length,0);
  if (size > REPORT_FILE_LIMIT) throw Error('TOO_LARGE');
  const file = new Uint8Array(size);
  new DataView(file.buffer).setUint32(0,header.length);
  file.set(header,4);
  let offset = 4 + header.length;
  for (const {bytes} of objects) {
    file.set(bytes,offset);
    offset += bytes.length;
  }
  return file;
}

export function decodeReportFile(file) {
  if (!(file instanceof Uint8Array) || file.length < 5 || file.length > REPORT_FILE_LIMIT) throw Error('INVALID_REPORT_FILE_SIZE');
  const length = new DataView(file.buffer,file.byteOffset,file.byteLength).getUint32(0);
  if (length > HEADER_LIMIT || length === 0 || 4 + length > file.length) throw Error('INVALID_REPORT_FILE_SIZE');
  if (file.length - 4 - length > REVIEW_LIMITS.bytes) throw Error('TOO_LARGE');
  let header;
  try { header = JSON.parse(decoder.decode(file.subarray(4,4 + length))); }
  catch { throw Error('MALFORMED_REPORT_FILE'); }
  const {version,report,manifest} = header ?? {};
  if (Object.keys(header ?? {}).sort().join(',') !== 'manifest,report,version' || version !== 1 ||
      !report || !Array.isArray(manifest) || manifest.length > REVIEW_LIMITS.objects) throw Error('MALFORMED_REPORT_FILE');
  const ids = new Set();
  let offset = 4 + length;
  for (const row of manifest) {
    if (Object.keys(row ?? {}).sort().join(',') !== 'bytes,hash,objectId,sourceId' || !['outbound','inbox'].includes(row.sourceId) ||
        !hexId(row.objectId) || !hexId(row.hash) || ids.has(row.objectId) ||
        !Number.isSafeInteger(row.bytes) || row.bytes < 1 || row.bytes > REVIEW_LIMITS.objectBytes) throw Error('MALFORMED_MANIFEST');
    offset += row.bytes;
    ids.add(row.objectId);
  }
  if (offset !== file.length) throw Error('INVALID_REPORT_FILE_SIZE');
  validateReport(report,manifest);
  // Reject duplicate JSON fields and alternate encoded spellings before any staging.
  const canonical = canonicalReportBytes(header);
  if(canonical.length!==length || !canonical.every((byte,i)=>byte===file[i+4]))throw Error('MALFORMED_REPORT_FILE');
  offset = 4 + length;
  const objects = manifest.map(({bytes,objectId,sourceId}) => {
    const object = {objectId,sourceId,bytes:file.subarray(offset,offset + bytes)};
    offset += bytes;
    return object;
  });
  return {report,manifest,objects,measuredBytes:file.length - 4 - length};
}
