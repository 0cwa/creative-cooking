export async function chooseExchangeFile({accept,minBytes,maxBytes}:{accept:string[];minBytes:number;maxBytes:number}) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = accept.join(',');
  const file = await new Promise<File|null>(resolve => {
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.oncancel = () => resolve(null);
    input.click();
  });
  if (!file) return null;
  if (file.size < minBytes || file.size > maxBytes) throw Error('INVALID_FILE_SIZE');
  return new Uint8Array(await file.arrayBuffer());
}

export async function saveExchangeFile(name:string, mimeType:string, bytes:Uint8Array) {
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes).buffer], {type:mimeType}));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
