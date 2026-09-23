import assert from 'node:assert/strict';
import test from 'node:test';
import { applyWhisperWindow } from './whisperTranscript.ts';

test('short Whisper windows remain replaceable interim text', () => {
  const applied = applyWhisperWindow('', { text: 'tomatoes and basil' }, 7, false);
  assert.deepEqual(applied, {
    finalText: '',
    interimText: 'tomatoes and basil',
    dropSeconds: 0
  });
});

test('long Whisper windows commit timestamped phrases while retaining a tail', () => {
  const applied = applyWhisperWindow('please add', {
    text: 'tomatoes and basil and a little garlic',
    chunks: [
      { text: 'tomatoes and basil', timestamp: [0, 10] },
      { text: 'and a little', timestamp: [10, 18.5] },
      { text: 'garlic', timestamp: [18.5, 20] }
    ]
  }, 20, false);

  assert.equal(applied.finalText, 'please add tomatoes and basil and a little');
  assert.equal(applied.interimText, 'garlic');
  assert.equal(applied.dropSeconds, 18.5);
});

test('final Whisper window commits all remaining text', () => {
  const applied = applyWhisperWindow('tomatoes', {
    text: 'and basil'
  }, 3.4, true);

  assert.deepEqual(applied, {
    finalText: 'tomatoes and basil',
    interimText: '',
    dropSeconds: 3.4
  });
});
