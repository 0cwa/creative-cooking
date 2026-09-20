import type { RecipeIngredient } from './types';

export type RecipeAllergyMatchKind = 'direct' | 'alias' | 'possible';

export type RecipeAllergyMatch = {
  allergy: string;
  ingredient: string;
  matchedTerm: string;
  kind: RecipeAllergyMatchKind;
};

export type RecipeAllergyValidation = {
  ok: boolean;
  matches: RecipeAllergyMatch[];
};

type AliasGroup = {
  terms: string[];
};

type CategoryRule = {
  allergies: string[];
  ingredients: string[];
  kind: Exclude<RecipeAllergyMatchKind, 'direct'>;
};

const ALIAS_GROUPS: AliasGroup[] = [
  { terms: ['peanut', 'groundnut'] },
  { terms: ['soy', 'soya'] },
  { terms: ['shrimp', 'prawn'] },
  { terms: ['chickpea', 'garbanzo bean'] },
  { terms: ['zucchini', 'courgette'] },
  { terms: ['eggplant', 'aubergine'] },
  { terms: ['lupin', 'lupine'] }
];

const CATEGORY_RULES: CategoryRule[] = [
  {
    allergies: ['tree nut'],
    ingredients: [
      'almond',
      'brazil nut',
      'cashew',
      'hazelnut',
      'macadamia',
      'pecan',
      'pistachio',
      'walnut'
    ],
    kind: 'alias'
  },
  {
    allergies: ['nuts', 'nut'],
    ingredients: [
      'almond',
      'brazil nut',
      'cashew',
      'groundnut',
      'hazelnut',
      'macadamia',
      'peanut',
      'pecan',
      'pistachio',
      'walnut'
    ],
    kind: 'possible'
  },
  {
    allergies: ['shellfish'],
    ingredients: [
      'clam',
      'crab',
      'crayfish',
      'lobster',
      'mussel',
      'octopus',
      'oyster',
      'prawn',
      'scallop',
      'shrimp',
      'squid'
    ],
    kind: 'alias'
  },
  {
    allergies: ['fish'],
    ingredients: [
      'anchovy',
      'bass',
      'cod',
      'haddock',
      'halibut',
      'herring',
      'mackerel',
      'pollock',
      'salmon',
      'sardine',
      'tilapia',
      'trout',
      'tuna'
    ],
    kind: 'possible'
  },
  {
    allergies: ['milk', 'dairy'],
    ingredients: [
      'butter',
      'buttermilk',
      'casein',
      'cheese',
      'cream',
      'ghee',
      'milk',
      'whey',
      'yogurt',
      'yoghurt'
    ],
    kind: 'possible'
  },
  {
    allergies: ['gluten'],
    ingredients: [
      'barley',
      'bulgur',
      'couscous',
      'farro',
      'rye',
      'semolina',
      'soy sauce',
      'spelt',
      'wheat'
    ],
    kind: 'possible'
  },
  {
    allergies: ['egg'],
    ingredients: ['aioli', 'custard', 'mayonnaise', 'mayo', 'meringue'],
    kind: 'possible'
  },
  {
    allergies: ['soy', 'soya'],
    ingredients: ['edamame', 'miso', 'tamari', 'tempeh', 'tofu'],
    kind: 'possible'
  },
  {
    allergies: ['sesame'],
    ingredients: ['tahini'],
    kind: 'alias'
  },
  {
    allergies: ['celery'],
    ingredients: ['celeriac'],
    kind: 'possible'
  }
];

function normalize(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function normalizeAllergy(value: string): string {
  return normalize(value)
    .replace(/^allergic to\s+/, '')
    .replace(/\s+allergy$/, '')
    .trim();
}

function numberVariants(term: string): string[] {
  const words = term.split(' ');
  const last = words.at(-1) ?? '';
  const prefix = words.slice(0, -1).join(' ');
  const variants = new Set([term]);

  if (last.endsWith('ies') && last.length > 4) {
    variants.add([prefix, `${last.slice(0, -3)}y`].filter(Boolean).join(' '));
  } else if (last.endsWith('oes') && last.length > 4) {
    variants.add([prefix, last.slice(0, -2)].filter(Boolean).join(' '));
  } else if (last.endsWith('s') && !last.endsWith('ss') && last.length > 3) {
    variants.add([prefix, last.slice(0, -1)].filter(Boolean).join(' '));
  } else if (last.length > 2) {
    variants.add([prefix, `${last}s`].filter(Boolean).join(' '));
  }

  return [...variants];
}

function containsPhrase(text: string, phrase: string): boolean {
  if (!text || !phrase) return false;
  return ` ${text} `.includes(` ${phrase} `);
}

function explicitlyFreeOf(text: string, allergen: string): boolean {
  const haystack = ` ${text} `;
  return (
    haystack.includes(` ${allergen} free `) ||
    haystack.includes(` free of ${allergen} `) ||
    haystack.includes(` without ${allergen} `) ||
    haystack.includes(` no ${allergen} `)
  );
}

function firstContained(text: string, terms: string[]): string | undefined {
  return terms
    .flatMap(numberVariants)
    .find((term) => containsPhrase(text, term) && !explicitlyFreeOf(text, term));
}

function matchingAliasGroup(allergyVariants: string[]): AliasGroup | undefined {
  return ALIAS_GROUPS.find((group) =>
    group.terms.some((term) => numberVariants(term).some((variant) => allergyVariants.includes(variant)))
  );
}

function matchingCategoryRule(allergyVariants: string[]): CategoryRule | undefined {
  return CATEGORY_RULES.find((rule) =>
    rule.allergies.some((term) => numberVariants(term).some((variant) => allergyVariants.includes(variant)))
  );
}

export function validateRecipeAllergies(
  ingredients: RecipeIngredient[],
  configuredAllergies: string[]
): RecipeAllergyValidation {
  const matches: RecipeAllergyMatch[] = [];

  for (const ingredient of ingredients) {
    const normalizedIngredient = normalize(ingredient.name);
    if (!normalizedIngredient) continue;

    for (const rawAllergy of configuredAllergies) {
      const normalizedAllergy = normalizeAllergy(rawAllergy);
      if (!normalizedAllergy) continue;

      const allergyVariants = numberVariants(normalizedAllergy);
      if (allergyVariants.some((term) => explicitlyFreeOf(normalizedIngredient, term))) continue;

      const directTerm = firstContained(normalizedIngredient, allergyVariants);
      if (directTerm) {
        matches.push({
          allergy: rawAllergy,
          ingredient: ingredient.name,
          matchedTerm: directTerm,
          kind: 'direct'
        });
        continue;
      }

      const aliasGroup = matchingAliasGroup(allergyVariants);
      if (aliasGroup) {
        const aliasTerm = firstContained(normalizedIngredient, aliasGroup.terms);
        if (aliasTerm) {
          matches.push({
            allergy: rawAllergy,
            ingredient: ingredient.name,
            matchedTerm: aliasTerm,
            kind: 'alias'
          });
          continue;
        }
      }

      const categoryRule = matchingCategoryRule(allergyVariants);
      if (categoryRule) {
        const categoryTerm = firstContained(normalizedIngredient, categoryRule.ingredients);
        if (categoryTerm) {
          matches.push({
            allergy: rawAllergy,
            ingredient: ingredient.name,
            matchedTerm: categoryTerm,
            kind: categoryRule.kind
          });
        }
      }
    }
  }

  return { ok: matches.length === 0, matches };
}

export class RecipeAllergyError extends Error {
  readonly matches: RecipeAllergyMatch[];

  constructor(matches: RecipeAllergyMatch[]) {
    const summary = matches
      .map((match) => `${match.ingredient} ↔ ${match.allergy}`)
      .join(', ');
    super(`Recipe blocked by allergy validation: ${summary}`);
    this.name = 'RecipeAllergyError';
    this.matches = matches;
  }
}
