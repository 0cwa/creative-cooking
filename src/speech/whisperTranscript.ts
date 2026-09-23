import { appendSpeech } from './transcript';

export type WhisperTimestampChunk = {
  text: string;
  timestamp?: [number | null, number | null];
};

export type WhisperWindowResult = {
  text: string;
  chunks?: WhisperTimestampChunk[];
};

export type AppliedWhisperWindow = {
  finalText: string;
  interimText: string;
  dropSeconds: number;
};

const COMMIT_AFTER_SECONDS = 20;
const KEEP_TAIL_SECONDS = 1;

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function applyWhisperWindow(
  currentFinal: string,
  result: WhisperWindowResult,
  durationSeconds: number,
  finalize: boolean
): AppliedWhisperWindow {
  const text = normalize(result.text);

  if (finalize) {
    return {
      finalText: appendSpeech(currentFinal, text),
      interimText: '',
      dropSeconds: Math.max(0, durationSeconds)
    };
  }

  if (durationSeconds < COMMIT_AFTER_SECONDS) {
    return {
      finalText: currentFinal,
      interimText: text,
      dropSeconds: 0
    };
  }

  const cutoff = Math.max(0, durationSeconds - KEEP_TAIL_SECONDS);
  const timestamped = (result.chunks ?? []).filter((chunk) => {
    const end = chunk.timestamp?.[1];
    return typeof end === 'number' && Number.isFinite(end);
  });

  if (!timestamped.length) {
    return {
      finalText: appendSpeech(currentFinal, text),
      interimText: '',
      dropSeconds: durationSeconds
    };
  }

  const committed = timestamped.filter((chunk) => (chunk.timestamp?.[1] ?? Infinity) <= cutoff);
  if (!committed.length) {
    return {
      finalText: currentFinal,
      interimText: text,
      dropSeconds: 0
    };
  }

  const committedText = normalize(committed.map((chunk) => chunk.text).join(' '));
  const dropSeconds = committed.reduce((latest, chunk) => {
    const end = chunk.timestamp?.[1];
    return typeof end === 'number' ? Math.max(latest, end) : latest;
  }, 0);
  const remainingText = normalize(
    timestamped
      .filter((chunk) => (chunk.timestamp?.[1] ?? 0) > dropSeconds)
      .map((chunk) => chunk.text)
      .join(' ')
  );

  return {
    finalText: appendSpeech(currentFinal, committedText),
    interimText: remainingText,
    dropSeconds
  };
}
