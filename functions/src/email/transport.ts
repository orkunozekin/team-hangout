import { createHash } from "node:crypto";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { defineSecret } from "firebase-functions/params";
export const essentialEmailApiKey = defineSecret("ESSENTIAL_EMAIL_API_KEY");
export type Mail = { to: string; subject: string; text: string };
export interface Transport {
  send(key: string, mail: Mail): Promise<string>;
}
export class DeliveryFailure extends Error {
  constructor(public code: "PRE_SEND" | "AMBIGUOUS" | "BOUNCE" | "REJECTED") {
    super(code);
  }
}
export const demoRuntime = () =>
  process.env.FUNCTIONS_EMULATOR === "true" &&
  process.env.GCLOUD_PROJECT === "demo-team-hangout";
export const contactKey = (orgId: string, email: string) =>
  createHash("sha256").update(`${orgId}:${email.toLowerCase()}`).digest("hex");
export function developmentTransport(): Transport {
  if (!demoRuntime())
    throw new Error("Development mailbox requires the isolated demo emulator.");
  return {
    async send(key, mail) {
      const ref = getFirestore().doc(`developmentMailbox/${key}`);
      await getFirestore().runTransaction(async (tx) => {
        const existing = await tx.get(ref);
        if (!existing.exists)
          tx.create(ref, {
            ...mail,
            acceptedAt: Timestamp.now(),
            transport: "development",
            key,
          });
      });
      return `development:${key}`;
    },
  };
}
export type SenderConfig = {
  from: string;
  replyTo: string;
  browserOrigin: string;
  privacyPolicyUrl: string;
};
export function senderConfig(): SenderConfig | null {
  if (demoRuntime())
    return {
      from: "demo@example.test",
      replyTo: "help@example.test",
      browserOrigin: "http://127.0.0.1:4177",
      privacyPolicyUrl: "http://127.0.0.1:4177/help",
    };
  // These are deployment contracts, not defaults that silently enable delivery.
  if (
    process.env.ESSENTIAL_EMAIL_ENABLED !== "true" ||
    process.env.ESSENTIAL_EMAIL_POLICY_APPROVED !== "true"
  )
    return null;
  const {
    ESSENTIAL_EMAIL_FROM: from,
    ESSENTIAL_EMAIL_REPLY_TO: replyTo,
    ESSENTIAL_EMAIL_BROWSER_ORIGIN: browserOrigin,
    ESSENTIAL_EMAIL_PRIVACY_URL: privacyPolicyUrl,
  } = process.env;
  if (
    !from ||
    !replyTo ||
    !browserOrigin ||
    !privacyPolicyUrl ||
    !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(from) ||
    !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(replyTo)
  )
    return null;
  try {
    const origin = new URL(browserOrigin),
      privacy = new URL(privacyPolicyUrl);
    if (
      origin.protocol !== "https:" ||
      origin.origin !== browserOrigin ||
      origin.username ||
      origin.password ||
      privacy.protocol !== "https:" ||
      privacy.username ||
      privacy.password
    )
      return null;
  } catch {
    return null;
  }
  return { from, replyTo, browserOrigin, privacyPolicyUrl };
}
export function productionTransport(
  config: SenderConfig,
  apiKey: string,
): Transport {
  return {
    async send(key, mail) {
      if (!apiKey) throw new DeliveryFailure("PRE_SEND");
      let response: Response;
      try {
        response = await fetch("https://api.resend.com/emails", {
          method: "POST",
          signal: AbortSignal.timeout(15000),
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            "Idempotency-Key": `essential/${key}`,
          },
          body: JSON.stringify({
            from: config.from,
            reply_to: config.replyTo,
            to: [mail.to],
            subject: mail.subject,
            text: mail.text,
          }),
        });
      } catch {
        throw new DeliveryFailure("AMBIGUOUS");
      }
      // A timeout or server error can follow acceptance. Never blindly retry it past the provider's 24-hour key retention.
      if (!response.ok)
        throw new DeliveryFailure(
          response.status === 429
            ? "PRE_SEND"
            : response.status >= 500
              ? "AMBIGUOUS"
              : "REJECTED",
        );
      try {
        const result = (await response.json()) as { id?: string };
        if (!result.id) throw new Error();
        return result.id;
      } catch {
        throw new DeliveryFailure("AMBIGUOUS");
      }
    },
  };
}
