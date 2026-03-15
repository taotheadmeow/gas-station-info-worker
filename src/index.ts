import { z } from "zod";

export interface Env {
  MONGODB_DATA_API_URL: string;
  MONGODB_DATA_API_KEY: string;
  MONGODB_DATA_SOURCE: string;
  MONGODB_DATABASE: string;
  MONGODB_COLLECTION: string;
  TURNSTILE_SECRET_KEY: string;
}

type JsonRecord = Record<string, unknown>;

const ALLOWED_ORIGINS = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
];

function getCorsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("Origin") || "";
  const allowOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];

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

const dateTimeWithOffsetSchema = z.string().refine(
  (val) => !Number.isNaN(Date.parse(val.replace(" ", "T"))),
  { message: "Invalid datetime with offset" }
);

const fuelAvailabilitySchema = z.object({
  "Premium Diesel": z.boolean().nullable(),
  Diesel: z.boolean().nullable(),
  B20: z.boolean().nullable(),
  "Gasohol 95 (E10)": z.boolean().nullable(),
  "Gasohol 91 (E10)": z.boolean().nullable(),
  E20: z.boolean().nullable(),
  "Gasoline 95": z.boolean().nullable(),
  "Premium Gasohol": z.boolean().nullable(),
  E85: z.boolean().nullable(),
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
  last_updated: dateTimeWithOffsetSchema,
  location: geoPointSchema,
  name: z.string().min(1),
  is_open: z.boolean(),
  availableFuels: fuelAvailabilitySchema,
  turnstileToken: z.string().min(1),
});

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

async function mongoDataApi<T>(
  env: Env,
  action: "find" | "findOne" | "insertOne" | "updateOne",
  body: JsonRecord
): Promise<T> {
  const resp = await fetch(`${env.MONGODB_DATA_API_URL}/action/${action}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-key": env.MONGODB_DATA_API_KEY,
    },
    body: JSON.stringify({
      dataSource: env.MONGODB_DATA_SOURCE,
      database: env.MONGODB_DATABASE,
      collection: env.MONGODB_COLLECTION,
      ...body,
    }),
  });

  const data = (await resp.json()) as T & { error?: string };

  if (!resp.ok || data?.error) {
    throw new Error(data?.error || "MongoDB Data API error");
  }

  return data;
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

function isValidObjectId(id: string): boolean {
  return /^[a-fA-F0-9]{24}$/.test(id);
}

function sanitizeStationDoc(doc: JsonRecord): JsonRecord {
  return {
    _id: doc._id,
    last_updated: doc.last_updated,
    location: doc.location,
    name: doc.name,
    is_open: doc.is_open,
    availableFuels: doc.availableFuels,
  };
}

async function handleGetStations(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const coordinate = parseCoordinateParam(url.searchParams.get("coordinate"));
  const radiusRaw = url.searchParams.get("radius");

  let filter: JsonRecord = {};
  let sort: JsonRecord = { last_updated: -1 };

  if ((coordinate && radiusRaw === null) || (!coordinate && radiusRaw !== null)) {
    return errorJson(request, "coordinate and radius must be provided together", 400);
  }

  if (coordinate && radiusRaw !== null) {
    const radiusKm = Number(radiusRaw);
    if (Number.isNaN(radiusKm) || radiusKm < 0) {
      return errorJson(request, "radius must be a non-negative number", 400);
    }

    const radiusMeters = Math.round(radiusKm * 1000);

    filter = {
      location: {
        $near: {
          $geometry: {
            type: "Point",
            coordinates: [coordinate.lng, coordinate.lat],
          },
          $maxDistance: radiusMeters,
        },
      },
    };

    sort = {};
  }

  const result = await mongoDataApi<{ documents: JsonRecord[] }>(env, "find", {
    filter,
    sort,
    limit: 1000,
  });

  return json(request, (result.documents || []).map(sanitizeStationDoc), { status: 200 });
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

  const insertResult = await mongoDataApi<{
    insertedId: { $oid: string };
  }>(env, "insertOne", {
    document: stationData,
  });

  return json(
    request,
    {
      _id: insertResult.insertedId,
      ...stationData,
    },
    { status: 201 }
  );
}

async function handlePutStation(
  request: Request,
  env: Env,
  mongoId: string
): Promise<Response> {
  if (!isValidObjectId(mongoId)) {
    return errorJson(request, "Invalid mongo object id", 400);
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

  const updateResult = await mongoDataApi<{
    matchedCount: number;
    modifiedCount: number;
  }>(env, "updateOne", {
    filter: {
      _id: { $oid: mongoId },
    },
    update: {
      $set: stationData,
    },
  });

  if (!updateResult.matchedCount) {
    return errorJson(request, "Station not found", 404);
  }

  return json(
    request,
    {
      _id: { $oid: mongoId },
      ...stationData,
    },
    { status: 200 }
  );
}

async function handleGetStationById(
  request: Request,
  env: Env,
  mongoId: string
): Promise<Response> {
  if (!isValidObjectId(mongoId)) {
    return errorJson(request, "Invalid mongo object id", 400);
  }

  const result = await mongoDataApi<{ document: JsonRecord | null }>(env, "findOne", {
    filter: {
      _id: { $oid: mongoId },
    },
  });

  if (!result.document) {
    return errorJson(request, "Station not found", 404);
  }

  return json(request, sanitizeStationDoc(result.document), { status: 200 });
}

async function handleGetPublicPermissions(request: Request): Promise<Response> {
  return json(
    request,
    {
      create: true,
      update: true,
      delete: true,
    },
    { status: 200 }
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
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

      if (pathname === "/api/stations" && method === "GET") {
        return await handleGetStations(request, env);
      }

      if (pathname === "/api/stations" && method === "POST") {
        return await handlePostStation(request, env);
      }

      if (pathname === "/api/permissions/public" && method === "GET") {
        return await handleGetPublicPermissions(request);
      }

      const stationIdMatch = pathname.match(/^\/api\/stations\/([a-fA-F0-9]{24})$/);

      if (stationIdMatch) {
        const mongoId = stationIdMatch[1];

        if (method === "GET") {
          return await handleGetStationById(request, env, mongoId);
        }

        if (method === "PUT") {
          return await handlePutStation(request, env, mongoId);
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