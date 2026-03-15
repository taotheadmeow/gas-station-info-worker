CREATE TABLE IF NOT EXISTS stations (
  id TEXT PRIMARY KEY,
  last_updated TEXT NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  name TEXT NOT NULL,
  is_open INTEGER NOT NULL CHECK (is_open IN (0, 1)),

  premium_diesel_available INTEGER NULL CHECK (premium_diesel_available IN (0, 1)),
  diesel_available INTEGER NULL CHECK (diesel_available IN (0, 1)),
  b20_available INTEGER NULL CHECK (b20_available IN (0, 1)),
  gasohol_95_e10_available INTEGER NULL CHECK (gasohol_95_e10_available IN (0, 1)),
  gasohol_91_e10_available INTEGER NULL CHECK (gasohol_91_e10_available IN (0, 1)),
  e20_available INTEGER NULL CHECK (e20_available IN (0, 1)),
  gasoline_95_available INTEGER NULL CHECK (gasoline_95_available IN (0, 1)),
  premium_gasohol_available INTEGER NULL CHECK (premium_gasohol_available IN (0, 1)),
  e85_available INTEGER NULL CHECK (e85_available IN (0, 1))
);

CREATE INDEX IF NOT EXISTS idx_stations_last_updated ON stations(last_updated DESC);
CREATE INDEX IF NOT EXISTS idx_stations_lat_lng ON stations(lat, lng);
CREATE INDEX IF NOT EXISTS idx_stations_name ON stations(name);

CREATE INDEX IF NOT EXISTS idx_stations_is_open ON stations(is_open);
CREATE INDEX IF NOT EXISTS idx_stations_diesel_available ON stations(diesel_available);
CREATE INDEX IF NOT EXISTS idx_stations_gasohol_95_e10_available ON stations(gasohol_95_e10_available);