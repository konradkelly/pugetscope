import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import { config } from "../config.js";
import { pool } from "../db/postgres.js";
import type { WatchMatch } from "./matching.js";

// Not instantiated at all unless config.email.fromAddress is set — same
// local-dev-without-AWS-setup posture as api/src/email/sendPasswordResetEmail.ts.
const sesClient = config.email.fromAddress ? new SESClient({ region: config.email.region }) : null;

// Cooldown (matching.ts's COOLDOWN_MS) already caps how often a single watch
// can refire; this caps total alert-email volume per account per day across
// all of a user's watches, so someone watching several busy geofences
// doesn't get flooded. Once hit, matches for that user are still delivered
// by push (unaffected) and stay visible in-app — just not emailed until the
// next UTC day.
const DAILY_CAP = 10;

// Atomic check-and-increment — ON CONFLICT ... RETURNING avoids a separate
// SELECT-then-INSERT race between concurrently-matching watches for the same
// user. Returns whether this send is still under the cap; a suppressed send
// records itself in suppressed_count instead of sent_count.
async function underDailyCap(userId: string): Promise<boolean> {
  const result = await pool.query<{ sent_count: number }>(
    `INSERT INTO user_email_sends (user_id, day, sent_count)
     VALUES ($1, CURRENT_DATE, 1)
     ON CONFLICT (user_id, day) DO UPDATE SET sent_count = user_email_sends.sent_count + 1
     RETURNING sent_count`,
    [userId],
  );
  if (result.rows[0].sent_count <= DAILY_CAP) return true;

  await pool.query(
    `INSERT INTO user_email_sends (user_id, day, sent_count, suppressed_count)
     VALUES ($1, CURRENT_DATE, 0, 1)
     ON CONFLICT (user_id, day) DO UPDATE SET suppressed_count = user_email_sends.suppressed_count + 1`,
    [userId],
  );
  return false;
}

async function send(email: string, subject: string, body: string): Promise<void> {
  if (!sesClient || !config.email.fromAddress) {
    console.log(`[websocket] SES_FROM_EMAIL not set — would have emailed ${email}: ${subject}`);
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

export async function sendAlertEmails(matches: WatchMatch[]): Promise<void> {
  const eligible = matches.filter(({ watch }) => watch.notifyEmail && watch.userId && watch.email);
  if (eligible.length === 0) return;

  await Promise.all(
    eligible.map(async ({ watch, aircraft }) => {
      // Non-null per the filter above — TS can't narrow through the closure.
      const userId = watch.userId!;
      const email = watch.email!;

      const allowed = await underDailyCap(userId);
      if (!allowed) return;

      const label = watch.label || (watch.kind === "geofence" ? "Aircraft nearby" : "Aircraft spotted");
      const spotted = aircraft.callsign?.trim() || aircraft.icao24;

      try {
        await send(
          email,
          `PugetScope alert: ${label}`,
          `${spotted} matched your "${label}" watch.\n\nView the live tracker: https://pugetscope.com`,
        );
      } catch (err) {
        console.error("[websocket] alert email send failed:", err);
      }
    }),
  );
}
