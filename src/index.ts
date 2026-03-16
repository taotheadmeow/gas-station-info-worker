import { z } from "zod";

export interface Env {
  DB: D1Database;
  TURNSTILE_SECRET_KEY: string;
  ALLOWED_ORIGIN: string;
}

let ALLOWED_ORIGIN: string = 'http://localhost:3000';

type JsonRecord = Record<string, unknown>;

function getCorsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("Origin") || "";
  const allowOriginFromEnv: string[] = [ALLOWED_ORIGIN];
  const allowOrigin = allowOriginFromEnv.includes(origin) ? origin : allowOriginFromEnv[0];

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

const json = (request: Request, data: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(data, null, 2), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...getCorsHeaders(request),
      ...(init.headers || {}),
    },
  });

const errorJson = (
  request: Request,
  message: string,
  status = 400,
  extra?: JsonRecord
) =>
  json(
    request,
    {
      success: false,
      message,
      ...(extra || {}),
    },
    { status }
  );

const nullableBoolSchema = z.boolean().nullable();

const dateTimeWithOffsetSchema = z.string().refine(
  (val) => !Number.isNaN(Date.parse(val.replace(" ", "T"))),
  { message: "Invalid datetime with offset" }
);

const fuelAvailabilitySchema = z.object({
  "Premium Diesel": nullableBoolSchema,
  Diesel: nullableBoolSchema,
  B20: nullableBoolSchema,
  "Gasohol 95 (E10)": nullableBoolSchema,
  "Gasohol 91 (E10)": nullableBoolSchema,
  E20: nullableBoolSchema,
  "Gasoline 95": nullableBoolSchema,
  "Premium Gasohol": nullableBoolSchema,
  E85: nullableBoolSchema,
});

const geoPointSchema = z.object({
  type: z.literal("Point"),
  coordinates: z
    .tuple([z.number(), z.number()])
    .refine(([lng, lat]) => lng >= -180 && lng <= 180 && lat >= -90 && lat <= 90, {
      message: "Invalid GeoJSON coordinates",
    }),
});

const stationBodySchema = z.object({
  //last_updated: dateTimeWithOffsetSchema,
  location: geoPointSchema,
  name: z.string().min(1),
  is_open: z.boolean(),
  availableFuels: fuelAvailabilitySchema,
  turnstileToken: z.string().min(1),
});

type PermissionRow = {
  id: string;
  name: string | null;
  read: number;
  write: number;
  update: number;
  delete: number;
}

type StationRow = {
  id: string;
  last_updated: string;
  lat: number;
  lng: number;
  name: string;
  is_open: number;

  premium_diesel_available: number | null;
  diesel_available: number | null;
  b20_available: number | null;
  gasohol_95_e10_available: number | null;
  gasohol_91_e10_available: number | null;
  e20_available: number | null;
  gasoline_95_available: number | null;
  premium_gasohol_available: number | null;
  e85_available: number | null;
};

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value
  );
}

function parseCoordinateParam(raw: string | null): { lat: number; lng: number } | null {
  if (!raw) return null;

  const parts = raw.split(",").map((s) => s.trim());
  if (parts.length !== 2) return null;

  const lat = Number(parts[0]);
  const lng = Number(parts[1]);

  if (Number.isNaN(lat) || Number.isNaN(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;

  return { lat, lng };
}

function dbBoolToJsonBool(value: number | null): boolean | null {
  if (value === null || value === undefined) return null;
  return value === 1;
}

function jsonBoolToDbBool(value: boolean | null): number | null {
  if (value === null || value === undefined) return null;
  return value ? 1 : 0;
}

async function verifyTurnstileToken(
  token: string,
  secretKey: string,
  request: Request
): Promise<boolean> {
  const ip =
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for") ||
    "";

  const formData = new FormData();
  formData.append("secret", secretKey);
  formData.append("response", token);
  if (ip) formData.append("remoteip", ip);

  const resp = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body: formData,
  });

  if (!resp.ok) return false;

  const data = (await resp.json()) as { success?: boolean };
  return Boolean(data.success);
}

function mapRowToStation(row: StationRow) {
  return {
    id: row.id,
    last_updated: row.last_updated,
    location: {
      type: "Point",
      coordinates: [row.lng, row.lat] as [number, number],
    },
    name: row.name,
    is_open: Boolean(row.is_open),
    availableFuels: {
      "Premium Diesel": dbBoolToJsonBool(row.premium_diesel_available),
      Diesel: dbBoolToJsonBool(row.diesel_available),
      B20: dbBoolToJsonBool(row.b20_available),
      "Gasohol 95 (E10)": dbBoolToJsonBool(row.gasohol_95_e10_available),
      "Gasohol 91 (E10)": dbBoolToJsonBool(row.gasohol_91_e10_available),
      E20: dbBoolToJsonBool(row.e20_available),
      "Gasoline 95": dbBoolToJsonBool(row.gasoline_95_available),
      "Premium Gasohol": dbBoolToJsonBool(row.premium_gasohol_available),
      E85: dbBoolToJsonBool(row.e85_available),
    },
  };
}

function stationSelectColumns(): string {
  return `
    id,
    last_updated,
    lat,
    lng,
    name,
    is_open,
    premium_diesel_available,
    diesel_available,
    b20_available,
    gasohol_95_e10_available,
    gasohol_91_e10_available,
    e20_available,
    gasoline_95_available,
    premium_gasohol_available,
    e85_available
  `;
}

async function handleGetPublicPermissions(request: Request, env: Env): Promise<Response> {
  const stmt1 = env.DB.prepare(`SELECT * FROM permissions WHERE id = 1`);
  const row1 = await stmt1.first<PermissionRow>();

  return json(
    request,
    {
      create: row1?.write ?? false,
      update: row1?.update ?? false,
      delete: row1?.delete ?? false,
    },
    { status: 200 }
  );
}

async function handleGetStations(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const coordinate = parseCoordinateParam(url.searchParams.get("coordinate"));
  const radiusRaw = url.searchParams.get("radius");

  if ((coordinate && radiusRaw === null) || (!coordinate && radiusRaw !== null)) {
    return errorJson(request, "coordinate and radius must be provided together", 400);
  }

  if (coordinate && radiusRaw !== null) {
    const radiusKm = Number(radiusRaw);
    if (Number.isNaN(radiusKm) || radiusKm < 0) {
      return errorJson(request, "radius must be a non-negative number", 400);
    }

    const stmt = env.DB.prepare(`
      SELECT
        ${stationSelectColumns()},
        (
          6371 * acos(
            cos(radians(?)) *
            cos(radians(lat)) *
            cos(radians(lng) - radians(?)) +
            sin(radians(?)) *
            sin(radians(lat))
          )
        ) AS distance_km
      FROM stations
      WHERE (
        6371 * acos(
          cos(radians(?)) *
          cos(radians(lat)) *
          cos(radians(lng) - radians(?)) +
          sin(radians(?)) *
          sin(radians(lat))
        )
      ) <= ?
      ORDER BY distance_km ASC, last_updated DESC
      LIMIT 1000
    `).bind(
      coordinate.lat,
      coordinate.lng,
      coordinate.lat,
      coordinate.lat,
      coordinate.lng,
      coordinate.lat,
      radiusKm
    );

    const result = await stmt.all<StationRow & { distance_km: number }>();
    return json(request, (result.results || []).map(mapRowToStation), { status: 200 });
  }

  const stmt = env.DB.prepare(`
    SELECT
      ${stationSelectColumns()}
    FROM stations
    ORDER BY last_updated DESC, id DESC
    LIMIT 1000
  `);

  const result = await stmt.all<StationRow>();
  return json(request, (result.results || []).map(mapRowToStation), { status: 200 });
}

async function handleGetStationById(
  request: Request,
  env: Env,
  stationId: string
): Promise<Response> {
  if (!isUuid(stationId)) {
    return errorJson(request, "Invalid station id", 400);
  }

  const stmt = env.DB.prepare(`
    SELECT
      ${stationSelectColumns()}
    FROM stations
    WHERE id = ?
    LIMIT 1
  `).bind(stationId);

  const row = await stmt.first<StationRow>();

  if (!row) {
    return errorJson(request, "Station not found", 404);
  }

  return json(request, mapRowToStation(row), { status: 200 });
}

async function handlePostStation(request: Request, env: Env): Promise<Response> {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return errorJson(request, "Invalid JSON body", 400);
  }

  const parsed = stationBodySchema.safeParse(body);
  if (!parsed.success) {
    return errorJson(request, "Validation failed", 400, {
      errors: parsed.error.flatten(),
    });
  }

  const verified = await verifyTurnstileToken(
    parsed.data.turnstileToken,
    env.TURNSTILE_SECRET_KEY,
    request
  );

  if (!verified) {
    return errorJson(request, "Invalid turnstile token", 403);
  }

  const { turnstileToken, ...stationData } = parsed.data;
  const [lng, lat] = stationData.location.coordinates;
  const id = crypto.randomUUID();
  let nowdt = new Date();
  const insertStmt = env.DB.prepare(`
    INSERT INTO stations (
      id,
      last_updated,
      lat,
      lng,
      name,
      is_open,
      premium_diesel_available,
      diesel_available,
      b20_available,
      gasohol_95_e10_available,
      gasohol_91_e10_available,
      e20_available,
      gasoline_95_available,
      premium_gasohol_available,
      e85_available
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    nowdt.toISOString(),
    lat,
    lng,
    stationData.name,
    stationData.is_open ? 1 : 0,
    jsonBoolToDbBool(stationData.availableFuels["Premium Diesel"]),
    jsonBoolToDbBool(stationData.availableFuels["Diesel"]),
    jsonBoolToDbBool(stationData.availableFuels["B20"]),
    jsonBoolToDbBool(stationData.availableFuels["Gasohol 95 (E10)"]),
    jsonBoolToDbBool(stationData.availableFuels["Gasohol 91 (E10)"]),
    jsonBoolToDbBool(stationData.availableFuels["E20"]),
    jsonBoolToDbBool(stationData.availableFuels["Gasoline 95"]),
    jsonBoolToDbBool(stationData.availableFuels["Premium Gasohol"]),
    jsonBoolToDbBool(stationData.availableFuels["E85"])
  );

  await insertStmt.run();

  return json(
    request,
    {
      id,
      ...stationData,
    },
    { status: 201 }
  );
}

async function handlePutStation(
  request: Request,
  env: Env,
  stationId: string
): Promise<Response> {
  const stmt1 = env.DB.prepare(`SELECT * FROM permissions WHERE id = 1`);
  const row1 = await stmt1.first<PermissionRow>();
  if ((row1?.update ?? 0) == 0) {
    return errorJson(request, "Permission Denied", 403);
  }
  if (!isUuid(stationId)) {
    return errorJson(request, "Invalid station id", 400);
  }

  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return errorJson(request, "Invalid JSON body", 400);
  }

  const parsed = stationBodySchema.safeParse(body);
  if (!parsed.success) {
    return errorJson(request, "Validation failed", 400, {
      errors: parsed.error.flatten(),
    });
  }

  const verified = await verifyTurnstileToken(
    parsed.data.turnstileToken,
    env.TURNSTILE_SECRET_KEY,
    request
  );

  if (!verified) {
    return errorJson(request, "Invalid turnstile token", 403);
  }

  const { turnstileToken, ...stationData } = parsed.data;
  const [lng, lat] = stationData.location.coordinates;
  let nowdt = new Date();
  const updateStmt = env.DB.prepare(`
    UPDATE stations
    SET
      last_updated = ?,
      lat = ?,
      lng = ?,
      name = ?,
      is_open = ?,
      premium_diesel_available = ?,
      diesel_available = ?,
      b20_available = ?,
      gasohol_95_e10_available = ?,
      gasohol_91_e10_available = ?,
      e20_available = ?,
      gasoline_95_available = ?,
      premium_gasohol_available = ?,
      e85_available = ?
    WHERE id = ?
  `).bind(
    nowdt.toISOString(),
    lat,
    lng,
    stationData.name,
    stationData.is_open ? 1 : 0,
    jsonBoolToDbBool(stationData.availableFuels["Premium Diesel"]),
    jsonBoolToDbBool(stationData.availableFuels["Diesel"]),
    jsonBoolToDbBool(stationData.availableFuels["B20"]),
    jsonBoolToDbBool(stationData.availableFuels["Gasohol 95 (E10)"]),
    jsonBoolToDbBool(stationData.availableFuels["Gasohol 91 (E10)"]),
    jsonBoolToDbBool(stationData.availableFuels["E20"]),
    jsonBoolToDbBool(stationData.availableFuels["Gasoline 95"]),
    jsonBoolToDbBool(stationData.availableFuels["Premium Gasohol"]),
    jsonBoolToDbBool(stationData.availableFuels["E85"]),
    stationId
  );

  const result = await updateStmt.run();

  if (!result.meta.changes) {
    return errorJson(request, "Station not found", 404);
  }

  return json(
    request,
    {
      id: stationId,
      ...stationData,
    },
    { status: 200 }
  );
}

async function handleDeleteStation(
  request: Request,
  env: Env,
  stationId: string
): Promise<Response> {
  const stmt1 = env.DB.prepare(`SELECT * FROM permissions WHERE id = 1`);
  const row1 = await stmt1.first<PermissionRow>();
  if ((row1?.delete ?? 0) == 0) {
    return errorJson(request, "Permission Denied", 403);
  }
  
  if (!isUuid(stationId)) {
    return errorJson(request, "Invalid station id", 400);
  }

  const stmt = env.DB.prepare(`DELETE FROM stations WHERE id = ?`).bind(stationId);
  const result = await stmt.run();

  if (!result.meta.changes) {
    return errorJson(request, "Station not found", 404);
  }

  return json(
    request,
    {
      success: true,
      deletedId: stationId,
    },
    { status: 200 }
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    ALLOWED_ORIGIN = env.ALLOWED_ORIGIN;
    try {
      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: getCorsHeaders(request),
        });
      }

      const url = new URL(request.url);
      const pathname = url.pathname;
      const method = request.method.toUpperCase();

      if (pathname === "/api/permissions/public" && method === "GET") {
        return await handleGetPublicPermissions(request, env);
      }

      if (pathname === "/api/stations" && method === "GET") {
        return await handleGetStations(request, env);
      }

      if (pathname === "/api/stations" && method === "POST") {
        return await handlePostStation(request, env);
      }

      const stationIdMatch = pathname.match(/^\/api\/stations\/([0-9a-fA-F-]{36})$/);

      if (stationIdMatch) {
        const stationId = stationIdMatch[1];

        if (method === "GET") {
          return await handleGetStationById(request, env, stationId);
        }

        if (method === "PUT") {
          return await handlePutStation(request, env, stationId);
        }

        if (method === "DELETE") {
          return await handleDeleteStation(request, env, stationId);
        }
      }

      return errorJson(request, "Not found", 404);
    } catch (error) {
      return errorJson(request, "Internal server error", 500, {
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  },
};