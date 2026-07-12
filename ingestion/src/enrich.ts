import "dotenv/config";
import { runEnrichment } from "./enrichment/loadAircraftDatabase.js";

runEnrichment()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[enrichment] failed:", err);
    process.exit(1);
  });
