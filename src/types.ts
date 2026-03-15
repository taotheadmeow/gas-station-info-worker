export interface Env {
  MONGODB_URI: string;
  MONGODB_DB_NAME: string;
  MONGODB_COLLECTION_STATIONS: string;
  ALLOWED_ORIGIN?: string;
  TURNSTILE_SECRET_KEY?: string;
  REQUIRE_TURNSTILE_ON_CREATE?: string;
  API_AUTH_TOKEN?: string;
}

export type FuelType =
  | 'gasoline_91'
  | 'gasoline_95'
  | 'gasohol_91'
  | 'gasohol_95'
  | 'e20'
  | 'e85'
  | 'diesel_b7'
  | 'diesel_b10'
  | 'diesel_b20'
  | 'premium_diesel'
  | 'ev_charge';

export type FuelStatus = 'available' | 'unavailable' | 'unknown';

export interface FuelAvailabilityItem {
  type: FuelType;
  status: FuelStatus;
  updatedAt?: string;
}

export interface StationDocument {
  _id?: unknown;
  name: string;
  brand?: string | null;
  address?: string | null;
  province?: string | null;
  district?: string | null;
  subdistrict?: string | null;
  isOpen: boolean;
  open24Hours?: boolean;
  note?: string | null;
  services?: string[];
  availableFuels: FuelAvailabilityItem[];
  location: {
    type: 'Point';
    coordinates: [number, number];
  };
  pinColor: 'blue' | 'green' | 'yellow' | 'red' | 'gray';
  createdAt: string;
  updatedAt: string;
}
