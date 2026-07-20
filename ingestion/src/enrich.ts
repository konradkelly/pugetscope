import "dotenv/config";
import { runEnrichment } from "./enrichment/loadAircraftDatabase.js";
import { fillMissingAircraft } from "./enrichment/fillMissingAircraft.js";

runEnrichment()
  .then(() => fillMissingAircraft())
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[enrichment] failed:", err);
    process.exit(1);
  });
