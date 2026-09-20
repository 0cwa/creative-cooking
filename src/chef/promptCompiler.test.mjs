import assert from 'node:assert/strict';
import test from 'node:test';
import { compileChefSystemPrompt } from './promptCompiler.ts';

function state(overrides = {}) {
  return {
    pantry: [],
    recipes: [],
    chatMessages: [],
    mealContext: { willingToShop: false, portions: 2, cooks: ['medium'] },
    settings: {
      systemPrompt: 'Cook creatively.',
      allergies: [],
      sendLocalTime: false,
      city: '',
      providerId: 'openrouter',
      model: 'openrouter/free'
    },
    ...overrides
  };
}

test('compiles pantry, allergies, meal context, and optional location deterministically', () => {
  const value = state({
    mealContext: { willingToShop: true, portions: 4, cooks: ['low', 'high'] },
    settings: {
      systemPrompt: 'Cook creatively.',
      allergies: ['peanuts', 'shellfish'],
      sendLocalTime: true,
      city: ' Stockholm ',
      providerId: 'openrouter',
      model: 'openrouter/free'
    }
  });

  const prompt = compileChefSystemPrompt(value, 'Would like to eat:\n- carrots', {
    localTime: '2026-09-20 18:30',
    timeZone: 'Europe/Stockholm'
  });

  assert.match(prompt, /Allergies \(hard constraint — never include these\):\n- peanuts\n- shellfish/);
  assert.match(prompt, /Would like to eat:\n- carrots/);
  assert.match(prompt, /Willing to shop: yes\nPortions: 4\nCooks: 2\nEnergy: Cook 1: low, Cook 2: high/);
  assert.match(prompt, /Local time: 2026-09-20 18:30\nTime zone: Europe\/Stockholm/);
  assert.match(prompt, /City: Stockholm/);
});

test('does not leak time or city when sharing is disabled or blank', () => {
  const prompt = compileChefSystemPrompt(state(), 'Open to eating:\n- (none)', {
    localTime: 'SHOULD NOT APPEAR',
    timeZone: 'SHOULD NOT APPEAR'
  });

  assert.match(prompt, /Allergies .*\n- \(none listed\)/);
  assert.match(prompt, /Local time: not shared/);
  assert.match(prompt, /City: not shared/);
  assert.doesNotMatch(prompt, /SHOULD NOT APPEAR/);
});
