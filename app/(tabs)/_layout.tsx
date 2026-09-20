import { Text } from 'react-native';
import { Tabs } from 'expo-router';

const Icon = ({ symbol, color }: { symbol: string; color: string }) => <Text style={{ fontSize: 20, color }}>{symbol}</Text>;

export default function TabsLayout() {
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
      <Tabs.Screen name="recipes" options={{ title: 'Recipes', tabBarIcon: ({ color }) => <Icon symbol="📖" color={color} /> }} />
    </Tabs>
  );
}
