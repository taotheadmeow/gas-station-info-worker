import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { ObjectId } from 'mongodb';
import { z } from 'zod';
import { getStationsCollection } from './db';
import {
  stationCreateSchema,
  stationFuelUpdateSchema,
  stationUpdateSchema,
} from './schema';
import { verifyTurnstileOrThrow } from './turnstile';
import type { Env, StationDocument } from './types';
import { clamp, computePinColor, jsonError, parseBoolean } from './utils';

const app = new Hono<{ Bindings: Env }>();

app.use('*', async (c, next) => {
  const origin = c.env.ALLOWED_ORIGIN || '*';
  return cors({
    origin,
    allowHeaders: ['Content-Type', 'Authorization'],
    allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    credentials: origin !== '*',
    maxAge: 86400,
  })(c, next);
});

app.get('/health', async (c) => {
  const collection = await getStationsCollection(c.env);
  const count = await collection.countDocuments({});
  return c.json({
    success: true,
    service: 'gas-station-worker',
    db: c.env.MONGODB_DB_NAME,
    collection: c.env.MONGODB_COLLECTION_STATIONS,
    stations: count,
    time: new Date().toISOString(),
  });
});

app.get('/api/stations', async (c) => {
  const collection = await getStationsCollection(c.env);

  const lat = Number(c.req.query('lat'));
  const lng = Number(c.req.query('lng'));
  const radiusKm = clamp(Number(c.req.query('radiusKm') || '10'), 0.1, 100);
  const limit = clamp(Number(c.req.query('limit') || '200'), 1, 500);
  const q = c.req.query('q')?.trim();
  const onlyOpen = parseBoolean(c.req.query('onlyOpen'), false);
  const bbox = c.req.query('bbox');

  const filter: Record<string, unknown> = {};
  if (onlyOpen) filter.isOpen = true;

  if (q) {
    filter.$text = { $search: q };
  }

  if (bbox) {
    const parts = bbox.split(',').map((v) => Number(v.trim()));
    if (parts.length !== 4 || parts.some(Number.isNaN)) {
      return jsonError('bbox must be minLng,minLat,maxLng,maxLat', 400);
    }
    const [minLng, minLat, maxLng, maxLat] = parts;
    filter.location = {
      $geoWithin: {
        $box: [
          [minLng, minLat],
          [maxLng, maxLat],
        ],
      },
    };
  } else if (!Number.isNaN(lat) && !Number.isNaN(lng)) {
    filter.location = {
      $near: {
        $geometry: { type: 'Point', coordinates: [lng, lat] },
        $maxDistance: radiusKm * 1000,
      },
    };
  }

  const cursor = collection.find(filter, {
    limit,
    projection: {
      name: 1,
      brand: 1,
      address: 1,
      province: 1,
      district: 1,
      subdistrict: 1,
      isOpen: 1,
      open24Hours: 1,
      note: 1,
      services: 1,
      availableFuels: 1,
      location: 1,
      pinColor: 1,
      updatedAt: 1,
      createdAt: 1,
      ...(q ? { score: { $meta: 'textScore' } } : {}),
    },
    ...(q ? { sort: { score: { $meta: 'textScore' } } } : { sort: { updatedAt: -1 } }),
  });

  const docs = await cursor.toArray();
  return c.json({
    success: true,
    count: docs.length,
    data: docs.map(serializeStation),
  });
});

app.get('/api/stations/:id', async (c) => {
  const id = c.req.param('id');
  if (!ObjectId.isValid(id)) return jsonError('Invalid station id', 400);

  const collection = await getStationsCollection(c.env);
  const station = await collection.findOne({ _id: new ObjectId(id) });
  if (!station) return jsonError('Station not found', 404);

  return c.json({ success: true, data: serializeStation(station) });
});

app.post('/api/stations', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return jsonError('Invalid JSON body', 400);

  const parsed = stationCreateSchema.safeParse(body);
  if (!parsed.success) return validationError(parsed.error);

  try {
    await verifyTurnstileOrThrow(
      c.env,
      parsed.data.captchaToken,
      c.req.header('CF-Connecting-IP') ?? null,
    );
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : 'Captcha verification failed', 400);
  }

  const collection = await getStationsCollection(c.env);
  const now = new Date().toISOString();

  const document: StationDocument = {
    name: parsed.data.name,
    brand: parsed.data.brand ?? null,
    address: parsed.data.address ?? null,
    province: parsed.data.province ?? null,
    district: parsed.data.district ?? null,
    subdistrict: parsed.data.subdistrict ?? null,
    isOpen: parsed.data.isOpen,
    open24Hours: parsed.data.open24Hours ?? false,
    note: parsed.data.note ?? null,
    services: parsed.data.services ?? [],
    availableFuels: normalizeFuelDates(parsed.data.availableFuels, now),
    location: {
      type: 'Point',
      coordinates: [parsed.data.longitude, parsed.data.latitude],
    },
    pinColor: computePinColor(parsed.data.isOpen, parsed.data.availableFuels),
    createdAt: now,
    updatedAt: now,
  };

  const inserted = await collection.insertOne(document);
  const saved = await collection.findOne({ _id: inserted.insertedId });
  return c.json({ success: true, data: saved ? serializeStation(saved) : null }, 201);
});

app.patch('/api/stations/:id', async (c) => {
  const id = c.req.param('id');
  if (!ObjectId.isValid(id)) return jsonError('Invalid station id', 400);

  const body = await c.req.json().catch(() => null);
  if (!body) return jsonError('Invalid JSON body', 400);

  const parsed = stationUpdateSchema.safeParse(body);
  if (!parsed.success) return validationError(parsed.error);

  const collection = await getStationsCollection(c.env);
  const existing = await collection.findOne({ _id: new ObjectId(id) });
  if (!existing) return jsonError('Station not found', 404);

  const now = new Date().toISOString();
  const mergedFuels = parsed.data.availableFuels
    ? normalizeFuelDates(parsed.data.availableFuels, now)
    : existing.availableFuels;

  const longitude = parsed.data.longitude ?? existing.location.coordinates[0];
  const latitude = parsed.data.latitude ?? existing.location.coordinates[1];
  const isOpen = parsed.data.isOpen ?? existing.isOpen;

  const updateDoc: Partial<StationDocument> = {
    ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
    ...(parsed.data.brand !== undefined ? { brand: parsed.data.brand ?? null } : {}),
    ...(parsed.data.address !== undefined ? { address: parsed.data.address ?? null } : {}),
    ...(parsed.data.province !== undefined ? { province: parsed.data.province ?? null } : {}),
    ...(parsed.data.district !== undefined ? { district: parsed.data.district ?? null } : {}),
    ...(parsed.data.subdistrict !== undefined ? { subdistrict: parsed.data.subdistrict ?? null } : {}),
    ...(parsed.data.isOpen !== undefined ? { isOpen } : {}),
    ...(parsed.data.open24Hours !== undefined ? { open24Hours: parsed.data.open24Hours } : {}),
    ...(parsed.data.note !== undefined ? { note: parsed.data.note ?? null } : {}),
    ...(parsed.data.services !== undefined ? { services: parsed.data.services } : {}),
    ...(parsed.data.availableFuels !== undefined ? { availableFuels: mergedFuels } : {}),
    ...(parsed.data.latitude !== undefined || parsed.data.longitude !== undefined
      ? {
          location: {
            type: 'Point',
            coordinates: [longitude, latitude],
          },
        }
      : {}),
    pinColor: computePinColor(isOpen, mergedFuels),
    updatedAt: now,
  };

  await collection.updateOne({ _id: new ObjectId(id) }, { $set: updateDoc });
  const updated = await collection.findOne({ _id: new ObjectId(id) });

  return c.json({ success: true, data: updated ? serializeStation(updated) : null });
});

app.patch('/api/stations/:id/fuels', async (c) => {
  const id = c.req.param('id');
  if (!ObjectId.isValid(id)) return jsonError('Invalid station id', 400);

  const body = await c.req.json().catch(() => null);
  if (!body) return jsonError('Invalid JSON body', 400);

  const parsed = stationFuelUpdateSchema.safeParse(body);
  if (!parsed.success) return validationError(parsed.error);

  const collection = await getStationsCollection(c.env);
  const existing = await collection.findOne({ _id: new ObjectId(id) });
  if (!existing) return jsonError('Station not found', 404);

  const now = new Date().toISOString();
  const fuels = normalizeFuelDates(parsed.data.availableFuels, now);
  const pinColor = computePinColor(existing.isOpen, fuels);

  await collection.updateOne(
    { _id: new ObjectId(id) },
    {
      $set: {
        availableFuels: fuels,
        pinColor,
        updatedAt: now,
      },
    },
  );

  const updated = await collection.findOne({ _id: new ObjectId(id) });
  return c.json({ success: true, data: updated ? serializeStation(updated) : null });
});

app.delete('/api/stations/:id', async (c) => {
  const id = c.req.param('id');
  if (!ObjectId.isValid(id)) return jsonError('Invalid station id', 400);

  const authToken = c.env.API_AUTH_TOKEN?.trim();
  if (authToken) {
    const header = c.req.header('Authorization')?.replace(/^Bearer\s+/i, '')?.trim();
    if (header !== authToken) return jsonError('Unauthorized', 401);
  }

  const collection = await getStationsCollection(c.env);
  const result = await collection.deleteOne({ _id: new ObjectId(id) });
  if (result.deletedCount === 0) return jsonError('Station not found', 404);

  return c.json({ success: true });
});

app.onError((err) => {
  console.error(err);
  return Response.json(
    {
      success: false,
      error: err instanceof Error ? err.message : 'Internal server error',
    },
    { status: 500 },
  );
});

export default app;

function serializeStation(doc: StationDocument & { _id?: unknown }) {
  return {
    id: doc._id instanceof ObjectId ? doc._id.toHexString() : String(doc._id),
    name: doc.name,
    brand: doc.brand ?? null,
    address: doc.address ?? null,
    province: doc.province ?? null,
    district: doc.district ?? null,
    subdistrict: doc.subdistrict ?? null,
    isOpen: doc.isOpen,
    open24Hours: doc.open24Hours ?? false,
    note: doc.note ?? null,
    services: doc.services ?? [],
    availableFuels: doc.availableFuels ?? [],
    location: {
      latitude: doc.location.coordinates[1],
      longitude: doc.location.coordinates[0],
    },
    pinColor: doc.pinColor,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

function normalizeFuelDates(
  fuels: Array<{ type: StationDocument['availableFuels'][number]['type']; status: StationDocument['availableFuels'][number]['status']; updatedAt?: string }>,
  fallbackDate: string,
) {
  return fuels.map((item) => ({
    type: item.type,
    status: item.status,
    updatedAt: item.updatedAt ?? fallbackDate,
  }));
}

function validationError(error: z.ZodError) {
  return Response.json(
    {
      success: false,
      error: 'Validation failed',
      details: error.flatten(),
    },
    { status: 400 },
  );
}
