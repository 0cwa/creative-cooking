// Reject at the input boundary before parsing. The maximum legal ciphertext is smaller
// than this text limit, so a value truncated by the platform at maxLength also fails.
export const MAX_ARCHIVE_TEXT=16*1024*1024+1024;
export function parseRecoveryArchiveText(text){
 if(typeof text!=='string'||text.length>=MAX_ARCHIVE_TEXT)throw Error('TOO_LARGE');
 return JSON.parse(text);
}
export async function readRecoveryArchiveFile(file){
 if(!file||!Number.isSafeInteger(file.size)||file.size<1||file.size>=MAX_ARCHIVE_TEXT||typeof file.text!=='function')throw Error('TOO_LARGE');
 return parseRecoveryArchiveText(await file.text());
}
