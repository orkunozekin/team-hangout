import React, {
  useEffect,
  useState,
} from 'react';

import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  View,
} from 'react-native';

import * as AppleAuthentication from 'expo-apple-authentication';

import {
  NativeStackNavigationProp,
} from '@react-navigation/native-stack';

import {
  getAppleSignInErrorMessage,
  getGoogleSignInErrorMessage,
  isAppleSignInAvailable,
  loginWithApple,
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
  const [appleLoading, setAppleLoading] = useState(false);
  const [appleAvailable, setAppleAvailable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void isAppleSignInAvailable().then((available) => {
      if (!cancelled) {
        setAppleAvailable(available);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

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

  async function onApple() {
    setAppleLoading(true);
    try {
      await loginWithApple();
    } catch (error) {
      Alert.alert(
        'Apple Sign-In failed',
        getAppleSignInErrorMessage(error),
      );
    } finally {
      setAppleLoading(false);
    }
  }

  const busy = loading || googleLoading || appleLoading;

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
            disabled={googleLoading || appleLoading}
          />

          <SecondaryButton
            label="Continue with Google"
            onPress={onGoogle}
            loading={googleLoading}
            disabled={busy && !googleLoading}
          />

          {appleAvailable ? (
            <View style={{ marginTop: 8 }}>
              <AppleAuthentication.AppleAuthenticationButton
                buttonType={
                  AppleAuthentication.AppleAuthenticationButtonType.SIGN_IN
                }
                buttonStyle={
                  AppleAuthentication.AppleAuthenticationButtonStyle.BLACK
                }
                cornerRadius={14}
                style={{ width: '100%', height: 48 }}
                onPress={() => {
                  if (!busy) {
                    void onApple();
                  }
                }}
              />
            </View>
          ) : null}

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
