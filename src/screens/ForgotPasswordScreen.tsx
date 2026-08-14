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
  resetPassword,
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
  validateForgotPasswordForm,
} from '../lib/authForm';

type AuthStackParamList = {
  Login: undefined;
  Register: undefined;
  ForgotPassword: undefined;
};

type Props = {
  navigation: NativeStackNavigationProp<AuthStackParamList, 'ForgotPassword'>;
};

export default function ForgotPasswordScreen({ navigation }: Props) {
  const [email, setEmail] = useState('');
  const [errors, setErrors] = useState<{ email?: string }>({});
  const [loading, setLoading] = useState(false);

  async function onSubmit() {
    const nextErrors = validateForgotPasswordForm(email);
    setErrors(nextErrors);
    if (hasAuthErrors(nextErrors)) {
      return;
    }

    setLoading(true);
    try {
      await resetPassword(email);
      Alert.alert(
        'Check your email',
        'If an account exists for that address, a reset link was sent.',
        [{ text: 'OK', onPress: () => navigation.navigate('Login') }],
      );
    } catch (error) {
      Alert.alert(
        'Reset failed',
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
        <ScrollView keyboardShouldPersistTaps="handled">
          <Title>Reset password</Title>
          <Subtitle>
            Enter your email and we will send a password reset link.
          </Subtitle>

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

          <PrimaryButton
            label="Send reset link"
            onPress={onSubmit}
            loading={loading}
          />

          <LinkButton
            label="Back to sign in"
            onPress={() => navigation.navigate('Login')}
          />
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}
