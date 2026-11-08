import { Stack } from 'expo-router';

export default function AuthLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: '#0b0d12' },
        headerTintColor: '#e8eaf0',
        headerShown: false,
      }}
    />
  );
}
