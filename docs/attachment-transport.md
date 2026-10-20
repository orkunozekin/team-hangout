# Attachment transport spike

P2.18 proves a quarantined upload and an authenticated download. It does not attach a file to a message. `features.attachments` stays off for every organization created by `createOrganization`, which still sets only `features.organizationV2`. Both `features.conversations` and `features.attachments` must be true before a file can be reserved, uploaded, finalized, or downloaded. The native picker and the admin file input stay hidden unless the channel page reports attachments enabled and the caller can post.

## Limits

JPEG, PNG, and PDF only. Each file is at most 10 MiB (`ATTACHMENT_MAX_BYTES`) and at least 1 byte. A caller can hold at most 3 active files (`pending`, `uploading`, `quarantined`, or `ready`) per conversation. The count lives on `organizations/{orgId}/attachmentSlots/{fingerprint}` so the check reads one slot and at most 3 attachment documents. Rejected rows drop out of the slot. Expired `pending` and `uploading` rows are marked rejected on the next reservation for that caller. Ready files keep their slot until a later step links or deletes them, so this spike's cap is per owner and conversation rather than per message.

Client MIME and the PUT `Content-Type` are ignored. The server accepts a file name ending in `jpg`, `jpeg`, `png`, or `pdf` and checks the bytes: JPEG starts with `FF D8 FF`, PNG starts with the 8-byte PNG signature, and PDF starts with `%PDF-`. HTML, SVG, XML, script, MZ, ELF, and a shebang are rejected as `UNSAFE_CONTENT` even when the name looks like a photo. A JPEG named as a PDF, or the reverse, is `SIGNATURE_MISMATCH`. A declared size above 10 MiB is `OVERSIZED` and creates no document. A body whose length differs from the reserved size is `SIZE_MISMATCH`, the reservation is rejected, and nothing is stored.

## Upload grant

`createAttachmentUpload` returns a 5-minute HMAC grant (`ATTACHMENT_EXPIRY_SECONDS` is 300). The token binds version, expiry, attachment id, owner, organization, reserved size, and object path. Replaying the same request id returns the original token and does not extend the expiry. The same request id with a different payload returns `REQUEST_ID_REUSED`.

The storage emulator cannot mint a GCS signed URL. The development substitute is the HTTP function `attachmentTransport`. In the emulator its URL is `http://127.0.0.1:5001/demo-team-hangout/us-central1/attachmentTransport`. Production uses `https://us-central1-${project}.cloudfunctions.net/attachmentTransport`. A PUT sends `Authorization: Attachment <token>`. The function writes `quarantine/{orgId}/{attachmentId}/1` in the Admin SDK default bucket from `FIREBASE_CONFIG.storageBucket`. Production is `team-hangout-ddf27.firebasestorage.app` and staging is `team-hangout-staging.firebasestorage.app`. The demo emulator configures `demo-team-hangout.appspot.com`. A missing bucket name fails closed. The code does not append `.appspot.com` to the project id. Storage rules deny every client read and write, including the public emulator media URL.

The grant is a bearer capability until it expires, and the PUT also rechecks that the owner can still post. If membership is gone before the bytes are accepted, the object is deleted and the row is `ACCESS_REVOKED`. An expired grant is `EXPIRED` and is not stored. CORS echoes an approved admin origin: the staging and production Hosting origins on `web.app` and `firebaseapp.com`. The emulator also allows `http://127.0.0.1` or `http://localhost` with a port. Other origins, including a wildcard, receive no CORS headers. Auth stays in the Authorization header, so the response does not send `Access-Control-Allow-Credentials`.

The demo emulator signs with the public value `demo-attachment-upload-key-v1-do-not-use-live` when `FUNCTIONS_EMULATOR` is `true` and `GCLOUD_PROJECT` is `demo-team-hangout`. Any other project requires Secret Manager `ATTACHMENT_UPLOAD_KEY` of at least 32 characters. A missing or short secret fails closed. Create that secret before deploying these functions.

## Quarantine and download

The object is `quarantined` after the PUT. It is not downloadable. `finalizeAttachment` reads the bytes, checks the hash, and runs `developmentScanner`. That fake scanner always returns `{ verdict: "clean" }` after the signature checks. A clean file becomes `ready` and stays in the slot. A rejected file deletes the object and leaves the slot. If that delete fails, finalize returns unavailable and the same request id retries the delete before returning the stored receipt. A later finalize of an already rejected row deletes the object again. A missing quarantine object becomes `INTEGRITY`. A timeout or other storage read error stays `unavailable` and does not write a receipt. The stored scan is `{ scanner: "fake", verdict }`. A throwing scanner becomes `SCAN_FAILED`. A scanner rejection becomes `SCAN_REJECTED`. Those two paths are covered by injecting a scanner in the pure tests. The deployed function always uses the fake scanner.

`GET attachmentTransport` requires `Authorization: Bearer <Firebase ID token>` plus `X-Org-Id`, `X-Scope-Type`, `X-Scope-Id`, and `X-Attachment-Id`. Every download rechecks the live conversation read. There is no saved download URL. The response `Content-Type` is the detected type, with `Cache-Control: private, no-store` and `X-Content-Type-Options: nosniff`. A guardian can download a staff file while youth posting is closed, because download uses read access. Direct messages are rejected with `YOUTH_POLICY`. A row whose `messageId` is not null is refused. This spike always stores `messageId: null`.

File bytes, the marker inside a fixture, and base64 of the bytes stay out of messages, `messageSearch`, staff notes, notifications, and the outbox. `postConversationMessage` rejects `attachmentIds`.

## Clients

Native `ConversationScreen` uses `expo-document-picker` with `copyToCacheDirectory: true`, the SDK 54 `File` size, and `expo/fetch` for the PUT and GET. The dev client must be rebuilt before a device can load those native modules. Admin web uses the same HTTP contract with `fetch` so the emulator can prove the bytes match. The picker itself was not opened on iOS or Android. That check is in `docs/phase-2-ui-qa-backlog.md`.

## What P2.19 owns

Replace `developmentScanner`, strip metadata, and stream the object instead of buffering it. Purge abandoned quarantine, rejected rows, and slot entries. The plan's abandoned window is 24 hours. Link at most 3 attachment ids onto a message, and stop treating `messageId != null` as undownloadable. A crash after the storage write and before the quarantine transaction can leave an object with no ready row. Account deletion removes command receipts, which hold the upload token for replay, and does not anonymize `ownerUid` on attachment documents.
