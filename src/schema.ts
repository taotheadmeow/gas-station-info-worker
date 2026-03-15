import { z } from 'zod';

const fuelTypes = [
  'gasoline_91',
  'gasoline_95',
  'gasohol_91',
  'gasohol_95',
  'e20',
  'e85',
  'diesel_b7',
  'diesel_b10',
  'diesel_b20',
  'premium_diesel',
  'ev_charge',
] as const;

const fuelStatus = ['available', 'unavailable', 'unknown'] as const;

export const fuelAvailabilitySchema = z.object({
  type: z.enum(fuelTypes),
  status: z.enum(fuelStatus),
  updatedAt: z.string().datetime().optional(),
});

export const stationCreateSchema = z.object({
  name: z.string().min(1).max(200),
  brand: z.string().max(120).optional().nullable(),
  address: z.string().max(500).optional().nullable(),
  province: z.string().max(120).optional().nullable(),
  district: z.string().max(120).optional().nullable(),
  subdistrict: z.string().max(120).optional().nullable(),
  isOpen: z.boolean().default(true),
  open24Hours: z.boolean().optional().default(false),
  note: z.string().max(1000).optional().nullable(),
  services: z.array(z.string().max(100)).max(50).optional().default([]),
  availableFuels: z.array(fuelAvailabilitySchema).max(50).default([]),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  captchaToken: z.string().min(1).optional(),
});

export const stationUpdateSchema = stationCreateSchema.partial().extend({
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
});

export const stationFuelUpdateSchema = z.object({
  availableFuels: z.array(fuelAvailabilitySchema).min(0).max(50),
});

export type StationCreateInput = z.infer<typeof stationCreateSchema>;
export type StationUpdateInput = z.infer<typeof stationUpdateSchema>;
export type StationFuelUpdateInput = z.infer<typeof stationFuelUpdateSchema>;
