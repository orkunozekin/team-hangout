import React, {
  useEffect,
  useState,
} from 'react';

import {
  Alert,
  KeyboardAvoidingView,
  Linking,
  Platform,
  ScrollView,
  Text,
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
  loginWithGoogle,
  registerWithEmail,
} from '../api/auth';

import {
  ConsentCheckbox,
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
  getLegalUrls,
} from '../lib/legalUrls';

import {
  hasAuthErrors,
  validateRegisterForm,
} from '../lib/authForm';

import {
  colors,
  type,
} from '../theme/theme';

type AuthStackParamList = {
  Login: undefined;
  Register: undefined;
  ForgotPassword: undefined;
};

type Props = {
  navigation: NativeStackNavigationProp<AuthStackParamList, 'Register'>;
};

async function openUrl(url: string): Promise<void> {
  const canOpen = await Linking.canOpenURL(url);
  if (!canOpen) {
    Alert.alert('Could not open link', url);
    return;
  }
  await Linking.openURL(url);
}

export default function RegisterScreen({ navigation }: Props) {
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [errors, setErrors] = useState<{
    email?: string;
    password?: string;
    displayName?: string;
    consent?: string;
  }>({});
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [appleLoading, setAppleLoading] = useState(false);
  const [appleAvailable, setAppleAvailable] = useState(false);
  const legal = getLegalUrls();

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

  function requireConsent(): boolean {
    if (acceptedTerms) {
      return true;
    }
    setErrors((prev) => ({
      ...prev,
      consent: 'Please agree to the Terms and Privacy Policy to continue.',
    }));
    return false;
  }

  async function onSubmit() {
    const nextErrors = validateRegisterForm({
      email,
      password,
      displayName,
    });
    if (!acceptedTerms) {
      nextErrors.consent =
        'Please agree to the Terms and Privacy Policy to continue.';
    }
    setErrors(nextErrors);
    if (hasAuthErrors(nextErrors) || !acceptedTerms) {
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

  async function onGoogle() {
    if (!requireConsent()) {
      return;
    }
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
    if (!requireConsent()) {
      return;
    }
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

          <ConsentCheckbox
            checked={acceptedTerms}
            onToggle={() => {
              setAcceptedTerms((value) => !value);
              setErrors((prev) => ({ ...prev, consent: undefined }));
            }}
            error={errors.consent}
            label={
              <Text style={{ ...type.body, color: colors.textMuted }}>
                I agree to the{' '}
                {legal.terms ? (
                  <Text
                    style={{ ...type.bodyMedium, color: colors.primaryLight }}
                    onPress={() => {
                      void openUrl(legal.terms!);
                    }}
                  >
                    Terms of Service
                  </Text>
                ) : (
                  <Text style={{ ...type.bodyMedium, color: colors.text }}>
                    Terms of Service
                  </Text>
                )}
                {' '}and{' '}
                {legal.privacy ? (
                  <Text
                    style={{ ...type.bodyMedium, color: colors.primaryLight }}
                    onPress={() => {
                      void openUrl(legal.privacy!);
                    }}
                  >
                    Privacy Policy
                  </Text>
                ) : (
                  <Text style={{ ...type.bodyMedium, color: colors.text }}>
                    Privacy Policy
                  </Text>
                )}
                .
              </Text>
            }
          />

          <PrimaryButton
            label="Create account"
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
                  AppleAuthentication.AppleAuthenticationButtonType.SIGN_UP
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
            label="Already have an account? Sign in"
            onPress={() => navigation.navigate('Login')}
          />
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}
