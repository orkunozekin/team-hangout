import { invitationTokenFromUrl } from "../../../shared/invitations";
import { captureInviteCodeFromUrl } from "../deepLink";
const token = "AbCdEf_0123456789-".repeat(3).slice(0, 43);
test("opaque invitation tokens preserve case in browser and native links", () => {
  for (const url of [
    `https://example.test/invitation#token=${token}`,
    `teamhangout://invitation#token=${token}`,
  ]) {
    expect(invitationTokenFromUrl(url)).toBe(token);
    expect(
      captureInviteCodeFromUrl(
        `${url.split("#")[0]}?code=forged#token=${token}`,
      ),
    ).toBeNull();
  }
  expect(
    invitationTokenFromUrl(`https://example.test/join#token=${token}`),
  ).toBeNull();
  expect(
    invitationTokenFromUrl("teamhangout://invitation#token=short"),
  ).toBeNull();
  expect(captureInviteCodeFromUrl("teamhangout://join?code=abcd2345")).toBe(
    "ABCD2345",
  );
});
