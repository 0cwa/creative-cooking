import { Text, type ColorValue } from 'react-native';
import { Tabs } from 'expo-router';
import { useAppState } from '@/state/AppState';

const Icon = ({ symbol, color }: { symbol: string; color: ColorValue }) => <Text style={{ fontSize: 20, color }}>{symbol}</Text>;

export default function TabsLayout() {
  const { shoppingList } = useAppState();
  const shoppingCount = shoppingList.filter((item) => !item.checked).length;

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: '#172033',
        tabBarInactiveTintColor: '#94a3b8',
        tabBarStyle: { borderTopColor: '#e2e8f0', backgroundColor: '#ffffff' }
      }}
    >
      <Tabs.Screen name="index" options={{ title: 'Pantry', tabBarIcon: ({ color }) => <Icon symbol="🥕" color={color} /> }} />
      <Tabs.Screen name="chef" options={{ title: 'Chef', tabBarIcon: ({ color }) => <Icon symbol="👨‍🍳" color={color} /> }} />
      <Tabs.Screen
        name="shopping"
        options={{
          title: 'Shop',
          tabBarIcon: ({ color }) => <Icon symbol="🛒" color={color} />,
          tabBarBadge: shoppingCount || undefined
        }}
      />
      <Tabs.Screen name="recipes" options={{ title: 'Recipes', tabBarIcon: ({ color }) => <Icon symbol="📖" color={color} /> }} />
    </Tabs>
  );
}
