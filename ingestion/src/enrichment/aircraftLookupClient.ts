// Free per-aircraft metadata lookups by ICAO24 (mode-s hex) — a fallback for
// aircraft the bulk OpenSky Aircraft Database CSV (loadAircraftDatabase.ts)
// left partially or fully blank. This is static airframe data (registration/
// type/manufacturer/operator), not the "typical route" prediction that made
// adsbdb unsuitable for route enrichment — see docs/SPEC.md §12 for why that
// tier was removed; this is a different, higher-confidence use of the same
// API.

const USER_AGENT = "pugetscope/0.1 (+https://github.com/konradkelly/pugetscope)";

export interface AircraftMetadata {
  registration: string | null;
  manufacturer: string | null;
  model: string | null;
  typecode: string | null;
  operator: string | null;
}

interface AdsbdbAircraftResponse {
  response?:
    | {
        aircraft?: {
          registration?: string;
          manufacturer?: string;
          type?: string;
          icao_type?: string;
          registered_owner?: string;
        };
      }
    | string;
}

// 200 with response.aircraft on a hit; 404 {"response":"unknown aircraft"} on a miss.
export async function lookupAdsbdb(icao24: string): Promise<AircraftMetadata | null> {
  const res = await fetch(`https://api.adsbdb.com/v0/aircraft/${icao24}`, {
    headers: { "User-Agent": USER_AGENT },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`adsbdb aircraft lookup failed for ${icao24}: ${res.status}`);
  }

  const body = (await res.json()) as AdsbdbAircraftResponse;
  const aircraft = typeof body.response === "object" ? body.response.aircraft : undefined;
  if (!aircraft) return null;

  return {
    registration: aircraft.registration?.trim() || null,
    manufacturer: aircraft.manufacturer?.trim() || null,
    model: aircraft.type?.trim() || null,
    typecode: aircraft.icao_type?.trim() || null,
    operator: aircraft.registered_owner?.trim() || null,
  };
}

interface HexdbAircraftResponse {
  Registration?: string;
  Manufacturer?: string;
  Type?: string;
  ICAOTypeCode?: string;
  RegisteredOwners?: string;
}

// 200 with the record directly (no wrapper) on a hit; 404 on a miss.
export async function lookupHexdb(icao24: string): Promise<AircraftMetadata | null> {
  const res = await fetch(`https://hexdb.io/api/v1/aircraft/${icao24}`, {
    headers: { "User-Agent": USER_AGENT },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`hexdb aircraft lookup failed for ${icao24}: ${res.status}`);
  }

  const body = (await res.json()) as HexdbAircraftResponse;
  if (!body.Registration && !body.Manufacturer && !body.Type) return null;

  return {
    registration: body.Registration?.trim() || null,
    manufacturer: body.Manufacturer?.trim() || null,
    model: body.Type?.trim() || null,
    typecode: body.ICAOTypeCode?.trim() || null,
    operator: body.RegisteredOwners?.trim() || null,
  };
}
