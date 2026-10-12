import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const require = createRequire(
  new URL("../functions/package.json", import.meta.url),
);
const { initializeApp, deleteApp } = require("firebase-admin/app");
const { getFirestore, Timestamp } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");
export const householdOrg = "household-ui-demo";
export const demoPassword = "SyntheticPassword123!";
export async function seedHouseholdDemo() {
  if (
    process.env.GCLOUD_PROJECT !== "demo-team-hangout" ||
    process.env.FIRESTORE_EMULATOR_HOST !== "127.0.0.1:8080" ||
    process.env.FIREBASE_AUTH_EMULATOR_HOST !== "127.0.0.1:9099"
  )
    throw new Error(
      "Synthetic demo requires explicit loopback emulators and demo-team-hangout.",
    );
  const app = initializeApp(
    { projectId: "demo-team-hangout" },
    `household-seed-${Date.now()}`,
  );
  const db = getFirestore(app);
  const auth = getAuth(app);
  const meta = {
    schemaVersion: 2,
    revision: 1,
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
    createdBy: "ui-admin",
    updatedBy: "ui-admin",
  };
  try {
    for (const [uid, displayName] of [
      ["ui-admin", "Morgan Admin"],
      ["ui-staff", "Taylor Staff"],
      ["ui-parent", "Alex Rivera"],
      ["ui-guardian", "Sam Rivera"],
      ["ui-outsider", "Unrelated Adult"],
    ]) {
      try {
        await auth.createUser({
          uid,
          email: `${uid}@example.test`,
          displayName,
          password: demoPassword,
        });
      } catch (e) {
        if (e.code !== "auth/uid-already-exists") throw e;
      }
      await db
        .doc(`users/${uid}`)
        .set({
          uid,
          email: `${uid}@example.test`,
          displayName,
          appRole: "user",
          activeTeamId: uid === "ui-parent" ? "ui-legacy-team" : null,
        });
    }
    const org = `organizations/${householdOrg}`;
    await db
      .doc(org)
      .set({
        ...meta,
        name: "Cedar Park Youth Club",
        kind: "club",
        timeZone: "America/Chicago",
        status: "active",
        features: {
          organizationV2: true,
          adminWorkspace: true,
          households: true,
          guardianProfileEditing: true,
        },
      });
    for (const [uid, roles, programIds] of [
      ["ui-admin", ["orgAdmin"], []],
      ["ui-staff", ["programStaff"], ["soccer"]],
    ]) {
      await db
        .doc(`${org}/members/${uid}`)
        .set({
          ...meta,
          orgId: householdOrg,
          roles,
          programIds,
          status: "active",
        });
      await db
        .doc(`users/${uid}/organizationLinks/${householdOrg}`)
        .set({ orgId: householdOrg, status: "active" });
    }
    await db
      .doc(`${org}/programs/soccer`)
      .set({
        ...meta,
        orgId: householdOrg,
        name: "Youth soccer",
        sportCode: "soccer",
        status: "active",
      });
    await db
      .doc(`${org}/seasons/fall`)
      .set({
        ...meta,
        orgId: householdOrg,
        programId: "soccer",
        name: "Fall 2026",
        startsOn: "2026-09-01",
        endsOn: "2026-12-01",
        status: "active",
      });
    await db
      .doc(`${org}/divisions/u12`)
      .set({
        ...meta,
        orgId: householdOrg,
        programId: "soccer",
        seasonId: "fall",
        name: "Under 12",
        status: "active",
      });
    await db
      .doc("teams/ui-team")
      .set({
        ...meta,
        orgId: householdOrg,
        programId: "soccer",
        seasonId: "fall",
        divisionId: "u12",
        name: "Cedar Foxes",
        status: "active",
      });
    await db
      .doc("teams/ui-empty-team")
      .set({
        ...meta,
        orgId: householdOrg,
        programId: "soccer",
        seasonId: "fall",
        divisionId: "u12",
        name: "Cedar Owls",
        status: "active",
      });
    await db
      .doc("teams/ui-legacy-team")
      .set({
        name: "Rivera Coaching Team",
        createdBy: "ui-parent",
        createdAt: Timestamp.now(),
        inviteCode: "UIDEMO22",
      });
    await db
      .doc("teamMembers/ui-legacy-team_ui-parent")
      .set({
        teamId: "ui-legacy-team",
        userId: "ui-parent",
        role: "coach",
        displayName: "Alex Rivera",
        joinedAt: Timestamp.now(),
      });
    await db
      .doc("teamMembers/ui-team_ui-parent")
      .set({
        ...meta,
        orgId: householdOrg,
        teamId: "ui-team",
        userId: "ui-parent",
        roles: ["coach"],
        status: "active",
      });
    for (const [id, displayName, jerseyNumber] of [
      ["child-a", "Jamie Rivera", "7"],
      ["child-b", "Casey Rivera", "12"],
    ]) {
      await db
        .doc(`${org}/participants/${id}`)
        .set({
          ...meta,
          orgId: householdOrg,
          displayName,
          kind: "youth",
          status: "active",
          linkedUserId: null,
          accessRevision: 1,
        });
      await db
        .doc(`${org}/participants/${id}/private/profile`)
        .set({
          ...meta,
          birthDate: id === "child-a" ? "2016-02-29" : "2017-06-15",
          contactEmail: null,
          contactPhone: "555-0100",
          guardianContactDetails: "Private guardian contact",
          operationalNotes: "STAFF PRIVATE DEMO NOTE",
        });
      await db
        .doc(`teams/ui-team/roster/${id}`)
        .set({
          ...meta,
          orgId: householdOrg,
          participantId: id,
          status: "active",
          jerseyNumber,
        });
      for (const uid of ["ui-parent", "ui-guardian"]) {
        await db
          .doc(`${org}/participants/${id}/guardians/${uid}`)
          .set({
            ...meta,
            orgId: householdOrg,
            participantId: id,
            userId: uid,
            status: "active",
            permissions: {
              viewSchedule: true,
              viewProfile: true,
              editProfile: id === "child-a",
              respond: false,
            },
          });
        await db
          .doc(`users/${uid}/participantLinks/${householdOrg}_${id}`)
          .set({
            orgId: householdOrg,
            participantId: id,
            status: "active",
            relationship: "guardian",
          });
      }
    }
    return { orgId: householdOrg };
  } finally {
    await deleteApp(app);
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await seedHouseholdDemo();
  console.log(
    "Seeded synthetic household demo. ui-parent@example.test / SyntheticPassword123!",
  );
}
