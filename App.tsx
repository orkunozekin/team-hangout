import React, {
  useCallback,
  useEffect,
  useState,
  useRef,
} from 'react';

import {
  ActivityIndicator,
  Linking,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';

import {
  NavigationContainer,
  createNavigationContainerRef,
} from '@react-navigation/native';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';

import {
  createBottomTabNavigator,
} from '@react-navigation/bottom-tabs';
import SidebarShell, { type SidebarItem } from './src/navigation/SidebarShell';

import {
  createNativeStackNavigator,
} from '@react-navigation/native-stack';

import {
  SafeAreaProvider,
} from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

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
import NotificationsScreen from './src/screens/NotificationsScreen';
import ConversationScreen from './src/screens/ConversationScreen';
import ConversationsScreen from './src/screens/ConversationsScreen';
import TeamsScreen from './src/screens/TeamsScreen';
import CalendarSubscriptionsScreen from './src/screens/CalendarSubscriptionsScreen';
import { Screen } from './src/components/ui';
import type { ConversationRoute } from './src/lib/conversationNavigation';

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
import { reconcileGameDayCacheAccount } from './src/lib/gameDayCache';
import { notificationDestination, notificationTargetFromData, notificationTargetFromUrl, PendingNotificationTarget } from './src/lib/notificationNavigation';
import { resolveNotificationTarget } from './src/firebase/notifications';
import { syncExistingPushPermission } from './src/lib/pushRegistration';

const navigationRef = createNavigationContainerRef<any>();
const pushProjectId = Constants.easConfig?.projectId ?? Constants.expoConfig?.extra?.eas?.projectId ?? process.env.EXPO_PUBLIC_EAS_PROJECT_ID ?? '';

export type AuthStackParamList = {
  Login: undefined;
  Register: undefined;
  ForgotPassword: undefined;
};

export type OnboardingStackParamList = {
  Household: undefined;
  Inbox: undefined;
  Conversations: undefined;
  Conversation: ConversationRoute;
  CreateTeam: undefined;
  JoinTeam: { code?: string } | undefined;
  AdminHome: undefined;
};

export type RootStackParamList = {
  MainTabs: undefined;
  EventDetail: { eventId: string };
  CreateEditEvent: { eventId?: string };
  Conversation: ConversationRoute;
  TeamDetail: { teamId: string; teamName: string; membership: TeamMember };
};

export type MainTabParamList = {
  Household: undefined;
  Schedule: undefined;
  Team: undefined;
  Conversations: undefined;
  CalendarSubscriptions: undefined;
  Inbox: undefined;
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
  notice,
}: {
  user: User;
  displayName: string;
  pendingInviteCode: string | null;
  appRole: AppRole;
  onJoined: () => void;
  notice?: string | null;
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
        {({ navigation }) => <HouseholdScreen user={user} onTeams={() => navigation.navigate('CreateTeam')} onInbox={() => navigation.navigate('Inbox')} onConversations={() => navigation.navigate('Conversations')} />}
      </OnboardingStack.Screen>
      <OnboardingStack.Screen name="Inbox" options={{ headerShown: true, title: 'Inbox' }}>
        {() => <NotificationsScreen userId={user.uid} pushProjectId={pushProjectId} notice={notice} />}
      </OnboardingStack.Screen>
      <OnboardingStack.Screen name="Conversations" options={{ headerShown: true, title: 'Conversations' }}>
        {({ navigation }) => <ConversationsScreen onOpen={(target) => navigation.navigate('Conversation', target)} />}
      </OnboardingStack.Screen>
      <OnboardingStack.Screen name="Conversation" options={{ headerShown: true, title: 'Conversation' }}>
        {({ route }) => <ConversationScreen orgId={route.params.orgId} scopeType={route.params.scopeType} scopeId={route.params.scopeId} />}
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

export const SIDEBAR_ITEMS: (SidebarItem & { key: keyof MainTabParamList; superAdminOnly?: boolean })[] = [
  { key: 'Household', label: 'Household', icon: 'home-outline' },
  { key: 'Schedule', label: 'Schedule', icon: 'calendar-outline' },
  { key: 'Team', label: 'Teams', icon: 'people-outline' },
  { key: 'Conversations', label: 'Conversations', icon: 'chatbubbles-outline' },
  { key: 'CalendarSubscriptions', label: 'Calendar subscriptions', icon: 'sync-outline' },
  { key: 'Inbox', label: 'Inbox', icon: 'notifications-outline' },
  { key: 'Admin', label: 'Admin', icon: 'shield-checkmark-outline', superAdminOnly: true },
  { key: 'Profile', label: 'Profile', icon: 'person-outline' },
];

export function MainTabs({
  user,
  team,
  membership,
  appRole,
  onTeamSelected,
  notice,
}: {
  user: User;
  team: Team;
  membership: TeamMember;
  appRole: AppRole;
  onTeamSelected: () => void;
  notice?: string | null;
}) {
  const isSuperAdmin = isSuperAdminRole(appRole);
  const items = SIDEBAR_ITEMS.filter(item => !item.superAdminOnly || isSuperAdmin);

  // The tab navigator keeps screen state and the existing route names; the sidebar replaces its tab bar.
  return (
    <Tab.Navigator
      tabBar={() => null}
      screenOptions={{ headerShown: false }}
      layout={({ state, navigation, children }) => {
        const activeKey = state.routes[state.index]?.name ?? 'Household';
        return (
          <SidebarShell
            items={items}
            activeKey={activeKey}
            title={items.find(item => item.key === activeKey)?.label ?? ''}
            onSelect={(key) => navigation.navigate(key as never)}
          >
            {children}
          </SidebarShell>
        );
      }}
    >
      <Tab.Screen name="Household">
        {({ navigation }) => <HouseholdScreen user={user} onTeams={() => navigation.navigate('Team')} showCalendarSubscriptions={false} />}
      </Tab.Screen>
      <Tab.Screen name="Schedule">
        {({ navigation }) => (
          <ScheduleScreen
            userId={user.uid}
            teamId={team.id}
            teamName={team.name}
            teamSchemaVersion={team.schemaVersion ?? 1}
            membership={membership}
            appRole={appRole}
            navigation={navigation as never}
          />
        )}
      </Tab.Screen>
      <Tab.Screen name="Team" options={{ title: 'Teams' }}>
        {({ navigation }) => (
          <TeamsScreen
            userId={user.uid}
            activeTeam={team}
            activeMembership={membership}
            appRole={appRole}
            onOpenTeam={(entry) => navigation.navigate('TeamDetail', { teamId: entry.team.id, teamName: entry.team.name, membership: entry.membership })}
          />
        )}
      </Tab.Screen>
      <Tab.Screen name="Conversations">
        {({ navigation }) => <ConversationsScreen activeTeam={team} onOpen={(target) => navigation.navigate('Conversation', target)} />}
      </Tab.Screen>
      <Tab.Screen name="CalendarSubscriptions" options={{ title: 'Calendar subscriptions' }}>
        {({ navigation }) => <Screen><ScrollView contentContainerStyle={styles.scroll}><CalendarSubscriptionsScreen key={user.uid} onBack={() => navigation.navigate('Household')} /></ScrollView></Screen>}
      </Tab.Screen>
      <Tab.Screen name="Inbox">{() => <NotificationsScreen userId={user.uid} pushProjectId={pushProjectId} notice={notice} />}</Tab.Screen>
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
  notice,
}: {
  user: User;
  team: Team;
  membership: TeamMember;
  appRole: AppRole;
  onTeamSelected: () => void;
  notice?: string | null;
}) {
  return (
    <RootStack.Navigator>
      <RootStack.Screen
        name="MainTabs"
        options={{ headerShown: false, title: 'Back' }}
      >
        {() => (
          <MainTabs
            user={user}
            team={team}
            membership={membership}
            appRole={appRole}
            onTeamSelected={onTeamSelected}
            notice={notice}
          />
        )}
      </RootStack.Screen>
      <RootStack.Screen
        name="EventDetail"
        options={{ title: 'Event', headerBackTitle: 'Back' }}
      >
        {({ navigation, route }) => (
          <EventDetailScreen
            userId={user.uid}
            cacheScope={team.id}
            membership={membership}
            appRole={appRole}
            navigation={navigation}
            route={route}
          />
        )}
      </RootStack.Screen>
      <RootStack.Screen name="TeamDetail" options={({ route }) => ({ title: route.params.teamName, headerBackTitle: 'Teams' })}>
        {({ route }) => <TeamScreen teamId={route.params.teamId} membership={route.params.membership} appRole={appRole} />}
      </RootStack.Screen>
      <RootStack.Screen name="Conversation" options={{ title: 'Conversation' }}>
        {({ route }) => <ConversationScreen orgId={route.params.orgId} scopeType={route.params.scopeType} scopeId={route.params.scopeId} />}
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

function StandardApp() {
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
  const [pendingNotification, setPendingNotification] = useState<PendingNotificationTarget | null>(null);
  const [notificationNotice, setNotificationNotice] = useState<string | null>(null);
  const previousUid = useRef<string | null>(null);
  const [teamVersion, setTeamVersion] = useState(0);

  useEffect(() => {
    let active = true;
    let transition = Promise.resolve();
    const unsubscribe = subscribeToAuthChanges((nextUser) => {
      const nextUid = nextUser?.uid ?? null;
      setAuthReady(false);
      transition = transition.catch(() => undefined).then(async () => {
        await reconcileGameDayCacheAccount(previousUid.current, nextUid);
        if (!active) return;
        if (previousUid.current && previousUid.current !== nextUid) setPendingInvitation(null);
        previousUid.current = nextUid;
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
      }).catch(() => {
        if (active) setAuthReady(false);
      });
    });
    return () => { active = false; unsubscribe(); };
  }, []);

  useEffect(() => {
    function applyUrl(url: string | null) {
      if (!url) return;
      const token = invitationTokenFromUrl(url);
      if (token) { setPendingInvitation(token); return; }
      const notification = notificationTargetFromUrl(url);
      if (notification) { setPendingNotification(notification); return; }
      const code = captureInviteCodeFromUrl(url);
      if (code) {
        setPendingInviteCode(code);
      }
    }

    Linking.getInitialURL().then(applyUrl);
    const sub = Linking.addEventListener('url', ({ url }) => applyUrl(url));
    return () => sub.remove();
  }, []);

  useEffect(() => {
    const applyResponse = (response: Notifications.NotificationResponse | null | undefined) => {
      const target = notificationTargetFromData(response?.notification.request.content.data);
      if (target) setPendingNotification(target);
    };
    applyResponse(Notifications.getLastNotificationResponse());
    const response = Notifications.addNotificationResponseReceivedListener(value => { applyResponse(value); Notifications.clearLastNotificationResponse(); });
    const received = Notifications.addNotificationReceivedListener(() => setNotificationNotice('A new update arrived. Open the inbox for current details.'));
    return () => { response.remove(); received.remove(); };
  }, []);

  useEffect(() => {
    if (!user || !pushProjectId) return;
    void syncExistingPushPermission(user.uid, pushProjectId).catch(() => undefined);
    const token = Notifications.addPushTokenListener(() => { void syncExistingPushPermission(user.uid, pushProjectId).catch(() => undefined); });
    return () => token.remove();
  }, [user]);

  const consumePendingNotification = useCallback(async () => {
    if (!user || !teamReady || !pendingNotification || !navigationRef.isReady()) return;
    const target = pendingNotification; setPendingNotification(null);
    try {
      const resolved = await resolveNotificationTarget(target.notificationId, target.sourceRevision);
      if (!resolved.available || !resolved.target) {
        setNotificationNotice('This update is no longer available for your account.');
        if (team && membership) navigationRef.navigate('MainTabs', { screen: 'Inbox' }); else navigationRef.navigate('Inbox');
        return;
      }
      setNotificationNotice(null);
      if (notificationDestination(team?.id ?? null, resolved.target.teamId) === 'event' && team && membership) navigationRef.navigate('EventDetail', { eventId: resolved.target.id });
      else {
        setNotificationNotice('Open the update from your household agenda. Your current team was not used as authority for this link.');
        if (team && membership) navigationRef.navigate('MainTabs', { screen: 'Household' }); else navigationRef.navigate('Household');
      }
      Notifications.clearLastNotificationResponse();
    } catch {
      setPendingNotification(target);
      setNotificationNotice('The linked update could not be opened. Check your connection and try again.');
    }
  }, [membership, pendingNotification, team, teamReady, user]);

  useEffect(() => { void consumePendingNotification(); }, [consumePendingNotification]);

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

  if (!authReady || (user && !teamReady)) {
    return (
      <View style={styles.boot}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  return (
    <SafeAreaProvider>
      <NavigationContainer ref={navigationRef} key={user?.uid || 'signed-out'} onReady={() => { void consumePendingNotification(); }}>
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
            notice={notificationNotice}
          />
        ) : (
          <AppNavigator
            user={user}
            team={team}
            membership={membership}
            appRole={appRole}
            onTeamSelected={() => setTeamVersion((v) => v + 1)}
            notice={notificationNotice}
          />
        )}
      </NavigationContainer>
    </SafeAreaProvider>
  );
}

export default function App() {
  const [fontsLoaded] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
  });
  if (!fontsLoaded) {
    return (
      <View style={styles.boot}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  return (
    <GestureHandlerRootView style={styles.gestureRoot}>
      <StandardApp />
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  gestureRoot: {
    flex: 1,
  },
  scroll: {
    paddingBottom: 32,
  },
  boot: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.background,
  },
});
