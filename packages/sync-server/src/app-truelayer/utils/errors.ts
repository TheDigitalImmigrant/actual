import createDebug from 'debug';

const debug = createDebug('actual:truelayer:errors');

export class TrueLayerError extends Error {
  error_type: string;
  error_code: string;

  constructor(error_type: string, error_code: string, message?: string) {
    super(message || `TrueLayer error: ${error_type} - ${error_code}`);
    this.name = 'TrueLayerError';
    this.error_type = error_type;
    this.error_code = error_code;
  }
}

// Maps a TrueLayer HTTP error onto a TrueLayerError with a machine-readable
// error_code. INVALID_ACCESS_TOKEN is the signal the router turns into
// ITEM_LOGIN_REQUIRED, prompting the user to re-link once the 90-day open
// banking consent (or the refresh token) has expired.
export function handleTrueLayerError(
  statusCode: number,
  body: unknown,
): TrueLayerError {
  const bodyStr =
    typeof body === 'string' ? body : JSON.stringify(body ?? 'unknown');
  debug('TrueLayer API error: status=%d body=%s', statusCode, bodyStr);

  const parsed: Record<string, unknown> =
    typeof body === 'object' && body !== null
      ? Object.fromEntries(Object.entries(body))
      : {};
  // TrueLayer error bodies use `error` (a code) and `error_description`.
  const errorCode =
    typeof parsed.error === 'string' ? parsed.error.toLowerCase() : '';
  const message =
    typeof parsed.error_description === 'string'
      ? parsed.error_description
      : typeof parsed.error === 'string'
        ? parsed.error
        : bodyStr;

  // Expired/invalid consent or refresh token → user must re-authenticate.
  if (
    statusCode === 401 ||
    statusCode === 403 ||
    errorCode === 'invalid_grant' ||
    errorCode === 'invalid_token' ||
    errorCode === 'access_denied'
  ) {
    return new TrueLayerError(message, 'INVALID_ACCESS_TOKEN', message);
  }

  if (statusCode === 429 || errorCode === 'rate_limit_exceeded') {
    return new TrueLayerError(message, 'RATE_LIMIT_EXCEEDED', message);
  }

  if (statusCode === 404) {
    return new TrueLayerError(message, 'NOT_FOUND', message);
  }

  if (statusCode >= 400 && statusCode < 500) {
    return new TrueLayerError(message, 'INVALID_INPUT', message);
  }

  return new TrueLayerError(message, 'INTERNAL_ERROR', message);
}
