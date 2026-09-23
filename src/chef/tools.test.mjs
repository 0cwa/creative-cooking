import assert from 'node:assert/strict';
import test from 'node:test';
import { CHEF_TOOLS } from './tools.ts';

function tool(name) {
  return CHEF_TOOLS.find((entry) => entry.function.name === name)?.function;
}

test('pantry tools support concise descriptive details and in-place refinement', () => {
  const add = tool('pantry_add');
  const update = tool('pantry_update');

  assert.ok(add);
  assert.match(add.description, /dried/i);
  assert.match(add.description, /frozen/i);

  assert.ok(update);
  assert.match(update.description, /without changing its star preference/i);
  assert.deepEqual(update.parameters.required, ['name', 'newName']);
});
