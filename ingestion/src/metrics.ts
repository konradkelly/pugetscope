import http from "node:http";
import client from "prom-client";

export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });

export const pollDuration = new client.Histogram({
  name: "opensky_poll_duration_seconds",
  help: "Duration of a single OpenSky poll cycle (fetch + enrich + write) in seconds",
  registers: [registry],
});

export const pollTotal = new client.Counter({
  name: "opensky_poll_total",
  help: "OpenSky poll cycles by outcome",
  labelNames: ["status"], // success | error | rate_limited
  registers: [registry],
});

export const aircraftInRegion = new client.Gauge({
  name: "ingestion_aircraft_in_region",
  help: "Aircraft returned by the most recent successful poll",
  registers: [registry],
});

export const rollupRefreshDuration = new client.Histogram({
  name: "rollup_refresh_duration_seconds",
  help: "Duration of a rollup refresh cycle in seconds",
  labelNames: ["rollup"], // traffic | overflight
  registers: [registry],
});

export const rollupRefreshSkipped = new client.Counter({
  name: "rollup_refresh_skipped_total",
  help: "Rollup refreshes skipped because the previous cycle was still in flight",
  labelNames: ["rollup"],
  registers: [registry],
});

// No Fastify here (ingestion is a bare poll loop, not an HTTP service) — a
// plain http server is enough for Prometheus to scrape.
export function startMetricsServer(port: number): void {
  const server = http.createServer(async (req, res) => {
    if (req.url === "/metrics") {
      res.setHeader("Content-Type", registry.contentType);
      res.end(await registry.metrics());
      return;
    }
    if (req.url === "/healthz") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  server.listen(port, "0.0.0.0");
}
