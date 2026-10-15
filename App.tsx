import React, {
  useCallback,
  useEffect,
  useState,
  useRef,
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

import InvitationScreen from './src/screens/InvitationScreen';
import { invitationTokenFromUrl } from './shared/invitations';
import HouseholdScreen from './src/screens/HouseholdScreen';
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
import AdminScreen from './src/screens/AdminScreen';

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
  isSuperAdminRole,
} from './src/lib/roles';

import {
  captureInviteCodeFromUrl,
} from './src/lib/deepLink';

import {
  AppRole,
  Team,
  TeamMember,
} from './src/types/models';

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
  Household: undefined;
  CreateTeam: undefined;
  JoinTeam: { code?: string } | undefined;
  AdminHome: undefined;
};

export type RootStackParamList = {
  MainTabs: undefined;
  EventDetail: { eventId: string };
  CreateEditEvent: { eventId?: string };
};

export type MainTabParamList = {
  Household: undefined;
  Schedule: undefined;
  Team: undefined;
  Admin: undefined;
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
  appRole,
  onJoined,
}: {
  user: User;
  displayName: string;
  pendingInviteCode: string | null;
  appRole: AppRole;
  onJoined: () => void;
}) {
  const isSuperAdmin = isSuperAdminRole(appRole);

  return (
    <OnboardingStack.Navigator
      initialRouteName={
        pendingInviteCode
          ? 'JoinTeam'
          : isSuperAdmin
            ? 'AdminHome'
            : 'Household'
      }
      screenOptions={{ headerShown: false }}
    >
      <OnboardingStack.Screen name="Household">
        {({ navigation }) => <HouseholdScreen user={user} onTeams={() => navigation.navigate('CreateTeam')} />}
      </OnboardingStack.Screen>
      <OnboardingStack.Screen name="CreateTeam" options={{ headerShown: true, title: 'Teams', headerBackTitle: 'Household' }}>
        {({ navigation }) => (
          <CreateTeamScreen
            user={user}
            displayName={displayName}
            onJoined={onJoined}
            onGoToJoin={() => navigation.navigate('JoinTeam')}
          />
        )}
      </OnboardingStack.Screen>
      <OnboardingStack.Screen name="JoinTeam" options={{ headerShown: true, title: 'Join team' }}>
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
      {isSuperAdmin ? (
        <OnboardingStack.Screen name="AdminHome">
          {({ navigation }) => (
            <AdminScreen
              user={user}
              activeTeamId={null}
              onTeamSelected={onJoined}
              onGoToOnboarding={() => navigation.navigate('CreateTeam')}
            />
          )}
        </OnboardingStack.Screen>
      ) : null}
    </OnboardingStack.Navigator>
  );
}

function MainTabs({
  user,
  team,
  membership,
  appRole,
  onTeamSelected,
}: {
  user: User;
  team: Team;
  membership: TeamMember;
  appRole: AppRole;
  onTeamSelected: () => void;
}) {
  const isSuperAdmin = isSuperAdminRole(appRole);

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
            route.name === 'Household'
              ? 'home'
              : route.name === 'Schedule'
              ? 'calendar'
              : route.name === 'Team'
                ? 'people'
                : route.name === 'Admin'
                  ? 'shield-checkmark'
                  : 'person';
          return <Ionicons name={iconName as never} size={size} color={color} />;
        },
      })}
    >
      <Tab.Screen name="Household">
        {({ navigation }) => <HouseholdScreen user={user} onTeams={() => navigation.navigate('Team')} />}
      </Tab.Screen>
      <Tab.Screen name="Schedule">
        {({ navigation }) => (
          <ScheduleScreen
            teamId={team.id}
            teamName={team.name}
            membership={membership}
            appRole={appRole}
            navigation={navigation as never}
          />
        )}
      </Tab.Screen>
      <Tab.Screen name="Team" options={{ title: 'Teams' }}>
        {() => (
          <TeamScreen
            teamId={team.id}
            membership={membership}
            appRole={appRole}
          />
        )}
      </Tab.Screen>
      {isSuperAdmin ? (
        <Tab.Screen name="Admin">
          {() => (
            <AdminScreen
              user={user}
              activeTeamId={team.id}
              onTeamSelected={onTeamSelected}
            />
          )}
        </Tab.Screen>
      ) : null}
      <Tab.Screen name="Profile">
        {() => (
          <ProfileScreen
            user={user}
            team={team}
            membership={membership}
            appRole={appRole}
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
  appRole,
  onTeamSelected,
}: {
  user: User;
  team: Team;
  membership: TeamMember;
  appRole: AppRole;
  onTeamSelected: () => void;
}) {
  return (
    <RootStack.Navigator>
      <RootStack.Screen
        name="MainTabs"
        options={{ headerShown: false }}
      >
        {() => (
          <MainTabs
            user={user}
            team={team}
            membership={membership}
            appRole={appRole}
            onTeamSelected={onTeamSelected}
          />
        )}
      </RootStack.Screen>
      <RootStack.Screen
        name="EventDetail"
        options={{ title: 'Event' }}
      >
        {({ navigation, route }) => (
          <EventDetailScreen
            membership={membership}
            appRole={appRole}
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
  const [appRole, setAppRole] = useState<AppRole>('user');
  const [pendingInviteCode, setPendingInviteCode] = useState<string | null>(
    null,
  );
  const [pendingInvitation, setPendingInvitation] = useState<string | null>(null);
  const previousUid = useRef<string | null>(null);
  const [teamVersion, setTeamVersion] = useState(0);

  useEffect(() => {
    const unsubscribe = subscribeToAuthChanges((nextUser) => {
      if (previousUid.current && previousUid.current !== nextUser?.uid) setPendingInvitation(null);
      previousUid.current = nextUser?.uid ?? null;
      setUser(nextUser);
      setAuthReady(true);
      if (!nextUser) {
        setTeam(null);
        setMembership(null);
        setAppRole('user');
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
      const token = invitationTokenFromUrl(url);
      if (token) { setPendingInvitation(token); return; }
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
      setAppRole('user');
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
      setAppRole(profile.appRole);

      const resolved = await resolveActiveMembership(
        user.uid,
        profile.activeTeamId,
        {
          isSuperAdmin: isSuperAdminRole(profile.appRole),
          displayName: profile.displayName,
        },
      );
      setTeam(resolved?.team ?? null);
      setMembership(resolved?.membership ?? null);
    } catch {
      const fallback = await getUserDocument(user.uid);
      setDisplayName(
        fallback?.displayName || user.displayName || '',
      );
      setAppRole(fallback?.appRole ?? 'user');
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
      <NavigationContainer key={user?.uid || 'signed-out'}>
        {user && pendingInvitation ? (
          <InvitationScreen key={`${user.uid}:${pendingInvitation}`} user={user} token={pendingInvitation} onClose={() => { setPendingInvitation(null); setTeamVersion(v => v + 1); }} />
        ) : !user ? (
          <AuthNavigator />
        ) : !team || !membership ? (
          <OnboardingNavigator
            user={user}
            displayName={displayName}
            pendingInviteCode={pendingInviteCode}
            appRole={appRole}
            onJoined={() => setTeamVersion((v) => v + 1)}
          />
        ) : (
          <AppNavigator
            user={user}
            team={team}
            membership={membership}
            appRole={appRole}
            onTeamSelected={() => setTeamVersion((v) => v + 1)}
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
