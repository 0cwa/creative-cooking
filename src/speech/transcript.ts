function normalizeSpeech(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function appendSpeech(existing: string, next: string): string {
  const left = normalizeSpeech(existing);
  const right = normalizeSpeech(next);
  if (!left) return right;
  if (!right) return left;
  return `${left} ${right}`;
}

export function joinDictation(finalText: string, interimText: string): string {
  return appendSpeech(finalText, interimText);
}

export function appendDictationToDraft(draft: string, dictated: string): string {
  const speech = normalizeSpeech(dictated);
  if (!speech) return draft;
  if (!draft) return speech;
  if (/\s$/.test(draft)) return `${draft}${speech}`;
  return `${draft} ${speech}`;
}
