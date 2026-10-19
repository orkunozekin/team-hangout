# RSVP reminders and delivery diagnostics

P2.15 adds a server-owned reminder for unanswered or needs-reconfirmation participants, plus a staff diagnostics page that keeps provider failure separate from human acknowledgement.

Reminders are not phone timers. A scheduled worker prepares at most 25 soonest published events per run and dispatches at most 25 due reminder jobs. The default is one reminder 24 hours before the RSVP deadline. If the event or deadline appears with at least one hour and less than 24 hours remaining, the worker sends one immediate reminder. Nothing is sent during the final hour, after the deadline, or while the event is unpublished, cancelled, postponed, completed, or on a closed resource.

The reminder identity is the schedule version plus the deadline instant. Moving the deadline or rescheduling the event plans a new reminder. An already sent reminder is not recalled and does not count as the reminder for the new version. Repeated scheduler runs reuse the deterministic outbox id.

Recipients are deduplicated login accounts that can respond: the linked participant, or a guardian whose current grant includes `respond`. Yes, no, and maybe are responses. View-only guardians, coaches, and staff do not receive the reminder. Expansion checks the live roster and response again, so a response or revoked grant drops that recipient before inbox creation. The organization flag `features.rsvpReminders` must be true. Inbox, push, and email still follow their own flags.

Staff open Delivery diagnostics in the admin workspace. Delivery failures are permanent or unknown transport results, including `EMAIL_BOUNCED` and `DeviceNotRegistered`. Unacknowledged critical updates are a separate list. Reading an in-app notification does not acknowledge it, and a bounce does not either. The page does not show email addresses, push tokens, or recipient ids. Program staff see only their programs. Client reads and writes of reminder jobs, delivery issues, and critical projections stay denied.

Account deletion removes that person's delivery-issue and critical-update projections. Rollback is disabling `features.rsvpReminders`. Existing reminder history and idempotency records stay in place. Deploy the reminder and critical-update indexes before enabling the flag. This change does not enable the flag, send live email, or prove device delivery.
