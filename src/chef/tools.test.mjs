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


test('every mutation tool can request confirmation instead of applying immediately', () => {
  for (const name of ['pantry_add', 'pantry_update', 'pantry_remove', 'pantry_set_preference', 'recipe_save']) {
    const mutation = tool(name);
    assert.ok(mutation, `missing ${name}`);
    assert.equal(mutation.parameters.properties.propose.type, 'boolean');
    assert.match(mutation.parameters.properties.propose.description, /user confirmation/i);
  }

  assert.equal(tool('ask_user').parameters.properties.propose, undefined);
});
