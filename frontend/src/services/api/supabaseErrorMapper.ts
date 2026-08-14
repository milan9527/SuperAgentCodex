import type { AuthError, PostgrestError } from '@supabase/supabase-js';
import {
  ServiceError,
  handleFetchError,
  httpStatusToErrorCode,
  type ServiceErrorCode,
} from '@/utils/errorHandling';

export const ERROR_CODE_MAPS: {
  postgres: Record<string, ServiceErrorCode>;
  postgrest: Record<string, ServiceErrorCode>;
} = {
  postgres: {
    '22001': 'VALIDATION_ERROR',
    '22P02': 'VALIDATION_ERROR',
    '23502': 'VALIDATION_ERROR',
    '23503': 'VALIDATION_ERROR',
    '23505': 'VALIDATION_ERROR',
    '42501': 'FORBIDDEN',
  },
  postgrest: {
    PGRST000: 'NETWORK_ERROR',
    PGRST100: 'VALIDATION_ERROR',
    PGRST116: 'NOT_FOUND',
    PGRST301: 'UNAUTHORIZED',
  },
};

function withContext(message: string, context?: string): string {
  return context ? `${context}: ${message}` : message;
}

export function mapPostgrestError(error: PostgrestError, context?: string): ServiceError {
  const postgresCode = Object.prototype.hasOwnProperty.call(ERROR_CODE_MAPS.postgres, error.code)
    ? ERROR_CODE_MAPS.postgres[error.code]
    : undefined;
  const postgrestCode = Object.prototype.hasOwnProperty.call(ERROR_CODE_MAPS.postgrest, error.code)
    ? ERROR_CODE_MAPS.postgrest[error.code]
    : undefined;
  const code = postgresCode ?? postgrestCode ?? 'UNKNOWN';

  return new ServiceError(withContext(error.message, context), code, undefined, {
    originalCode: error.code,
    details: error.details,
    hint: error.hint,
  });
}

export function mapAuthError(error: AuthError, context?: string): ServiceError {
  const message = error.message || 'Authentication failed';
  const normalized = message.toLowerCase();
  const code = normalized.includes('rate limit') || normalized.includes('too many requests')
    ? 'RATE_LIMITED'
    : httpStatusToErrorCode(error.status ?? 401);

  return new ServiceError(withContext(message, context), code, error.status);
}

export function mapStorageError(
  error: { message?: string; name?: string },
  context?: string,
): ServiceError {
  const message = error.message || 'Storage operation failed';
  const normalized = message.toLowerCase();
  let code: ServiceErrorCode = 'UNKNOWN';

  if (normalized.includes('not found') || normalized.includes('does not exist')) {
    code = 'NOT_FOUND';
  } else if (
    normalized.includes('permission')
    || normalized.includes('not authorized')
    || normalized.includes('policy')
  ) {
    code = 'FORBIDDEN';
  } else if (
    normalized.includes('too large')
    || normalized.includes('size limit')
    || normalized.includes('invalid')
  ) {
    code = 'VALIDATION_ERROR';
  }

  return new ServiceError(withContext(message, context), code);
}

export function mapSupabaseError(error: unknown, context?: string): ServiceError {
  if (error instanceof ServiceError) return error;
  if (error instanceof TypeError && error.message.toLowerCase().includes('fetch')) {
    return handleFetchError(error, context);
  }

  if (error && typeof error === 'object') {
    const candidate = error as {
      code?: unknown;
      status?: unknown;
      message?: unknown;
      name?: unknown;
    };
    if (typeof candidate.code === 'string') {
      return mapPostgrestError(error as PostgrestError, context);
    }
    if (candidate.name === 'AuthError' || typeof candidate.status === 'number') {
      return mapAuthError(error as AuthError, context);
    }
    if (candidate.name === 'StorageError') {
      return mapStorageError(error as { message?: string; name?: string }, context);
    }
  }

  const message = error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : 'Unknown service error';
  return new ServiceError(withContext(message, context), 'UNKNOWN');
}
