# Notification inbox and fake outbox worker

P2.13 adds a server-owned notification inbox and a development-only fake delivery worker. It does not install `expo-notifications`, register devices, send push or email, poll receipts, or handle notification deep links. Those remain P2.14.

Canonical mutations keep writing deterministic organization outbox intents. The worker expands each intent once into one safe in-app notification and one fake-channel delivery per currently authorized user. Audience discovery is bounded to 20 teams, 50 total active roster entries, 10 active guardians per participant, 100 staff or team grants, 50 access sources per recipient, and 200 unique recipients so the atomic expansion remains below Firestore's 500-write limit. Repeated or unordered expansion uses deterministic document IDs and one Firestore transaction, so it cannot create duplicate visible notifications.

The development worker runs only when the organization has the server-owned `notificationInboxFake` feature set to `true`. Each delivery has a one-minute lease and at most five attempts. Retryable fake-provider failures use exponential backoff with deterministic jitter. An expired send lease or ambiguous provider result becomes `unknownOutcome` and is not blindly retried. Provider acceptance is transport evidence only. It never marks a notification read or acknowledged.

Live access is checked immediately before fake dispatch and again whenever the inbox is read or changed. Current organization staff, team coach/captain, self participant, or guardian schedule access must still match the captured audience source. Revocation permanently fails the queued delivery and removes the in-app projection. Navigation state, platform support roles, stale pointers, and old roster membership grant nothing.

Opening an in-app row records `readAt`. Critical updates require a separate explicit acknowledgment bound to that notification's source revision; acknowledging an old notification cannot acknowledge a newer revision. Inbox data is self-only behind callables, client Firestore access remains denied, and account deletion removes both personal inbox rows and owned delivery records.

Before rollout, deploy the callable functions, scheduled fake worker, and delivery indexes together. Keep the feature disabled outside synthetic development organizations. Rollback disables `notificationInboxFake` and preserves existing canonical outbox and notification history for repair. No production data, deployment, provider credentials, or live feature changes are part of P2.13.
