# Team Hangout

White-label multi-tenant team schedule app. Coaches create a team, invite players with a shareable code, and publish practices and matches.

Built with **Expo 54**, **React Native**, **Firebase Auth**, and **Firestore**.

## Features (MVP)

- Email/password auth + Google Sign-In + Sign in with Apple (iOS)
- Create a team (you become coach) or join with an invite code
- Share / regenerate invite codes
- Schedule with practice & match events
- Filter: All / Practice / Match
- Sort by date and time
- Super admin role for app owners (cross-team access)
- In-app account deletion (Cloud Function)
- Privacy / Terms / Support links (env-configured)

## Setup

### Prerequisites

- Node 22+
- Yarn 1.x
- Xcode and/or Android Studio (Google Sign-In needs a **development build**, not Expo Go)
- A Firebase project (Auth email/password + Google, Firestore)

### Install

```bash
yarn install
cp .env.sample .env.local
```

Fill Firebase web config values and `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` in `.env.local`.

Optional App Store legal URLs (links appear in Profile / Register when set):

- `EXPO_PUBLIC_PRIVACY_URL`
- `EXPO_PUBLIC_TERMS_URL`
- `EXPO_PUBLIC_SUPPORT_URL`

The Web client ID is in Firebase Console → Project settings → Your apps → Web app, or Google Cloud Console → APIs & Services → Credentials → OAuth 2.0 Client IDs (type **Web client**).

### Firebase Google Sign-In

1. Authentication → Sign-in method → enable **Google**.
2. Register iOS and Android apps with package/bundle `com.orkunozekin.teamhangout`.
3. Android: add your debug **SHA-1** (see below).
4. Download `google-services.json` and `GoogleService-Info.plist` into the project root.
   - Re-download after enabling Google / adding SHA-1 so OAuth clients are present.
   - iOS plist should include `CLIENT_ID` and `REVERSED_CLIENT_ID`.

### Sign in with Apple (iOS)

1. Apple Developer → Identifiers → App ID `com.orkunozekin.teamhangout` → enable **Sign In with Apple**.
2. Firebase Console → Authentication → Sign-in method → enable **Apple** (Team ID, Key ID, `.p8` private key).
3. Rebuild the native app after config changes (`app.config.ts` sets `ios.usesAppleSignIn`).

See [`docs/APP_STORE_FITTING.md`](docs/APP_STORE_FITTING.md) for the full App Store checklist.

Debug SHA-1 (local Android builds):

```bash
keytool -list -v \
  -keystore ~/.android/debug.keystore \
  -alias androiddebugkey \
  -storepass android \
  -keypass android
```

### Firestore

1. Create Firestore in production (or test) mode.
2. Deploy rules from [`firestore.rules`](firestore.rules).
3. Create composite indexes from [`firestore.indexes.json`](firestore.indexes.json) (or let the console prompt you on first query).

### Account deletion (Cloud Function)

Requires a **Blaze** Firebase plan.

```bash
cd functions && yarn install && yarn build
# from repo root, with Firebase CLI logged in:
firebase deploy --only functions
```

The callable `deleteAccount` immediately denies account access and starts resumable cleanup of Auth, profile, grants and private projections. Teams, events, participant identities and other guardians remain. Deploy the scheduled retry worker and indexes before enabling households. See [account deletion](docs/account-deletion.md) for recent sign-in, recovery and cleanup contracts.

### Run (development build)

Google Sign-In will not work in Expo Go. Build and install a native development client once:

```bash
yarn ios
# or
yarn android
```

Day-to-day after that:

```bash
yarn start
```

Open the **Team Hangout** app on the simulator/device (not Expo Go). Rebuild only after changing native dependencies or `app.config.ts`.

EAS production builds set `APP_VARIANT=production` so `expo-dev-client` is omitted from the store binary.

### Tests

```bash
yarn typecheck
yarn test
yarn test:coverage
```

## Architecture notes

- Scoped reads go through the Firebase JS SDK; team/event mutations and account deletion use authenticated Callable Cloud Functions (`functions/`).
- Invite join resolves server-only `inviteCodes/{code}` lookup docs through a callable; clients cannot read or enumerate lookups.
- Deploy team/event commands before the restrictive rules cutover. See [`docs/backend-testing.md`](docs/backend-testing.md) for validation, event revisions, and old-client limitations.
- Google Sign-In uses `@react-native-google-signin/google-signin` and Firebase `signInWithCredential`.
- Sign in with Apple uses `expo-apple-authentication` and Firebase `OAuthProvider('apple.com')`.
- See [`QUESTIONS.md`](QUESTIONS.md) for product decisions and [`docs/APP_STORE_FITTING.md`](docs/APP_STORE_FITTING.md) for App Store readiness.

## Super admin

1. Register normally in the app.
2. In Firebase Console → Firestore → `users/{yourUid}`, set `appRole` to `superAdmin`.
3. Reload the app — an **Admin** tab appears and you can enter any team with coach-level powers.

## Deep link

Invite deep link scheme: `teamhangout://join?code=XXXXXXXX`

## Browser admin workspace

Phase 1 hierarchy and staff management lives in the isolated React/Vite `admin/` package. See [browser setup, emulator validation and staging Hosting](docs/browser-admin.md). `yarn test:admin` builds the production browser app and tests real Auth/callable flows against synthetic emulators. Browser dependencies are separate from the Expo application. Workspace rollout requires a server-owned organization flag; no deployment or live flag changes are performed by this repository setup.
