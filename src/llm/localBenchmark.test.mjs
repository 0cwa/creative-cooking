import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BENCHMARK_SCENARIOS,
  buildScenarioMessages,
  deterministicChecks
} from '../../benchmarks/local-llm/scenarios.mjs';

test('local LLM benchmark corpus has unique, complete scenarios', () => {
  assert.equal(BENCHMARK_SCENARIOS.length, 20);
  const ids = new Set(BENCHMARK_SCENARIOS.map((scenario) => scenario.id));
  assert.equal(ids.size, BENCHMARK_SCENARIOS.length);

  for (const scenario of BENCHMARK_SCENARIOS) {
    assert.ok(scenario.title);
    assert.ok(scenario.user);
    assert.ok(Array.isArray(scenario.pantry));
    assert.ok(Array.isArray(scenario.allergies));
    assert.ok(Array.isArray(scenario.cooks));
    assert.ok(scenario.portions > 0);
    assert.equal(typeof scenario.willingToShop, 'boolean');
  }
});

test('benchmark prompt keeps hard constraints and pantry context explicit', () => {
  const scenario = BENCHMARK_SCENARIOS.find((item) => item.id === 'allergy-peanut');
  const messages = buildScenarioMessages(scenario);
  assert.equal(messages[0].role, 'system');
  assert.match(messages[0].content, /hard constraints/i);
  assert.match(messages[1].content, /Allergies: peanut/i);
  assert.match(messages[1].content, /rice noodles/i);
  assert.match(messages[1].content, /spicy noodle dinner/i);
});

test('deterministic checks flag constraint terms for human review without claiming semantic failure', () => {
  const scenario = BENCHMARK_SCENARIOS.find((item) => item.id === 'allergy-tree-nut');
  const hit = deterministicChecks(scenario, 'Do not use pine nuts; use toasted breadcrumbs instead.');
  assert.equal(hit.requiresConstraintReview, true);
  assert.deepEqual(hit.forbiddenTermHits, ['pine nut']);

  const clear = deterministicChecks(scenario, 'Use toasted breadcrumbs for body.');
  assert.equal(clear.requiresConstraintReview, false);
});

test('clarification heuristic distinguishes question/no-question scenarios', () => {
  const ask = BENCHMARK_SCENARIOS.find((item) => item.id === 'clarify-important');
  const answer = BENCHMARK_SCENARIOS.find((item) => item.id === 'clarify-unnecessary');
  assert.equal(deterministicChecks(ask, 'Which fish would you like to use?').clarificationHeuristicPass, true);
  assert.equal(deterministicChecks(answer, 'Make a quick egg and scallion fried rice.').clarificationHeuristicPass, true);
});
