# Team Hangout

White-label multi-tenant team schedule app. Coaches create a team, invite players with a shareable code, and publish practices and matches.

Built with **Expo 54**, **React Native**, **Firebase Auth**, and **Firestore**.

## Features (MVP)

- Email/password auth
- Create a team (you become coach) or join with an invite code
- Share / regenerate invite codes
- Schedule with practice & match events
- Filter: All / Practice / Match
- Sort by date and time

## Setup

### Prerequisites

- Node 20+
- Yarn 1.x
- Expo Go or iOS/Android simulator
- A Firebase project (Auth email/password + Firestore)

### Install

```bash
yarn install
cp .env.sample .env.local
```

Fill Firebase web config values in `.env.local`.

### Firestore

1. Create Firestore in production (or test) mode.
2. Deploy rules from [`firestore.rules`](firestore.rules).
3. Create composite indexes from [`firestore.indexes.json`](firestore.indexes.json) (or let the console prompt you on first query).

### Run

```bash
yarn start
# or
yarn ios
yarn android
```

### Tests

```bash
yarn typecheck
yarn test
yarn test:coverage
```

## Architecture notes

- Reads and writes go through the Firebase JS SDK (no separate API server for MVP).
- Invite join uses `inviteCodes/{code}` lookup docs so security rules can validate without collection scans.
- See [`QUESTIONS.md`](QUESTIONS.md) for product decisions made during scaffolding.

## Deep link

Invite deep link scheme: `teamhangout://join?code=XXXXXXXX`
