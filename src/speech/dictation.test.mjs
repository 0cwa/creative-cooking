import assert from 'node:assert/strict';
import test from 'node:test';
import { WebSpeechDictationController } from './dictation.web.ts';
import { appendDictationToDraft, joinDictation } from './transcript.ts';

function result(transcript, isFinal) {
  return { 0: { transcript }, isFinal, length: 1 };
}

class FakeRecognition {
  static instances = [];
  static availability = 'available';
  static availabilityByLanguage = new Map();
  static installs = 0;
  static options = [];

  static async available(options) {
    this.options.push(options);
    return this.availabilityByLanguage.get(options.langs[0]) ?? this.availability;
  }

  static async install(options) {
    this.options.push(options);
    this.installs += 1;
    return true;
  }

  continuous = false;
  interimResults = false;
  lang = '';
  processLocally = false;
  onstart = null;
  onresult = null;
  onerror = null;
  onend = null;
  stopCalls = 0;

  constructor() {
    FakeRecognition.instances.push(this);
  }

  start() {
    this.onstart?.();
  }

  stop() {
    this.stopCalls += 1;
    this.onend?.();
  }

  emitResults(results, resultIndex = 0) {
    this.onresult?.({ results, resultIndex });
  }

  end() {
    this.onend?.();
  }
}

function resetFake() {
  FakeRecognition.instances = [];
  FakeRecognition.availability = 'available';
  FakeRecognition.availabilityByLanguage = new Map();
  FakeRecognition.installs = 0;
  FakeRecognition.options = [];
}

test('dictation transcript replaces interim text and commits final text without duplication', async () => {
  resetFake();
  const snapshots = [];
  const controller = new WebSpeechDictationController(FakeRecognition, 'en-US');
  await controller.start({ lang: 'en-US', onChange: (snapshot) => snapshots.push(snapshot) });

  const recognition = FakeRecognition.instances[0];
  recognition.emitResults([result('tom', false)]);
  recognition.emitResults([result('tomatoes', false)]);
  recognition.emitResults([result('tomatoes', true)]);
  recognition.emitResults([result('tomatoes', true), result('and basil', false)], 1);

  const latest = snapshots.at(-1);
  assert.equal(latest.finalText, 'tomatoes');
  assert.equal(latest.interimText, 'and basil');
  assert.equal(joinDictation(latest.finalText, latest.interimText), 'tomatoes and basil');
  assert.equal(appendDictationToDraft('Please add', 'tomatoes and basil'), 'Please add tomatoes and basil');
});

test('browser end restarts recognition while the user still wants dictation active', async () => {
  resetFake();
  const scheduled = [];
  const controller = new WebSpeechDictationController(
    FakeRecognition,
    'en-US',
    (callback) => { scheduled.push(callback); return scheduled.length; },
    () => {}
  );
  await controller.start({ lang: 'en-US', onChange: () => {} });

  FakeRecognition.instances[0].end();
  assert.equal(scheduled.length, 1);
  scheduled.shift()();
  assert.equal(FakeRecognition.instances.length, 2);
  assert.equal(FakeRecognition.instances[1].processLocally, true);
});

test('user Stop prevents a recognizer end from restarting the session', async () => {
  resetFake();
  const scheduled = [];
  const snapshots = [];
  const controller = new WebSpeechDictationController(
    FakeRecognition,
    'en-US',
    (callback) => { scheduled.push(callback); return scheduled.length; },
    () => {}
  );
  await controller.start({ lang: 'en-US', onChange: (snapshot) => snapshots.push(snapshot) });

  const recognition = FakeRecognition.instances[0];
  controller.stop();
  assert.equal(recognition.stopCalls, 1);
  assert.equal(scheduled.length, 0);
  assert.equal(snapshots.at(-1).status, 'idle');
});

test('downloadable English packs are installed for local dictation quality', async () => {
  resetFake();
  FakeRecognition.availability = 'downloadable';
  const snapshots = [];
  const controller = new WebSpeechDictationController(FakeRecognition, 'en-US');
  await controller.start({ lang: 'en-US', onChange: (snapshot) => snapshots.push(snapshot) });

  assert.equal(FakeRecognition.installs, 1);
  assert.equal(FakeRecognition.options[0].processLocally, true);
  assert.equal(FakeRecognition.options[0].quality, 'dictation');
  assert.equal(FakeRecognition.options[0].langs[0], 'en-US');
  assert.ok(snapshots.some((snapshot) => snapshot.status === 'installing-language'));
  assert.equal(snapshots.at(-1).status, 'listening');
});

test('regional browser locale cannot block English dictation and English packs fall back', async () => {
  resetFake();
  FakeRecognition.availabilityByLanguage.set('en-US', 'unavailable');
  FakeRecognition.availabilityByLanguage.set('en-GB', 'available');

  const controller = new WebSpeechDictationController(FakeRecognition, 'en-DK');
  await controller.start({ lang: 'en-DK', onChange: () => {} });

  assert.deepEqual(
    FakeRecognition.options.slice(0, 2).map((options) => options.langs[0]),
    ['en-US', 'en-GB']
  );
  assert.equal(FakeRecognition.instances[0].lang, 'en-GB');
});
