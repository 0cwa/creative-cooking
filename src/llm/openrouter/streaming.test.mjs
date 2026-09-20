import assert from 'node:assert/strict';
import test from 'node:test';
import { LlmRequestError, normalizeLlmError } from '../errors.ts';
import { OpenRouterStreamAccumulator, SseDataParser } from './streaming.ts';

test('SSE parser preserves events split across network chunks', () => {
  const parser = new SseDataParser();

  assert.deepEqual(parser.push('data: {"choices":[{"delta":{"content":"Hel'), []);
  assert.deepEqual(
    parser.push('lo"}}]}\n\ndata: {"choices":[{"delta":{"content":"!"}}]}\n'),
    ['{"choices":[{"delta":{"content":"Hello"}}]}']
  );
  assert.deepEqual(parser.push('\n'), ['{"choices":[{"delta":{"content":"!"}}]}']);
  assert.deepEqual(parser.finish(), []);
});

test('SSE parser ignores comments and reads final unterminated data event', () => {
  const parser = new SseDataParser();
  assert.deepEqual(parser.push(': keepalive\n\ndata: [DONE]'), []);
  assert.deepEqual(parser.finish(), ['[DONE]']);
});

test('stream accumulator joins text and fragmented tool arguments by index', () => {
  const accumulator = new OpenRouterStreamAccumulator();

  assert.equal(
    accumulator.apply({ choices: [{ delta: { content: 'Dinner ' } }] }),
    'Dinner '
  );
  accumulator.apply({
    choices: [{
      delta: {
        tool_calls: [{
          index: 0,
          id: 'call_1',
          type: 'function',
          function: { name: 'recipe_save', arguments: '{"title":"Soup",' }
        }]
      }
    }]
  });
  accumulator.apply({
    choices: [{
      delta: {
        tool_calls: [{
          index: 0,
          function: { arguments: '"ingredients":[]}' }
        }]
      }
    }]
  });

  assert.deepEqual(accumulator.message(), {
    role: 'assistant',
    content: 'Dinner ',
    tool_calls: [{
      id: 'call_1',
      type: 'function',
      function: {
        name: 'recipe_save',
        arguments: '{"title":"Soup","ingredients":[]}'
      }
    }]
  });
});

test('normalizes abort and network failures into provider-independent errors', () => {
  const aborted = new Error('stopped');
  aborted.name = 'AbortError';
  const cancelError = normalizeLlmError(aborted);
  assert.ok(cancelError instanceof LlmRequestError);
  assert.equal(cancelError.kind, 'cancelled');

  const networkError = normalizeLlmError(new TypeError('Failed to fetch'));
  assert.equal(networkError.kind, 'network');
  assert.equal(networkError.retryable, true);
});
