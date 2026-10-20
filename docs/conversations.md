# Conversations and staff notes

`features.conversations` gates every channel. Organization and division channels are staff-authored announcements. Team channels, and published event channels, are youth group channels for the current roster household, coaches, and staff. Direct messages are rejected.

Guardians and linked participants can read a youth channel before the organization approves youth posting. They can post only when `policies.youthChannels` is `approved`. Staff and coaches can post and pin before that approval. A channel keeps at most three pins. Program staff and org admins can tombstone a message, which removes its text from later reads.

Staff notes are stored at `organizations/{orgId}/staffNotes/{scopeType}_{scopeId}/entries/{noteId}`. They are not messages, notifications, or outbox rows. Coaches and households cannot read them.

Clients cannot read or write conversation or staff-note documents. Account deletion does not yet anonymize message authors; that remains a later retention step.

A guardian grant counts only when its document path is the participant's guardian record in that organization and the participant is still active. Organization announcement reads scan the caller's bounded guardian grants and keep a schedule grant even when another profile-only grant is also active. Message and staff-note lists return a cursor; the native screen and admin page can load the next page.

Native navigation opens the same household channel. A household calendar with a participant on the team offers that organization's announcements, the division announcements, the team channel, and each loaded event channel. A coach-only calendar team offers the team channel. The team tab offers the team channel when the live team read includes its organization. Event detail offers the published event channel. Offline copies hide these actions. A denied read shows an unavailable conversation and does not reveal staff notes. Search, edits, reactions, and attachments remain later steps.
