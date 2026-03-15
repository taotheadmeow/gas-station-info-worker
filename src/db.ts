import { MongoClient, ServerApiVersion } from 'mongodb';
import type { Env, StationDocument } from './types';

let client: MongoClient | null = null;
let indexesEnsured = false;

function getClient(uri: string) {
  if (!client) {
    client = new MongoClient(uri, {
      serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
      },
      maxPoolSize: 5,
      minPoolSize: 0,
      retryReads: true,
      retryWrites: true,
    });
  }
  return client;
}

export async function getStationsCollection(env: Env) {
  if (!env.MONGODB_URI) {
    throw new Error('Missing MONGODB_URI');
  }

  const mongoClient = getClient(env.MONGODB_URI);
  await mongoClient.connect();

  const db = mongoClient.db(env.MONGODB_DB_NAME || 'gas_station');
  const collection = db.collection<StationDocument>(env.MONGODB_COLLECTION_STATIONS || 'stations');

  if (!indexesEnsured) {
    await Promise.all([
      collection.createIndex({ location: '2dsphere' }),
      collection.createIndex({ name: 'text', brand: 'text', address: 'text' }),
      collection.createIndex({ updatedAt: -1 }),
    ]);
    indexesEnsured = true;
  }

  return collection;
}
