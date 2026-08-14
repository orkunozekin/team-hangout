import React, {
  useCallback,
  useEffect,
  useState,
} from 'react';

import {
  ActivityIndicator,
  Linking,
  StyleSheet,
  View,
} from 'react-native';

import {
  NavigationContainer,
} from '@react-navigation/native';

import {
  createBottomTabNavigator,
} from '@react-navigation/bottom-tabs';

import {
  createNativeStackNavigator,
} from '@react-navigation/native-stack';

import {
  SafeAreaProvider,
} from 'react-native-safe-area-context';

import {
  User,
} from 'firebase/auth';

import {
  useFonts,
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
} from '@expo-google-fonts/inter';

import {
  Ionicons,
} from '@expo/vector-icons';

import LoginScreen from './src/screens/LoginScreen';
import RegisterScreen from './src/screens/RegisterScreen';
import ForgotPasswordScreen from './src/screens/ForgotPasswordScreen';
import CreateTeamScreen from './src/screens/CreateTeamScreen';
import JoinTeamScreen from './src/screens/JoinTeamScreen';
import ScheduleScreen from './src/screens/ScheduleScreen';
import TeamScreen from './src/screens/TeamScreen';
import ProfileScreen from './src/screens/ProfileScreen';
import EventDetailScreen from './src/screens/EventDetailScreen';
import CreateEditEventScreen from './src/screens/CreateEditEventScreen';

import {
  subscribeToAuthChanges,
} from './src/api/auth';

import {
  ensureUserDocument,
  getUserDocument,
} from './src/firebase/users';

import {
  resolveActiveMembership,
} from './src/firebase/teams';

import {
  Team,
  TeamMember,
} from './src/types/models';

import {
  captureInviteCodeFromUrl,
} from './src/lib/deepLink';

import {
  colors,
  fonts,
} from './src/theme/theme';

export type AuthStackParamList = {
  Login: undefined;
  Register: undefined;
  ForgotPassword: undefined;
};

export type OnboardingStackParamList = {
  CreateTeam: undefined;
  JoinTeam: { code?: string } | undefined;
};

export type RootStackParamList = {
  MainTabs: undefined;
  EventDetail: { eventId: string };
  CreateEditEvent: { eventId?: string };
};

export type MainTabParamList = {
  Schedule: undefined;
  Team: undefined;
  Profile: undefined;
};

const AuthStack = createNativeStackNavigator<AuthStackParamList>();
const OnboardingStack = createNativeStackNavigator<OnboardingStackParamList>();
const RootStack = createNativeStackNavigator<RootStackParamList>();
const Tab = createBottomTabNavigator<MainTabParamList>();

function AuthNavigator() {
  return (
    <AuthStack.Navigator screenOptions={{ headerShown: false }}>
      <AuthStack.Screen name="Login" component={LoginScreen} />
      <AuthStack.Screen name="Register" component={RegisterScreen} />
      <AuthStack.Screen
        name="ForgotPassword"
        component={ForgotPasswordScreen}
      />
    </AuthStack.Navigator>
  );
}

function OnboardingNavigator({
  user,
  displayName,
  pendingInviteCode,
  onJoined,
}: {
  user: User;
  displayName: string;
  pendingInviteCode: string | null;
  onJoined: () => void;
}) {
  return (
    <OnboardingStack.Navigator
      initialRouteName={pendingInviteCode ? 'JoinTeam' : 'CreateTeam'}
      screenOptions={{ headerShown: false }}
    >
      <OnboardingStack.Screen name="CreateTeam">
        {({ navigation }) => (
          <CreateTeamScreen
            user={user}
            displayName={displayName}
            onJoined={onJoined}
            onGoToJoin={() => navigation.navigate('JoinTeam')}
          />
        )}
      </OnboardingStack.Screen>
      <OnboardingStack.Screen name="JoinTeam">
        {({ navigation }) => (
          <JoinTeamScreen
            user={user}
            displayName={displayName}
            onJoined={onJoined}
            onGoToCreate={() => navigation.navigate('CreateTeam')}
            initialCode={pendingInviteCode ?? ''}
          />
        )}
      </OnboardingStack.Screen>
    </OnboardingStack.Navigator>
  );
}

function MainTabs({
  user,
  team,
  membership,
}: {
  user: User;
  team: Team;
  membership: TeamMember;
}) {
  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.textFaint,
        tabBarLabelStyle: {
          fontFamily: fonts.medium,
          fontSize: 12,
        },
        tabBarIcon: ({ color, size }) => {
          const iconName =
            route.name === 'Schedule'
              ? 'calendar'
              : route.name === 'Team'
                ? 'people'
                : 'person';
          return <Ionicons name={iconName} size={size} color={color} />;
        },
      })}
    >
      <Tab.Screen name="Schedule">
        {({ navigation }) => (
          <ScheduleScreen
            teamId={team.id}
            membership={membership}
            navigation={navigation as never}
          />
        )}
      </Tab.Screen>
      <Tab.Screen name="Team">
        {() => (
          <TeamScreen teamId={team.id} membership={membership} />
        )}
      </Tab.Screen>
      <Tab.Screen name="Profile">
        {() => (
          <ProfileScreen
            user={user}
            team={team}
            membership={membership}
          />
        )}
      </Tab.Screen>
    </Tab.Navigator>
  );
}

function AppNavigator({
  user,
  team,
  membership,
}: {
  user: User;
  team: Team;
  membership: TeamMember;
}) {
  return (
    <RootStack.Navigator>
      <RootStack.Screen
        name="MainTabs"
        options={{ headerShown: false }}
      >
        {() => (
          <MainTabs user={user} team={team} membership={membership} />
        )}
      </RootStack.Screen>
      <RootStack.Screen
        name="EventDetail"
        options={{ title: 'Event' }}
      >
        {({ navigation, route }) => (
          <EventDetailScreen
            membership={membership}
            navigation={navigation}
            route={route}
          />
        )}
      </RootStack.Screen>
      <RootStack.Screen
        name="CreateEditEvent"
        options={{ title: 'Event' }}
      >
        {({ navigation, route }) => (
          <CreateEditEventScreen
            teamId={team.id}
            membership={membership}
            navigation={navigation}
            route={route}
          />
        )}
      </RootStack.Screen>
    </RootStack.Navigator>
  );
}

export default function App() {
  const [fontsLoaded] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
  });

  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [teamReady, setTeamReady] = useState(false);
  const [team, setTeam] = useState<Team | null>(null);
  const [membership, setMembership] = useState<TeamMember | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [pendingInviteCode, setPendingInviteCode] = useState<string | null>(
    null,
  );
  const [teamVersion, setTeamVersion] = useState(0);

  useEffect(() => {
    const unsubscribe = subscribeToAuthChanges((nextUser) => {
      setUser(nextUser);
      setAuthReady(true);
      if (!nextUser) {
        setTeam(null);
        setMembership(null);
        setTeamReady(true);
      } else {
        setTeamReady(false);
      }
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    function applyUrl(url: string | null) {
      if (!url) return;
      const code = captureInviteCodeFromUrl(url);
      if (code) {
        setPendingInviteCode(code);
      }
    }

    Linking.getInitialURL().then(applyUrl);
    const sub = Linking.addEventListener('url', ({ url }) => applyUrl(url));
    return () => sub.remove();
  }, []);

  const refreshTeam = useCallback(async () => {
    if (!user) {
      setTeam(null);
      setMembership(null);
      setTeamReady(true);
      return;
    }

    setTeamReady(false);
    try {
      const profile = await ensureUserDocument(
        user.uid,
        user.email ?? '',
        user.displayName ?? user.email?.split('@')[0] ?? 'Player',
      );
      setDisplayName(profile.displayName || user.displayName || '');

      const resolved = await resolveActiveMembership(
        user.uid,
        profile.activeTeamId,
      );
      setTeam(resolved?.team ?? null);
      setMembership(resolved?.membership ?? null);
    } catch {
      const fallback = await getUserDocument(user.uid);
      setDisplayName(
        fallback?.displayName || user.displayName || '',
      );
      setTeam(null);
      setMembership(null);
    } finally {
      setTeamReady(true);
    }
  }, [user]);

  useEffect(() => {
    refreshTeam();
  }, [refreshTeam, teamVersion]);

  if (!fontsLoaded || !authReady || (user && !teamReady)) {
    return (
      <View style={styles.boot}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  return (
    <SafeAreaProvider>
      <NavigationContainer>
        {!user ? (
          <AuthNavigator />
        ) : !team || !membership ? (
          <OnboardingNavigator
            user={user}
            displayName={displayName}
            pendingInviteCode={pendingInviteCode}
            onJoined={() => setTeamVersion((v) => v + 1)}
          />
        ) : (
          <AppNavigator
            user={user}
            team={team}
            membership={membership}
          />
        )}
      </NavigationContainer>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  boot: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.background,
  },
});
