type RateLimitName = 'chat' | 'search' | 'upload' | 'computer';

type RateLimitConfig = {
  windowMs: number;
  max: number;
  error: string;
};

type RateLimitBucket = {
  count: number;
  resetAt: number;
};

type RateLimitCheck =
  | {
      allowed: true;
      headers: HeadersInit;
    }
  | {
      allowed: false;
      response: Response;
    };

const RATE_LIMITS: Record<RateLimitName, RateLimitConfig> = {
  chat: {
    windowMs: 60 * 1000,
    max: 10,
    error: 'Rate limit exceeded. Please wait before making more requests.',
  },
  search: {
    windowMs: 60 * 1000,
    max: 10,
    error: 'Search rate limit exceeded. Please wait before searching again.',
  },
  upload: {
    windowMs: 60 * 1000,
    max: 5,
    error: 'Upload rate limit exceeded. Please wait before uploading again.',
  },
  computer: {
    windowMs: 60 * 1000,
    max: 8,
    error: 'Computer mode rate limit exceeded. Please wait before retrying.',
  },
};

const buckets =
  (
    globalThis as {
      __perplexicaRateLimitBuckets?: Map<string, RateLimitBucket>;
    }
  ).__perplexicaRateLimitBuckets || new Map<string, RateLimitBucket>();

if (process.env.NODE_ENV !== 'production') {
  (
    globalThis as {
      __perplexicaRateLimitBuckets?: Map<string, RateLimitBucket>;
    }
  ).__perplexicaRateLimitBuckets = buckets;
}

const getClientIdentifier = (req: Request) => {
  const forwardedFor = req.headers.get('x-forwarded-for');
  if (forwardedFor) {
    return forwardedFor.split(',')[0].trim();
  }

  const realIp = req.headers.get('x-real-ip');
  if (realIp) {
    return realIp.trim();
  }

  return 'unknown';
};

const isLocalDevelopmentRequest = (identifier: string) => {
  if (process.env.NODE_ENV !== 'development') {
    return false;
  }

  return (
    identifier === '127.0.0.1' ||
    identifier === '::1' ||
    identifier === '::ffff:127.0.0.1' ||
    identifier === 'localhost' ||
    identifier === 'unknown'
  );
};

const buildHeaders = (
  config: RateLimitConfig,
  bucket: RateLimitBucket,
): Record<string, string> => {
  const resetSeconds = Math.max(
    0,
    Math.ceil((bucket.resetAt - Date.now()) / 1000),
  );

  return {
    'RateLimit-Limit': String(config.max),
    'RateLimit-Remaining': String(Math.max(0, config.max - bucket.count)),
    'RateLimit-Reset': String(resetSeconds),
  };
};

export const enforceRateLimit = (
  req: Request,
  name: RateLimitName,
): RateLimitCheck => {
  const identifier = getClientIdentifier(req);

  if (isLocalDevelopmentRequest(identifier)) {
    return {
      allowed: true,
      headers: buildHeaders(RATE_LIMITS[name], {
        count: 0,
        resetAt: Date.now() + RATE_LIMITS[name].windowMs,
      }),
    };
  }

  const config = RATE_LIMITS[name];
  const key = `${name}:${identifier}`;
  const now = Date.now();
  const existing = buckets.get(key);

  const bucket =
    !existing || existing.resetAt <= now
      ? {
          count: 0,
          resetAt: now + config.windowMs,
        }
      : existing;

  if (bucket.count >= config.max) {
    const headers = buildHeaders(config, bucket);

    return {
      allowed: false,
      response: Response.json(
        {
          message: config.error,
          retryAfter: headers['RateLimit-Reset'],
        },
        {
          status: 429,
          headers,
        },
      ),
    };
  }

  bucket.count += 1;
  buckets.set(key, bucket);

  return {
    allowed: true,
    headers: buildHeaders(config, bucket),
  };
};

export const getRateLimitStats = () => {
  return Object.fromEntries(
    Object.entries(RATE_LIMITS).map(([name, config]) => [
      name,
      {
        ...config,
        activeBuckets: Array.from(buckets.keys()).filter((key) =>
          key.startsWith(`${name}:`),
        ).length,
      },
    ]),
  );
};
