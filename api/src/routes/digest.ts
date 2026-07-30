import type { FastifyInstance } from "fastify";
import { pool } from "../db/postgres.js";

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

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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

// Splices digest content into frontend's own already-built index.html
// (correct hashed asset tags included) rather than hand-assembling a shell —
// avoids any coupling to Vite's hashed output filenames. See
// docs/rollup-tables.md-style reasoning in generateDigest.ts for why this
// reads from traffic_daily_counts rather than positions directly.
function spliceDigestHtml(
  shellHtml: string,
  params: { title: string; description: string; url: string; bodyHtml: string },
): string {
  const { title, description, url, bodyHtml } = params;
  let html = shellHtml;

  html = html.replace(/<title>.*?<\/title>/s, `<title>${escapeHtml(title)}</title>`);
  html = html.replace(/(<meta name="description" content=")[^"]*(")/, `$1${escapeHtml(description)}$2`);
  html = html.replace(/(<meta property="og:title" content=")[^"]*(")/, `$1${escapeHtml(title)}$2`);
  html = html.replace(/(<meta property="og:description" content=")[^"]*(")/, `$1${escapeHtml(description)}$2`);
  html = html.replace(/(<meta property="og:url" content=")[^"]*(")/, `$1${escapeHtml(url)}$2`);
  html = html.replace(/(<meta name="twitter:title" content=")[^"]*(")/, `$1${escapeHtml(title)}$2`);
  html = html.replace(/(<meta name="twitter:description" content=")[^"]*(")/, `$1${escapeHtml(description)}$2`);
  html = html.replace('<div id="root"></div>', `<div id="root">${bodyHtml}</div>`);

  return html;
}

// Module-level cache of frontend's built index.html — avoids hitting
// frontend on every crawler/browser request just to get the same static
// shell. On refetch failure, a stale-but-correct shell beats a 500; only
// error out if there's never been a successful fetch.
const SHELL_CACHE_TTL_MS = 60_000;
let shellCache: { html: string; fetchedAt: number } | null = null;

async function getFrontendShell(): Promise<string> {
  const now = Date.now();
  if (shellCache && now - shellCache.fetchedAt < SHELL_CACHE_TTL_MS) {
    return shellCache.html;
  }
  try {
    const res = await fetch("http://frontend/index.html");
    if (!res.ok) throw new Error(`frontend responded ${res.status}`);
    const html = await res.text();
    shellCache = { html, fetchedAt: now };
    return html;
  } catch (err) {
    if (shellCache) {
      console.warn("[digest] frontend shell refresh failed, serving stale copy:", (err as Error).message);
      return shellCache.html;
    }
    throw err;
  }
}

export async function digestRoutes(app: FastifyInstance): Promise<void> {
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
    const html = spliceDigestHtml(shell, {
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
