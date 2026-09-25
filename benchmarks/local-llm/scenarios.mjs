export const BENCHMARK_SCENARIOS = [
  {
    "id": "normal-pantry",
    "title": "Normal pantry dinner",
    "user": "What should I make for dinner tonight?",
    "pantry": [
      "chicken thighs",
      "rice",
      "broccoli",
      "lemons",
      "garlic",
      "yogurt",
      "parsley"
    ],
    "allergies": [],
    "willingToShop": false,
    "portions": 2,
    "cooks": [
      "medium"
    ],
    "notes": "Should produce a practical, appealing meal from the pantry without inventing required shopping."
  },
  {
    "id": "sparse-pantry",
    "title": "Sparse pantry",
    "user": "Can you make something satisfying from this?",
    "pantry": [
      "eggs",
      "rice",
      "soy sauce",
      "frozen peas"
    ],
    "allergies": [],
    "willingToShop": false,
    "portions": 1,
    "cooks": [
      "low"
    ],
    "notes": "Should stay simple and avoid requiring unavailable ingredients beyond ordinary water, salt, and pepper."
  },
  {
    "id": "large-pantry",
    "title": "Large pantry selection",
    "user": "Give me one creative dinner that uses what I have well.",
    "pantry": [
      "chickpeas",
      "lentils",
      "cannellini beans",
      "tomatoes",
      "eggplant",
      "zucchini",
      "spinach",
      "carrots",
      "onions",
      "garlic",
      "ginger",
      "coconut milk",
      "rice",
      "couscous",
      "pasta",
      "tahini",
      "yogurt",
      "lemons",
      "limes",
      "cilantro",
      "parsley",
      "mint (dried)",
      "cumin",
      "coriander",
      "paprika",
      "chili flakes",
      "feta"
    ],
    "allergies": [],
    "willingToShop": false,
    "portions": 4,
    "cooks": [
      "medium"
    ],
    "notes": "Should select a coherent subset instead of dumping the pantry into one dish."
  },
  {
    "id": "perishables-first",
    "title": "Prefer perishables",
    "user": "What would be a good dinner?",
    "pantry": [
      "spinach (wilting)",
      "mushrooms",
      "cream",
      "pasta",
      "canned tomatoes",
      "rice",
      "dried lentils"
    ],
    "allergies": [],
    "willingToShop": false,
    "portions": 2,
    "cooks": [
      "medium"
    ],
    "notes": "Should naturally prefer the spinach/mushrooms/cream over shelf-stable alternatives."
  },
  {
    "id": "low-energy",
    "title": "Low-energy cook",
    "user": "I want something good but I am exhausted.",
    "pantry": [
      "eggs",
      "tortillas",
      "black beans",
      "salsa",
      "cheddar",
      "avocado"
    ],
    "allergies": [],
    "willingToShop": false,
    "portions": 2,
    "cooks": [
      "low"
    ],
    "notes": "Should be genuinely low effort, not merely described as easy."
  },
  {
    "id": "two-cooks",
    "title": "Two cooks with mixed energy",
    "user": "We want to cook together. Make it fun but not an ordeal.",
    "pantry": [
      "salmon",
      "potatoes",
      "green beans",
      "dill",
      "lemon",
      "mustard",
      "yogurt"
    ],
    "allergies": [],
    "willingToShop": false,
    "portions": 2,
    "cooks": [
      "high",
      "low"
    ],
    "notes": "Should offer useful parallel tasks without assuming both cooks want difficult work."
  },
  {
    "id": "main-plus-side",
    "title": "Meal can benefit from a side",
    "user": "I want a nice weekend dinner. A main and side is fine if it makes sense.",
    "pantry": [
      "pork tenderloin",
      "apples",
      "cabbage",
      "potatoes",
      "mustard",
      "sage",
      "butter"
    ],
    "allergies": [],
    "willingToShop": false,
    "portions": 4,
    "cooks": [
      "high"
    ],
    "notes": "May propose more than one recipe, but only if they form a coherent meal."
  },
  {
    "id": "shopping-allowed",
    "title": "Shopping allowed",
    "user": "I can grab one or two things if it makes dinner much better.",
    "pantry": [
      "gnocchi",
      "spinach",
      "garlic",
      "parmesan"
    ],
    "allergies": [],
    "willingToShop": true,
    "portions": 2,
    "cooks": [
      "medium"
    ],
    "notes": "Shopping suggestions should be high-value and restrained."
  },
  {
    "id": "shopping-disabled",
    "title": "Shopping disabled",
    "user": "I cannot go to the store. What can I make?",
    "pantry": [
      "potatoes",
      "eggs",
      "onions",
      "frozen spinach",
      "cheddar"
    ],
    "allergies": [],
    "willingToShop": false,
    "portions": 2,
    "cooks": [
      "medium"
    ],
    "forbiddenTerms": [
      "cream",
      "bacon"
    ],
    "notes": "Must not require ingredients that are absent."
  },
  {
    "id": "allergy-peanut",
    "title": "Peanut allergy hard constraint",
    "user": "Could you make me a spicy noodle dinner?",
    "pantry": [
      "rice noodles",
      "tofu",
      "lime",
      "cilantro",
      "soy sauce",
      "sesame oil",
      "chili crisp"
    ],
    "allergies": [
      "peanut"
    ],
    "willingToShop": true,
    "portions": 2,
    "cooks": [
      "medium"
    ],
    "forbiddenTerms": [
      "peanut",
      "groundnut"
    ],
    "notes": "Must not suggest peanut ingredients or sauces."
  },
  {
    "id": "allergy-tree-nut",
    "title": "Tree-nut allergy with tempting recipe family",
    "user": "I want pesto pasta.",
    "pantry": [
      "pasta",
      "basil",
      "parmesan",
      "garlic",
      "olive oil",
      "breadcrumbs"
    ],
    "allergies": [
      "tree nuts"
    ],
    "willingToShop": false,
    "portions": 2,
    "cooks": [
      "medium"
    ],
    "forbiddenTerms": [
      "pine nut",
      "walnut",
      "almond",
      "cashew"
    ],
    "notes": "Should adapt pesto without tree nuts rather than quietly using them."
  },
  {
    "id": "explicit-avoid",
    "title": "Explicit do-not-use preference",
    "user": "Make dinner, but do not use the mushrooms tonight.",
    "pantry": [
      "mushrooms",
      "chicken breast",
      "rice",
      "peas",
      "lemon",
      "garlic"
    ],
    "allergies": [],
    "willingToShop": false,
    "portions": 2,
    "cooks": [
      "medium"
    ],
    "forbiddenTerms": [
      "mushroom"
    ],
    "notes": "Must respect the explicit exclusion even though mushrooms are available."
  },
  {
    "id": "ingredient-state",
    "title": "Ingredient form matters",
    "user": "I want something fresh-tasting and quick.",
    "pantry": [
      "mint (dried)",
      "okra (frozen)",
      "fava beans (cooked, refrigerated)",
      "lemons",
      "yogurt",
      "couscous"
    ],
    "allergies": [],
    "willingToShop": false,
    "portions": 2,
    "cooks": [
      "low"
    ],
    "notes": "Should respect dried/frozen/cooked qualifiers rather than treating ingredients as fresh/raw."
  },
  {
    "id": "substitution",
    "title": "Substitution request",
    "user": "This recipe normally uses cream, but I only have yogurt. Can I make that work?",
    "pantry": [
      "yogurt",
      "pasta",
      "mushrooms",
      "garlic",
      "parmesan"
    ],
    "allergies": [],
    "willingToShop": false,
    "portions": 2,
    "cooks": [
      "medium"
    ],
    "notes": "Should give practical technique advice to avoid splitting rather than just saying yes."
  },
  {
    "id": "leftovers",
    "title": "Leftover reuse",
    "user": "I have leftover roast chicken. Make it feel like a different meal.",
    "pantry": [
      "roast chicken (cooked, refrigerated)",
      "rice",
      "frozen corn",
      "black beans",
      "lime",
      "salsa",
      "cheddar"
    ],
    "allergies": [],
    "willingToShop": false,
    "portions": 2,
    "cooks": [
      "low"
    ],
    "notes": "Should intentionally transform leftovers rather than re-serving the original meal."
  },
  {
    "id": "not-a-recipe",
    "title": "Best answer is not a full recipe",
    "user": "How can I make my tomato soup taste less flat?",
    "pantry": [
      "tomato soup",
      "butter",
      "cream",
      "lemon",
      "basil",
      "chili flakes"
    ],
    "allergies": [],
    "willingToShop": false,
    "portions": 2,
    "cooks": [
      "low"
    ],
    "notes": "Should answer the technique question directly instead of forcing a complete recipe."
  },
  {
    "id": "clarify-important",
    "title": "Clarification is worthwhile",
    "user": "Make something special with the fish.",
    "pantry": [
      "salmon",
      "cod",
      "rice",
      "potatoes",
      "lemons",
      "herbs"
    ],
    "allergies": [],
    "willingToShop": false,
    "portions": 4,
    "cooks": [
      "high"
    ],
    "expectQuestion": true,
    "notes": "A concise clarification about which fish or preferred direction can materially change the result."
  },
  {
    "id": "clarify-unnecessary",
    "title": "Do not over-clarify",
    "user": "Give me an easy fried-rice idea using my leftovers.",
    "pantry": [
      "rice (cooked, refrigerated)",
      "eggs",
      "frozen peas",
      "soy sauce",
      "scallions"
    ],
    "allergies": [],
    "willingToShop": false,
    "portions": 2,
    "cooks": [
      "low"
    ],
    "expectQuestion": false,
    "notes": "Enough information exists; an unnecessary question is a UX regression."
  },
  {
    "id": "explicit-save",
    "title": "Explicit save intent",
    "user": "Give me a concrete shakshuka recipe and assume I want to save it after I review it.",
    "pantry": [
      "eggs",
      "canned tomatoes",
      "onions",
      "garlic",
      "paprika",
      "cumin"
    ],
    "allergies": [],
    "willingToShop": false,
    "portions": 2,
    "cooks": [
      "medium"
    ],
    "notes": "Should produce a concrete save-worthy recipe; benchmark records whether structured action intent is clear."
  },
  {
    "id": "ambiguous-pantry-change",
    "title": "Ambiguous pantry mutation",
    "user": "I think the old spinach is probably gone now.",
    "pantry": [
      "spinach",
      "eggs",
      "rice"
    ],
    "allergies": [],
    "willingToShop": false,
    "portions": 1,
    "cooks": [
      "medium"
    ],
    "expectQuestion": true,
    "notes": "Should not confidently mutate/remove pantry state from an ambiguous statement."
  }
];

export function buildScenarioMessages(scenario) {
  const system = [
    'You are the Chef in Creative Cooking. Help make creative, practical meals from the supplied context.',
    'Allergies and explicit do-not-use instructions are hard constraints.',
    'When shopping is disabled, do not require unavailable ingredients except ordinary water, salt, and pepper.',
    'Prefer useful perishables when appropriate. Respect ingredient qualifiers such as dried, frozen, cooked, or refrigerated.',
    'Ask one concise clarification only when it would materially change the recommendation; otherwise answer directly.',
    'Do not claim to have changed application state. This benchmark is evaluating cooking quality only.'
  ].join('\n');

  const context = [
    'Allergies: ' + (scenario.allergies.length ? scenario.allergies.join(', ') : 'none listed'),
    'Shopping allowed: ' + (scenario.willingToShop ? 'yes' : 'no'),
    'Portions: ' + scenario.portions,
    'Cook energy: ' + scenario.cooks.join(', '),
    'Pantry:',
    ...scenario.pantry.map((item) => '- ' + item)
  ].join('\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: context + '\n\nRequest:\n' + scenario.user }
  ];
}

export function deterministicChecks(scenario, output) {
  const text = output.toLowerCase();
  const forbiddenHits = (scenario.forbiddenTerms ?? []).filter((term) => text.includes(term.toLowerCase()));
  const hasQuestion = output.includes('?');
  return {
    forbiddenHits,
    forbiddenPass: forbiddenHits.length === 0,
    clarificationHeuristicPass: scenario.expectQuestion === undefined
      ? null
      : scenario.expectQuestion === hasQuestion
  };
}
