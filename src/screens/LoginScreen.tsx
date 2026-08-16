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
  getGoogleSignInErrorMessage,
  loginWithEmail,
  loginWithGoogle,
} from '../api/auth';

import {
  FieldLabel,
  LinkButton,
  PrimaryButton,
  Screen,
  SecondaryButton,
  Subtitle,
  TextField,
  Title,
} from '../components/ui';

import {
  hasAuthErrors,
  validateLoginForm,
} from '../lib/authForm';

type AuthStackParamList = {
  Login: undefined;
  Register: undefined;
  ForgotPassword: undefined;
};

type Props = {
  navigation: NativeStackNavigationProp<AuthStackParamList, 'Login'>;
};

export default function LoginScreen({ navigation }: Props) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<{ email?: string; password?: string }>({});
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);

  async function onSubmit() {
    const nextErrors = validateLoginForm({ email, password });
    setErrors(nextErrors);
    if (hasAuthErrors(nextErrors)) {
      return;
    }

    setLoading(true);
    try {
      await loginWithEmail(email, password);
    } catch (error) {
      Alert.alert(
        'Login failed',
        error instanceof Error ? error.message : 'Please try again',
      );
    } finally {
      setLoading(false);
    }
  }

  async function onGoogle() {
    setGoogleLoading(true);
    try {
      await loginWithGoogle();
    } catch (error) {
      Alert.alert(
        'Google Sign-In failed',
        getGoogleSignInErrorMessage(error),
      );
    } finally {
      setGoogleLoading(false);
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
          <Title>Team Hangout</Title>
          <Subtitle>Sign in to manage your team schedule.</Subtitle>

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
            placeholder="••••••••"
          />

          <PrimaryButton
            label="Sign in"
            onPress={onSubmit}
            loading={loading}
            disabled={googleLoading}
          />

          <SecondaryButton
            label="Continue with Google"
            onPress={onGoogle}
            loading={googleLoading}
            disabled={loading}
          />

          <LinkButton
            label="Create an account"
            onPress={() => navigation.navigate('Register')}
          />
          <LinkButton
            label="Forgot password?"
            onPress={() => navigation.navigate('ForgotPassword')}
          />
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}
