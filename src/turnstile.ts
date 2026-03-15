import type { Env } from './types';

interface TurnstileResponse {
  success: boolean;
  'error-codes'?: string[];
}

export async function verifyTurnstileOrThrow(
  env: Env,
  token: string | undefined,
  ip?: string | null,
): Promise<void> {
  const requireCaptcha = (env.REQUIRE_TURNSTILE_ON_CREATE || 'true').toLowerCase() === 'true';
  if (!requireCaptcha) return;

  if (!env.TURNSTILE_SECRET_KEY) {
    throw new Error('TURNSTILE_SECRET_KEY is required when REQUIRE_TURNSTILE_ON_CREATE=true');
  }

  if (!token) {
    throw new Error('Missing captcha token');
  }

  const formData = new FormData();
  formData.append('secret', env.TURNSTILE_SECRET_KEY);
  formData.append('response', token);
  if (ip) formData.append('remoteip', ip);

  const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    body: formData,
  });

  if (!response.ok) {
    throw new Error(`Turnstile verify failed: ${response.status}`);
  }

  const result = (await response.json()) as TurnstileResponse;
  if (!result.success) {
    throw new Error(`Captcha verification failed${result['error-codes']?.length ? `: ${result['error-codes'].join(', ')}` : ''}`);
  }
}
