# Gas Station Backend on Cloudflare Workers + MongoDB Atlas

This is a serverless backend starter for your gas-station project.

## What this backend supports

- Cloudflare Workers runtime
- MongoDB Atlas connection
- Geospatial station search by map viewport (`bbox`) or center point (`lat`, `lng`, `radiusKm`)
- CRUD for stations
- Fuel availability updates per station
- Pin color logic for your frontend map
- Cloudflare Turnstile verification on station creation
- CORS config for your frontend

## Pin color rules

The backend computes `pinColor` using your rules:

- `blue` = all fuel types sold by that station are available
- `green` = at least one gasoline-family fuel and at least one diesel-family fuel are available
- `yellow` = only one family is available (gasoline family or diesel family)
- `red` = station is open but no fuel is available
- `gray` = station is closed

## API endpoints

### Health

```bash
GET /health
```

### List stations

By viewport:

```bash
GET /api/stations?bbox=100.45,13.70,100.60,13.85
```

By center point:

```bash
GET /api/stations?lat=13.7563&lng=100.5018&radiusKm=10
```

Optional filters:

```bash
GET /api/stations?q=PTT&onlyOpen=true&limit=100
```

### Get station detail

```bash
GET /api/stations/:id
```

### Create station

```bash
POST /api/stations
Content-Type: application/json

{
  "name": "PTT Rama 9",
  "brand": "PTT",
  "address": "Rama 9 Road",
  "province": "Bangkok",
  "district": "Huai Khwang",
  "subdistrict": "Bang Kapi",
  "isOpen": true,
  "open24Hours": true,
  "services": ["toilet", "coffee", "air"],
  "latitude": 13.7563,
  "longitude": 100.5018,
  "availableFuels": [
    { "type": "gasohol_95", "status": "available" },
    { "type": "diesel_b7", "status": "available" },
    { "type": "premium_diesel", "status": "unavailable" }
  ],
  "captchaToken": "<turnstile-token-from-frontend>"
}
```

### Update station

```bash
PATCH /api/stations/:id
```

### Update only fuel statuses

```bash
PATCH /api/stations/:id/fuels
Content-Type: application/json

{
  "availableFuels": [
    { "type": "gasohol_95", "status": "available" },
    { "type": "diesel_b7", "status": "unavailable" }
  ]
}
```

### Delete station

If `API_AUTH_TOKEN` is set, send it as Bearer token.

```bash
DELETE /api/stations/:id
Authorization: Bearer your-token
```

## Supported fuel types

- `gasoline_91`
- `gasoline_95`
- `gasohol_91`
- `gasohol_95`
- `e20`
- `e85`
- `diesel_b7`
- `diesel_b10`
- `diesel_b20`
- `premium_diesel`
- `ev_charge`

## Environment variables

Copy `.dev.vars.example` to `.dev.vars` for local development.

```bash
MONGODB_URI=
MONGODB_DB_NAME=gas_station
MONGODB_COLLECTION_STATIONS=stations
ALLOWED_ORIGIN=http://localhost:3000
TURNSTILE_SECRET_KEY=
REQUIRE_TURNSTILE_ON_CREATE=true
API_AUTH_TOKEN=
```

## Local development

```bash
npm install
cp .dev.vars.example .dev.vars
npm run dev
```

## Deploy

Set secrets:

```bash
npx wrangler secret put MONGODB_URI
npx wrangler secret put TURNSTILE_SECRET_KEY
npx wrangler secret put API_AUTH_TOKEN
```

Deploy:

```bash
npm run deploy
```

## MongoDB Atlas notes

1. Create an Atlas cluster.
2. Add a database user.
3. Allow Cloudflare Workers to connect.
   - For quick testing, many teams temporarily allow `0.0.0.0/0` on Atlas network access.
   - For production, tighten this based on your actual security design.
4. Use the Atlas SRV connection string as `MONGODB_URI`.

## Frontend integration idea

Your map page can call:

- On map move: `GET /api/stations?bbox=minLng,minLat,maxLng,maxLat`
- On station detail open: `GET /api/stations/:id`
- On create dialog submit: `POST /api/stations` with Turnstile token
- On fuel update dialog submit: `PATCH /api/stations/:id/fuels`

## Suggested next step

After this, the next good step is adding:

- simple admin auth
- image upload for station photos using R2
- station opening hours model
- moderation / approval flow before a new station becomes public
