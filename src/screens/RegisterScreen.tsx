import React, {
  useState,
} from 'react';

import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
} from 'react-native';

import {
  NativeStackNavigationProp,
} from '@react-navigation/native-stack';

import {
  registerWithEmail,
} from '../api/auth';

import {
  FieldLabel,
  LinkButton,
  PrimaryButton,
  Screen,
  Subtitle,
  TextField,
  Title,
} from '../components/ui';

import {
  hasAuthErrors,
  validateRegisterForm,
} from '../lib/authForm';

type AuthStackParamList = {
  Login: undefined;
  Register: undefined;
  ForgotPassword: undefined;
};

type Props = {
  navigation: NativeStackNavigationProp<AuthStackParamList, 'Register'>;
};

export default function RegisterScreen({ navigation }: Props) {
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<{
    email?: string;
    password?: string;
    displayName?: string;
  }>({});
  const [loading, setLoading] = useState(false);

  async function onSubmit() {
    const nextErrors = validateRegisterForm({
      email,
      password,
      displayName,
    });
    setErrors(nextErrors);
    if (hasAuthErrors(nextErrors)) {
      return;
    }

    setLoading(true);
    try {
      await registerWithEmail(email, password, displayName);
    } catch (error) {
      Alert.alert(
        'Registration failed',
        error instanceof Error ? error.message : 'Please try again',
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <Screen>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1 }}
      >
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingBottom: 40 }}
        >
          <Title>Create account</Title>
          <Subtitle>Start a team or join one with an invite code.</Subtitle>

          <FieldLabel>Display name</FieldLabel>
          <TextField
            value={displayName}
            onChangeText={setDisplayName}
            error={errors.displayName}
            placeholder="Alex Coach"
          />

          <FieldLabel>Email</FieldLabel>
          <TextField
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            value={email}
            onChangeText={setEmail}
            error={errors.email}
            placeholder="you@email.com"
          />

          <FieldLabel>Password</FieldLabel>
          <TextField
            secureTextEntry
            value={password}
            onChangeText={setPassword}
            error={errors.password}
            placeholder="At least 6 characters"
          />

          <PrimaryButton
            label="Create account"
            onPress={onSubmit}
            loading={loading}
          />

          <LinkButton
            label="Already have an account? Sign in"
            onPress={() => navigation.navigate('Login')}
          />
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}
