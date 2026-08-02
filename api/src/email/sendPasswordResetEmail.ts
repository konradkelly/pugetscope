import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import { config } from "../config.js";

// Not instantiated at all unless config.email.fromAddress is set — the SDK's
// default credential provider chain would otherwise try (and fail) to
// resolve credentials in local dev, where there's no EC2 instance-metadata
// service to fall back to.
const sesClient = config.email.fromAddress ? new SESClient({ region: config.email.region }) : null;

// Gated on SES_FROM_EMAIL being set, same "optional, log once, don't crash"
// posture as ingestion/src/enrichment/fidsRefreshWorker.ts's
// AERODATABOX_API_KEY check — lets local dev exercise the full forgot/reset
// flow without any AWS setup: the link that would have been emailed is
// logged instead, so it's still usable by hand.
export async function sendPasswordResetEmail(toEmail: string, resetUrl: string): Promise<void> {
  if (!sesClient || !config.email.fromAddress) {
    console.log(`[email] SES_FROM_EMAIL not set — would have emailed ${toEmail}: ${resetUrl}`);
    return;
  }

  await sesClient.send(
    new SendEmailCommand({
      Source: config.email.fromAddress,
      Destination: { ToAddresses: [toEmail] },
      Message: {
        Subject: { Data: "Reset your PugetScope password" },
        Body: {
          Text: {
            Data: `Someone requested a password reset for this email address.\n\nReset your password: ${resetUrl}\n\nThis link expires in 30 minutes. If you didn't request this, you can ignore this email.`,
          },
        },
      },
    }),
  );
}
