import type { FuelAvailabilityItem } from './types';

const GASOLINE_FAMILY = new Set([
  'gasoline_91',
  'gasoline_95',
  'gasohol_91',
  'gasohol_95',
  'e20',
  'e85',
]);

const DIESEL_FAMILY = new Set([
  'diesel_b7',
  'diesel_b10',
  'diesel_b20',
  'premium_diesel',
]);

export function jsonError(message: string, status = 400) {
  return Response.json({ success: false, error: message }, { status });
}

export function computePinColor(
  isOpen: boolean,
  availableFuels: FuelAvailabilityItem[],
): 'blue' | 'green' | 'yellow' | 'red' | 'gray' {
  if (!isOpen) return 'gray';
  if (availableFuels.length === 0) return 'red';

  const known = availableFuels.filter((item) => item.status === 'available');
  if (known.length === 0) return 'red';

  const allKnownAreAvailable = availableFuels.every((item) => item.status === 'available');
  if (allKnownAreAvailable) return 'blue';

  const hasGasoline = known.some((item) => GASOLINE_FAMILY.has(item.type));
  const hasDiesel = known.some((item) => DIESEL_FAMILY.has(item.type));

  if (hasGasoline && hasDiesel) return 'green';
  if (hasGasoline || hasDiesel) return 'yellow';

  return 'red';
}

export function parseBoolean(input: string | undefined, fallback = false) {
  if (input == null) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(input.toLowerCase());
}

export function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}
