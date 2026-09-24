import { Text, type ColorValue } from 'react-native';
import { Tabs } from 'expo-router';
import { useAppTheme } from '@/theme/theme';

const Icon = ({ symbol, color }: { symbol: string; color: ColorValue }) => <Text style={{ fontSize: 20, color }}>{symbol}</Text>;

export default function TabsLayout() {
  const theme = useAppTheme();

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: theme.colors.text,
        tabBarInactiveTintColor: theme.colors.subdued,
        tabBarStyle: {
          borderTopColor: theme.colors.border,
          backgroundColor: theme.colors.surface
        }
      }}
    >
      <Tabs.Screen name="index" options={{ title: 'Pantry', tabBarIcon: ({ color }) => <Icon symbol="🥕" color={color} /> }} />
      <Tabs.Screen name="chef" options={{ title: 'Chef', tabBarIcon: ({ color }) => <Icon symbol="👨‍🍳" color={color} /> }} />
      <Tabs.Screen name="recipes" options={{ title: 'Recipes', tabBarIcon: ({ color }) => <Icon symbol="📖" color={color} /> }} />
    </Tabs>
  );
}
