# Push, email fallback and notification links

P2.14 extends the P2.13 authoritative in-app inbox with optional Expo push delivery, provider receipts, essential-email fallback and allowlisted notification links. In-app `readAt` and revision-bound `acknowledgedAt` remain human actions. A push ticket or successful receipt is provider handoff evidence only.

## Native token lifecycle

The SDK 54 `expo-notifications` plugin is configured without background remote notifications. The Inbox explains that in-app state is authoritative and asks for push permission only after the user selects **Enable push updates**. Android creates the `team-updates` channel before requesting permission. Passive sign-in synchronization records existing granted, denied or undetermined state without prompting.

Each installation keeps a random stable identifier in AsyncStorage and registers through the authenticated `registerPushDevice` callable. The server validates Expo tokens, keeps endpoints server-only and revokes another account's endpoint when the same installation token moves between accounts. Expo native token-change events cause a fresh Expo token lookup. Normal logout revokes the endpoint before Firebase sign-out; account deletion also removes endpoint records. A missing `EXPO_PUBLIC_EAS_PROJECT_ID` leaves push visibly unavailable and does not guess a project.

## Server delivery

Organization flags are independent and default off:

- `notificationInboxFake` retains the synthetic P2.13 adapter.
- `notificationPush` permits push fan-out to current granted endpoints.
- `notificationEmailFallback` permits essential email when no push endpoint exists or a push permanently fails.

External delivery also requires runtime gates. `PUSH_DELIVERY_ENABLED=true` enables the Expo Push API adapter. Optional `EXPO_PUSH_ACCESS_TOKEN` supports Expo enhanced push security. Email requires `NOTIFICATION_EMAIL_ENABLED=true` plus the existing verified essential-email sender configuration, policy approval and `ESSENTIAL_EMAIL_API_KEY`. No flag, environment variable, secret, sender or credential is enabled by this change.

Actual-provider expansion is capped at 100 recipients, five endpoints per user, 200 endpoints total and 450 combined notification/delivery writes. Oversized fan-out fails explicitly instead of truncating. Delivery IDs include channel and installation, so unordered expansion remains deterministic. Immediately before a send, the worker rechecks live audience authority, organization flag, current endpoint/token or email preference, account state and verified current auth email. Tokens and email addresses are never logged.

Expo tickets enter `providerAccepted`. A bounded receipt poll records `providerReceiptOk`, retryable receipt state, permanent failure or `unknownOutcome` after five inconclusive polls. `DeviceNotRegistered` revokes that endpoint and queues one deterministic email fallback when eligible. Provider timeouts and expired send leases remain ambiguous and are never blindly resent. Channel status is retained separately so a later channel failure cannot overwrite an already successful handoff summary.

## Notification links

Push and fallback email carry only `teamhangout://notification?id=<notificationId>&revision=<sourceRevision>`. Arbitrary URLs and malformed identifiers are rejected. Foreground response listeners and the last cold-start response preserve this target while signed out. After authentication, `resolveNotificationTarget` rechecks the caller's live access and source revision before navigation. Removed access opens the Inbox with an unavailable message instead of revealing the target. Users without a team membership return to the household Inbox and current agenda rather than receiving team authority from navigation state.

## Evidence and rollout gates

Automated tests cover denied permission without a repeat prompt, Android channel ordering, stable installation identity, logout/account-switch revocation, target parsing, live access after sign-in, deterministic push/email fan-out, ticket/receipt classification, invalid-token retirement and fallback. Synthetic emulator adapters do not prove remote provider delivery.

Before any pilot, rebuild development/store binaries, configure an EAS project and APNs/FCM credentials, verify the email sender and authenticated failure callbacks, deploy the receipt index, and test provider delivery plus receipts on physical iOS and Android devices. Simulator payload injection is useful only for foreground/background/cold-start navigation and must not be reported as provider delivery. Rollback disables the organization flags and runtime gates while retaining the in-app inbox and delivery history for repair.
