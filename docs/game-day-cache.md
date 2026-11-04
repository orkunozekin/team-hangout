# Game-day read-only cache

P2.12 keeps a bounded last-known copy of safe household agenda, team schedule and event-detail fields for brief connectivity loss. The copy is an availability aid, not an authorization grant or an authoritative offline database.

## Stored data

- Keys are schema-versioned and separated by Firebase account plus organization or team scope.
- Household entries are partitioned by organization. Team schedules and event details are partitioned by team scope.
- The retained window is at most the previous 7 days through the next 30 days, with no server pagination cursor. The app refreshes on screen focus, foreground return and explicit reload.
- Stored fields are limited to event identity, revision, type, title, public schedule status/version, public time and timezone, public location, team labels and participant display labels already returned by the authorized agenda.
- Messages, attachments, private/staff notes, guardian contacts, raw location samples, attendance/RSVP records, audit history, callable cursors and management authority are never stored in this cache.

AsyncStorage is persistent but unencrypted. The cache therefore deliberately excludes the sensitive fields above. Data already downloaded to a device cannot be remotely erased while that device remains offline.

## Offline behavior

When an authorized live read fails for a non-permission reason, the app may show the matching account-scoped copy with its saved time and an explicit stale warning. A copy older than 24 hours receives an additional warning. Cached screens remove all management, response, check-in and attendance actions and state that no offline changes are queued.

Permission-denied, unauthenticated and agenda-version failures never fall back to cached data. They clear the account cache and show the live access-change state. A later successful live read replaces the relevant bounded snapshot and re-establishes live authority.

## Cleanup and writes

Explicit sign-out clears the current account cache before Firebase sign-out. Account deletion clears it before the deletion callable. Auth account changes and online access revocation also clear the prior account's cache. Cleanup failure blocks an explicit sign-out rather than leaving readable data behind under a signed-out UI.

P2.12 adds no offline mutation queue. Existing availability, check-in and attendance writers keep their request ID after an uncertain transport result, show the result as unconfirmed and require either the same retry or a live reload to reconcile. A cached snapshot is never updated optimistically from an unconfirmed write.

## Validation and rollout

Automated coverage includes forced-restart restoration, the 7/30-day bounds, schema/account/scope isolation, private-field stripping, stale age, malformed cache rejection, revoked-organization pruning, sign-out/deletion cleanup, cached read-only rendering, foreground refresh wiring and stable request-ID behavior for uncertain writes.

No production data, deployment or live flag change is part of P2.12. Native simulator evidence proves the stale/read-only presentation only. Physical-device storage behavior and Android remain rollout checks.
