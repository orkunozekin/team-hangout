# App Store Fitting — Agent Reference

Living checklist for App Store Review readiness (Guidelines 4.8, 5.1.1, 5.1.2, 2.1).
**Agents: update this file whenever status or files change.**

## Goal

Ship Team Hangout in a state that can pass App Store review for an account-based team scheduling app with Google Sign-In and Firebase.

## Status

| Item | Guideline | Status | Notes |
|------|-----------|--------|-------|
| Sign in with Apple (client) | 4.8 | `blocked_on_human` | Client + UI done; needs Apple Developer + Firebase Apple provider |
| In-app account deletion (UI + Function) | 5.1.1(v) | `blocked_on_human` | Source + Profile UI done; needs Blaze + `firebase deploy --only functions` |
| Privacy / Terms / Support links | 5.1.1(i) | `blocked_on_human` | Env-driven UI done; needs hosted URLs in `.env.local` + ASC |
| Register consent checkbox | 5.1.1 / 5.1.2 | `done` | Always required before email / Google / Apple on Register |
| Gate `expo-dev-client` in production | 2.1 | `done` | `app.config.ts` + EAS `APP_VARIANT=production` |
| App Privacy nutrition labels | 5.1.2 | `blocked_on_human` | Suggested answers below; file in ASC |
| PrivacyInfo.xcprivacy verify | Required Reason APIs | `deferred` | After `expo prebuild` |
| Age gate / COPPA | 1.3 / 5.1.4 | `deferred` | Document ASC age rating only |
| UGC report/block | 1.2 | `deferred` | Display names + event notes only |
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

Disclose Google (and Apple once enabled) as auth processors in the privacy policy.

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
| 2026-08-26 | Shipped SIWA client, legal/consent UI, deleteAccount Function + Profile UI, `app.config.ts` gating |
