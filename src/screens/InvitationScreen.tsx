import React, { useEffect, useRef, useState } from "react";
import { ScrollView, Text } from "react-native";
import { sendEmailVerification, User } from "firebase/auth";
import { httpsCallable } from "firebase/functions";
import { auth, functions } from "../firebase/config";
import {
  Screen,
  Title,
  Subtitle,
  PrimaryButton,
  SecondaryButton,
} from "../components/ui";
import { InvitationView, invitationMessage } from "../../shared/invitations";

export default function InvitationScreen({
  user,
  token,
  onClose,
}: {
  user: User;
  token: string;
  onClose: () => void;
}) {
  const [view, setView] = useState<InvitationView | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const current = () => alive.current && auth.currentUser?.uid === user.uid;
  useEffect(() => {
    let active = true;
    setView(null);
    setError("");
    void user
      .getIdToken(true)
      .then(() =>
        httpsCallable<{ token: string }, InvitationView>(
          functions,
          "inspectInvitation",
        )({ token }),
      )
      .then((result) => {
        if (active && current()) setView(result.data);
      })
      .catch(() => {
        if (active && current())
          setError(
            "Unable to check this invitation. Try again or contact your organization.",
          );
      });
    return () => {
      active = false;
    };
  }, [user, token, version]);
  async function accept() {
    setBusy(true);
    setError("");
    try {
      const result = await httpsCallable<
        { token: string; confirmed: true },
        InvitationView
      >(
        functions,
        "acceptInvitation",
      )({ token, confirmed: true });
      if (current()) setView(result.data);
    } catch {
      if (current())
        setError(
          "Unable to accept. Check again before retrying, or contact your organization.",
        );
    } finally {
      if (current()) setBusy(false);
    }
  }
  async function verify() {
    setBusy(true);
    try {
      await sendEmailVerification(user);
      if (current())
        setError(
          "Verification email requested. Follow the email, then check again.",
        );
    } catch {
      if (current()) setError("Unable to request verification. Try again.");
    } finally {
      if (current()) setBusy(false);
    }
  }
  return (
    <Screen>
      <ScrollView>
        <Title>Review invitation</Title>
        <Subtitle>Signed in as {user.email}</Subtitle>
        {error ? <Text accessibilityRole="alert">{error}</Text> : null}
        {!view && !error ? <Subtitle>Checking invitation…</Subtitle> : null}
        {view?.status === "pending" ? (
          <>
            <Title>{view.participantName}</Title>
            <Subtitle>
              You are accepting as {view.relationship}. Review the approved
              access before confirming.
            </Subtitle>
            <Subtitle>
              {view.permissions?.viewProfile ? "View profile. " : ""}
              {view.permissions?.viewSchedule ? "View schedule. " : ""}
              {view.permissions?.editProfile ? "Edit contact details. " : ""}
            </Subtitle>
            <PrimaryButton
              label="Confirm and accept invitation"
              onPress={() => void accept()}
              loading={busy}
            />
          </>
        ) : view ? (
          <Subtitle>{invitationMessage(view.status)}</Subtitle>
        ) : null}
        {view?.status === "verify-email" ? (
          <SecondaryButton
            label="Send verification email"
            onPress={() => void verify()}
            disabled={busy}
          />
        ) : null}
        {view?.status !== "accepted" ? (
          <SecondaryButton
            label="Check invitation again"
            onPress={() => setVersion((v) => v + 1)}
            disabled={busy}
          />
        ) : null}
        <SecondaryButton
          label="Close invitation"
          onPress={onClose}
          disabled={busy}
        />
        <Subtitle>
          Need help? Contact the organization that invited you. To switch
          accounts, close this invitation, sign out, then reopen the original
          link.
        </Subtitle>
      </ScrollView>
    </Screen>
  );
}
