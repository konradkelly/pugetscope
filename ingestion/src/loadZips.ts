import "dotenv/config";
import { loadZipBoundaries } from "./enrichment/loadZipBoundaries.js";

loadZipBoundaries()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[zips] failed:", err);
    process.exit(1);
  });
