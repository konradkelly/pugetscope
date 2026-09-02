import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import type { Pool } from "pg";
import { config } from "../config.js";

// Not instantiated at all unless config.email.fromAddress is set — same
// local-dev-without-AWS-setup posture as api/src/email/sendPasswordResetEmail.ts.
const sesClient = config.email.fromAddress ? new SESClient({ region: config.email.region }) : null;

interface SubscriberRow {
  email: string;
  unsubscribe_token: string;
}

async function send(email: string, subject: string, body: string): Promise<void> {
  if (!sesClient || !config.email.fromAddress) {
    console.log(`[generate-digest] SES_FROM_EMAIL not set — would have emailed ${email}: ${subject}`);
    return;
  }

  await sesClient.send(
    new SendEmailCommand({
      Source: config.email.fromAddress,
      Destination: { ToAddresses: [email] },
      Message: {
        Subject: { Data: subject },
        Body: { Text: { Data: body } },
      },
    }),
  );
}

// One digest a day, at most — no cap needed here the way alert emails need
// one (websocket/src/alerts/notifyEmail.ts). Sends are independent
// (allSettled, not Promise.all) so one bad address can't abort the batch.
export async function sendDigestEmails(
  pool: Pool,
  date: string,
  headline: string,
  body: string,
): Promise<void> {
  const result = await pool.query<SubscriberRow>(
    `SELECT u.email, s.unsubscribe_token
     FROM digest_subscriptions s
     JOIN users u ON u.id = s.user_id`,
  );
  if (result.rows.length === 0) return;

  const outcomes = await Promise.allSettled(
    result.rows.map((row) =>
      send(
        row.email,
        `PugetScope Daily Digest: ${headline}`,
        `${body}\n\nRead online: ${config.frontendUrl}/digest/${date}\n\n` +
          `Unsubscribe: ${config.frontendUrl}/digest/unsubscribe?token=${row.unsubscribe_token}`,
      ),
    ),
  );

  const failed = outcomes.filter((o) => o.status === "rejected").length;
  console.log(
    `[generate-digest] digest emails: ${result.rows.length - failed}/${result.rows.length} sent`,
  );
  for (const outcome of outcomes) {
    if (outcome.status === "rejected") console.error("[generate-digest] digest email send failed:", outcome.reason);
  }
}
