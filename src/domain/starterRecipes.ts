import type { Recipe } from './types';

export type StarterRecipe = {
  id: string;
  time: string;
  ingredientSummary: string;
  recipe: Omit<Recipe, 'id' | 'createdAt' | 'updatedAt'>;
};

// These are built-in ideas, not saved recipes or suggestions from a provider.
// Nothing is added to the user's kitchen until they explicitly save a copy.
export const starterRecipes: StarterRecipe[] = [
  {
    id: 'lemony-chickpea-toast',
    time: 'About 15 min',
    ingredientSummary: 'Chickpeas · bread · lemon',
    recipe: {
      title: 'Lemony chickpea toast',
      description: 'Warm, lightly mashed chickpeas with cumin and lemon, piled onto crisp toast.',
      portions: 2,
      ingredients: [
        { name: 'canned chickpeas', amount: '1 can' },
        { name: 'bread', amount: '4 slices' },
        { name: 'lemon', amount: '1/2' },
        { name: 'olive oil', amount: '1 tbsp' },
        { name: 'ground cumin', amount: '1/2 tsp' },
        { name: 'water', amount: '2 tbsp' },
        { name: 'salt', amount: 'to taste' }
      ],
      steps: [
        'Drain and rinse the chickpeas. Warm the olive oil in a frying pan over medium heat, add the cumin and stir for about 30 seconds.',
        'Add the chickpeas and water. Cook for 5–7 minutes, stirring, until hot throughout. Mash some of the chickpeas with a fork, adding another splash of water if the pan looks dry.',
        'Toast the bread. Squeeze the lemon over the chickpeas, season with salt and spoon onto the toast. Serve straight away.'
      ],
      notes: [
        'White beans also work well here. Try smoked paprika in place of cumin for a different direction.',
        'Add chopped parsley, a few tomato slices or a spoonful of crunchy seeds if you have them.'
      ]
    }
  },
  {
    id: 'tomato-white-bean-skillet',
    time: 'About 25 min',
    ingredientSummary: 'White beans · tomatoes · spinach',
    recipe: {
      title: 'Smoky tomato & white bean skillet',
      description: 'A simple pan of creamy beans, tomato and greens with a little smoky warmth.',
      portions: 2,
      ingredients: [
        { name: 'canned white beans', amount: '2 cans' },
        { name: 'canned chopped tomatoes', amount: '400 g' },
        { name: 'onion', amount: '1' },
        { name: 'spinach', amount: '100 g' },
        { name: 'olive oil', amount: '1 tbsp' },
        { name: 'smoked paprika', amount: '1 tsp' },
        { name: 'salt', amount: 'to taste' }
      ],
      steps: [
        'Peel and finely chop the onion. Drain and rinse the beans. Warm the olive oil in a large frying pan over medium heat.',
        'Add the onion and cook for about 6–8 minutes, stirring occasionally, until softened. Stir in the smoked paprika, then add the tomatoes and beans.',
        'Bring to a gentle simmer and cook for 10 minutes, stirring occasionally. Add a splash of water if the sauce becomes too thick.',
        'Stir in the spinach and cook until wilted and everything is hot. Season with salt and divide between bowls.'
      ],
      notes: [
        'Use chickpeas instead of white beans, or swap the spinach for chopped kale and simmer until tender.',
        'Serve with bread or a cooked grain when you want a more substantial meal.'
      ]
    }
  },
  {
    id: 'lemon-pea-pasta',
    time: 'About 20 min',
    ingredientSummary: 'Pasta · frozen peas · garlic',
    recipe: {
      title: 'Lemon & pea pasta',
      description: 'Sweet peas and garlicky olive oil turn a handful of everyday ingredients into a bright pasta supper.',
      portions: 2,
      ingredients: [
        { name: 'pasta', amount: '200 g' },
        { name: 'frozen peas', amount: '150 g' },
        { name: 'lemon', amount: '1/2' },
        { name: 'garlic', amount: '1 clove' },
        { name: 'olive oil', amount: '2 tbsp' },
        { name: 'salt', amount: 'to taste' }
      ],
      steps: [
        'Bring a saucepan of water to the boil, add salt and cook the pasta according to its packet instructions. Cook the peas in the same pan for at least the time stated on their packet, adding them near the end of the pasta cooking time.',
        'Meanwhile, peel and finely chop the garlic. Warm the olive oil in a wide pan over low heat and gently cook the garlic for about a minute, without letting it brown.',
        'Keep a mug of the pasta cooking water, then drain the pasta and peas. Add them to the garlic pan and toss with a splash of the reserved water until lightly coated.',
        'Squeeze in the lemon juice, taste and adjust the salt. Add a little more cooking water if needed, then serve.'
      ],
      notes: [
        'Try shredded spinach in place of peas, stirring it into the pasta pan until wilted.',
        'Finish with chopped mint, parsley or a pinch of chilli flakes if you have them.'
      ]
    }
  }
];

export function copyStarterRecipe(starter: StarterRecipe): StarterRecipe['recipe'] {
  return {
    ...starter.recipe,
    ingredients: starter.recipe.ingredients.map(ingredient => ({ ...ingredient })),
    steps: [...starter.recipe.steps],
    notes: starter.recipe.notes ? [...starter.recipe.notes] : undefined
  };
}
