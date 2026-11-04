# App Store Fitting — Agent Reference

Living checklist for App Store Review readiness (Guidelines 4.8, 5.1.1, 5.1.2, 2.1).
**Agents: update this file whenever status or files change.**

## Goal

Ship Team Hangout in a state that can pass App Store review for an account-based team scheduling app with Google Sign-In and Firebase.

## Status

Refreshed 2026-11-03.

| Item | Guideline | Status | Notes |
|------|-----------|--------|-------|
| Sign in with Apple (client) | 4.8 | `blocked_on_human` | Client, UI and `usesAppleSignIn` entitlement done; needs App ID capability + Firebase Apple provider |
| In-app account deletion (UI + Function) | 5.1.1(v) | `blocked_on_human` | Source + Profile UI done; Blaze is on, but no functions are deployed on `team-hangout-ddf27` yet. Depends on the production Functions deploy (`docs/production-release-checklist.md`) |
| Privacy / Terms / Support links | 5.1.1(i) | `blocked_on_human` | Env-driven UI done; needs hosted URLs as EAS `production` env vars + ASC metadata |
| Register consent checkbox | 5.1.1 / 5.1.2 | `done` | Always required before email / Google / Apple on Register |
| Gate `expo-dev-client` plugin in production | 2.1 | `done` | `app.config.ts` + EAS `APP_VARIANT=production` |
| Store build + submit profiles | 2.1 | `done` | `eas.json` `production` (store, remote auto-increment build number) and `submit.production` |
| Push entitlement | 4.5.4 | `done` | `aps-environment` is `production` for store builds; needs APNs key in EAS credentials |
| Export compliance | | `done` | `ITSAppUsesNonExemptEncryption: false` |
| PrivacyInfo.xcprivacy | Required Reason APIs | `done` | `ios.privacyManifests` in `app.config.ts`; verified via local prebuild. Re-check after adding native modules |
| App Privacy nutrition labels | 5.1.2 | `blocked_on_human` | Suggested answers below; file in ASC |
| Age rating / COPPA | 1.3 / 5.1.4 | `blocked_on_human` | Not in Kids category; see notes below |
| UGC report/block | 1.2 | `done` | Report and block on conversation messages, staff report queue under Conversations › Safety; semantics in `docs/conversations.md` |
| Restrict team `get` inviteCode | Security | `deferred` | |
| Data export | GDPR nicety | `deferred` | |

Status values: `done` | `in_progress` | `blocked_on_human` | `deferred`

## Locked implementation defaults

- Legal URLs via `EXPO_PUBLIC_PRIVACY_URL`, `EXPO_PUBLIC_TERMS_URL`, `EXPO_PUBLIC_SUPPORT_URL`. Links render only when set.
- Account deletion: Firebase Callable `deleteAccount` deletes Auth user, `users/{uid}`, and `teamMembers` for that user. **Does not** delete teams/events created by the user (orphan coach content OK unless product changes this).
- Firestore client rules keep `users` `allow delete: if false`; Admin SDK performs deletes.
- SIWA: `expo-apple-authentication` + Firebase `OAuthProvider('apple.com')`; iOS only when available.
- Production builds: omit `expo-dev-client` when `APP_VARIANT=production`.

## Implementation inventory

| Area | Files |
|------|-------|
| Living plan | `docs/APP_STORE_FITTING.md` |
| Config | `app.config.ts` (replaces `app.json`), `.env.sample`, `eas.json` |
| Legal helper | `src/lib/legalUrls.ts` |
| Consent UI | `src/screens/RegisterScreen.tsx`, `src/components/ui.tsx` (`ConsentCheckbox`) |
| Profile legal + delete | `src/screens/ProfileScreen.tsx` |
| Apple auth | `src/api/auth.ts`, `LoginScreen.tsx`, `RegisterScreen.tsx` |
| Account delete client | `src/api/account.ts` |
| Cloud Function | `functions/src/index.ts`, `firebase.json` |
| Tests | `src/api/__tests__/auth-test.ts`, `src/api/__tests__/account-test.ts`, `src/lib/__tests__/legalUrls-test.ts` |

## Needs from you

| Item | Why |
|------|-----|
| Hosted Privacy Policy, Terms, Support URLs | Fill `EXPO_PUBLIC_*` env vars + App Store Connect metadata |
| Apple Developer: enable Sign in with Apple on App ID `com.orkunozekin.teamhangout` | Guideline 4.8 |
| Firebase Auth → enable Apple provider (Team ID, Key ID, `.p8` key) | SIWA token verification |
| Firebase Blaze + `firebase deploy --only functions` for `deleteAccount` | Guideline 5.1.1(v) cascade |
| App Store Connect: privacy nutrition labels, age rating, screenshots, review test account | Submission |
| Confirm orphan-team policy (coach deletes account → teams/events remain) | Product/legal |
| Optional: `.firebaserc` with your Firebase project id for CLI deploys | Functions deploy convenience |

### Suggested App Privacy nutrition labels (from code)

| Data | Collected | Linked to user | Used for tracking |
|------|-----------|----------------|-------------------|
| Email | Yes (Auth) | Yes | No |
| Name / display name | Yes | Yes | No |
| User ID (Firebase UID) | Yes | Yes | No |
| Crash / location / photos / IDFA | No | — | — |

| Phone number (participant profiles in Household) | Yes | Yes | No |
| Photos or videos (JPEG/PNG conversation attachments) | Yes | Yes | No |
| Precise location (optional one-shot check-in sample) | Yes | Yes | No |
| Device ID (push installation id in `notificationEndpoints`) | Yes | Yes | No |
| Other user content (messages, event notes, other attachments) | Yes | Yes | No |
| Contacts, health, financial, IDFA, crash data | No | — | — |

All collected types are for App Functionality only; no tracking, no third-party advertising. Disclose Google, Apple and Firebase (Google Cloud) as processors in the privacy policy.

Youth and guardian data: rosters can name minors (participants) managed by guardian accounts. In ASC, report participant names and household links under Name / Other user content, linked to the guardian's account. The privacy policy must state that minors do not create accounts, guardians control participant data, and how a guardian requests deletion.

### Age rating and COPPA notes

- Do not list in the Kids category; accounts are for adults (coaches, guardians). Answer the age rating questionnaire with no objectionable content; expect 4+ unless user-generated messaging pushes it to 12+ (Unrestricted web access: No; user-generated content: Yes once conversations ship).
- COPPA: the app should not knowingly collect personal data directly from children under 13. Keep sign-up adult-only and say so in Terms and in App Review notes.
- Provide App Review a demo coach account with seeded (non-real) data.

## TestFlight runbook

Steps marked **OWNER** need the owner's own accounts; agents never log in to Expo or Apple.

1. **OWNER** Finish Apple Developer Program enrollment. Enable Sign in with Apple and Push Notifications on App ID `com.orkunozekin.teamhangout`.
2. **OWNER** In App Store Connect, create the app record (bundle id `com.orkunozekin.teamhangout`, SKU of your choice). Note the numeric Apple ID (`ascAppId`).
3. **OWNER** Create an APNs auth key (.p8) and an App Store Connect API key. Keep both out of the repo (`*.p8` is git-ignored). Upload them with `eas credentials` or let `eas build` prompt.
4. **OWNER** `npx eas-cli login`, then `npx eas-cli init` to link the project; set `EXPO_PUBLIC_EAS_PROJECT_ID` to the returned id.
5. **OWNER** Add the `production` EAS environment variables (`eas env:create --environment production`): all `EXPO_PUBLIC_FIREBASE_*` values from the `team-hangout-ddf27` web app, `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID`, `EXPO_PUBLIC_EAS_PROJECT_ID` and the legal URLs. Never rely on `.env.local`; it is git-ignored and not uploaded, and it points at development.
6. **OWNER** Add `ascAppId` (the numeric Apple ID from step 2) to `submit.production.ios`; non-interactive submit requires it. Also give submit credentials: either assign the App Store Connect API key to Expo Submit in `eas credentials` (simplest), or add `ascApiKeyPath`, `ascApiKeyId`, `ascApiKeyIssuerId` and `appleTeamId` to `submit.production.ios` pointing at a local, git-ignored key. Never commit the `.p8`.
7. **OWNER** `npx eas-cli build --profile production --platform ios` (build number auto-increments remotely).
8. **OWNER** `npx eas-cli submit --profile production --platform ios --latest`, then add internal testers in TestFlight.
9. Before external testers or review: deploy production Functions (account deletion), host legal URLs, and file privacy labels.

Note: `expo-dev-client` remains a dependency, so it is still autolinked; only its config plugin is skipped. It is inert in release builds, but moving it behind a separate install would make the store binary smaller.

## Testing checklist

- [x] Register requires consent checkbox before email / Google / Apple
- [x] Profile opens Privacy / Terms / Support when env URLs set; hides when empty
- [ ] Delete account confirm → callable → signed out (needs deployed Function)
- [ ] SIWA button on iOS simulator/device when available (needs Apple + Firebase)
- [x] Production EAS profile sets `APP_VARIANT=production` (omits `expo-dev-client`)
- [x] `yarn test` and `yarn typecheck` pass
- [x] `functions` TypeScript build passes (`yarn build` in `functions/`)

## Changelog

| Date | Change |
|------|--------|
| 2026-08-26 | Created living plan; started `appstore-fitting` implementation |
| 2026-11-03 | Added store build/submit profiles, production push entitlement, privacy manifest, TestFlight runbook |
| 2026-08-26 | Shipped SIWA client, legal/consent UI, deleteAccount Function + Profile UI, `app.config.ts` gating |
