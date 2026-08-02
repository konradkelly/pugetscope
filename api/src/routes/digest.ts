import type { FastifyInstance } from "fastify";
import { pool } from "../db/postgres.js";
import { escapeHtml, getFrontendShell, spliceCrawlerHtml } from "../lib/crawlerPage.js";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

interface DigestRow {
  date: string;
  headline: string;
  body: string;
  meta_description: string;
  stats: unknown;
}

async function findDigest(date: string): Promise<DigestRow | null> {
  const result = await pool.query<DigestRow>(
    // to_char(...) rather than the default DATE->JS Date parsing (see
    // traffic.ts's recentDates()/byDate map for the same convention) — we
    // want a plain YYYY-MM-DD string back, not a Date object.
    `SELECT to_char(date, 'YYYY-MM-DD') AS date, headline, body, meta_description, stats
     FROM digests WHERE date = $1`,
    [date],
  );
  return result.rows[0] ?? null;
}

// Cap rather than a query param — this is a public crawler-facing index
// page, not a paginated API, and 60 days is plenty for both readers and
// search engines to discover every digest via internal links.
const ARCHIVE_LIMIT = 60;

interface ArchiveRow {
  date: string;
  headline: string;
}

async function listDigests(): Promise<ArchiveRow[]> {
  const result = await pool.query<ArchiveRow>(
    `SELECT to_char(date, 'YYYY-MM-DD') AS date, headline
     FROM digests ORDER BY date DESC LIMIT $1`,
    [ARCHIVE_LIMIT],
  );
  return result.rows;
}

function digestArchiveBodyHtml(rows: ArchiveRow[]): string {
  const items = rows
    .map((r) => `<li><a href="/digest/${r.date}">${escapeHtml(r.headline)}</a> — ${r.date}</li>`)
    .join("");
  return `<article><h1>Daily Digest Archive</h1><p>PugetScope's AI-written daily summaries of Puget Sound air traffic.</p><ul>${items}</ul></article>`;
}

// Visible content injected as the first child of #root — React's
// createRoot(...).render() (frontend/src/main.tsx) replaces #root's children
// wholesale on mount, so this is only ever the crawler/first-paint content;
// no SSR/hydration-matching needed.
function digestBodyHtml(headline: string, body: string): string {
  const paragraphs = body
    .split(/\n{2,}/)
    .map((p) => `<p>${escapeHtml(p.trim())}</p>`)
    .join("");
  return `<article><h1>${escapeHtml(headline)}</h1>${paragraphs}<p><a href="/">View the live tracker &rarr;</a></p></article>`;
}

export async function digestRoutes(app: FastifyInstance): Promise<void> {
  // Crawler/browser-facing archive index — reached at the bare
  // pugetscope.com/digest (no /api prefix, same ingress Prefix rule as
  // /digest/:date below). Exists so every past digest is reachable by a
  // crawler via a real link, not just discoverable if it already knows the
  // exact date — see the sitemap-only-having-home+airports gap this closes.
  app.get("/digest", async (request, reply) => {
    let shell: string;
    try {
      shell = await getFrontendShell();
    } catch (err) {
      request.log.error(err, "[digest] frontend shell unavailable");
      return reply.code(503).send("Digest archive temporarily unavailable.");
    }

    const rows = await listDigests();
    const url = `${request.protocol}://${request.headers.host}/digest`;
    const html = spliceCrawlerHtml(shell, {
      title: "Daily Digest Archive | PugetScope",
      description: "Browse PugetScope's archive of daily AI-written summaries of Puget Sound air traffic.",
      url,
      bodyHtml: digestArchiveBodyHtml(rows),
    });

    return reply.type("text/html").send(html);
  });

  // Crawler/browser-facing page — reached at the bare pugetscope.com/digest/:date
  // (no /api prefix), a real server-rendered HTML document so the digest text
  // is present in the initial response with no JS execution required. See
  // docs/SPEC.md's daily-digest design note for why a client-only SPA route
  // isn't enough here.
  app.get<{ Params: { date: string } }>("/digest/:date", async (request, reply) => {
    const { date } = request.params;
    if (!DATE_RE.test(date)) {
      return reply.code(400).send("date must be YYYY-MM-DD");
    }

    const row = await findDigest(date);
    if (!row) {
      return reply.code(404).send("No digest for this date.");
    }

    let shell: string;
    try {
      shell = await getFrontendShell();
    } catch (err) {
      request.log.error(err, "[digest] frontend shell unavailable");
      return reply.code(503).send("Digest temporarily unavailable.");
    }

    const url = `${request.protocol}://${request.headers.host}/digest/${date}`;
    const html = spliceCrawlerHtml(shell, {
      title: `${row.headline} | PugetScope`,
      description: row.meta_description,
      url,
      bodyHtml: digestBodyHtml(row.headline, row.body),
    });

    return reply.type("text/html").send(html);
  });

  // JSON, for the SPA's own fetch after mount — reached via the existing
  // /api ingress prefix as /api/digests/:date. Plural to avoid colliding
  // with the HTML route above (different first path segment).
  app.get<{ Params: { date: string } }>("/digests/:date", async (request, reply) => {
    const { date } = request.params;
    if (!DATE_RE.test(date)) {
      return reply.code(400).send({ error: "date must be YYYY-MM-DD" });
    }

    const row = await findDigest(date);
    if (!row) {
      return reply.code(404).send({ error: "no digest for this date" });
    }

    return reply.send({
      date: row.date,
      headline: row.headline,
      body: row.body,
      metaDescription: row.meta_description,
      stats: row.stats,
    });
  });
}
