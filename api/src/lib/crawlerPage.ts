// Shared plumbing for server-rendered crawler/first-paint HTML pages —
// splicing real content into frontend's already-built index.html shell so
// pages like /digest/:date, /airport/:icao, /neighborhood/:zip have their
// text present in the initial response with no JS execution required. See
// docs/SPEC.md's daily-digest design note for why a client-only SPA route
// isn't enough for these.

export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Splices page content into frontend's own already-built index.html
// (correct hashed asset tags included) rather than hand-assembling a shell —
// avoids any coupling to Vite's hashed output filenames. React's
// createRoot(...).render() (frontend/src/main.tsx) replaces #root's children
// wholesale on mount, so bodyHtml is only ever the crawler/first-paint
// content; no SSR/hydration-matching needed.
export function spliceCrawlerHtml(
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

export async function getFrontendShell(): Promise<string> {
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
      console.warn("[crawlerPage] frontend shell refresh failed, serving stale copy:", (err as Error).message);
      return shellCache.html;
    }
    throw err;
  }
}
