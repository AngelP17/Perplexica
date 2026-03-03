import { getSearxngURL } from './config/serverRegistry';

interface SearxngSearchOptions {
  categories?: string[];
  engines?: string[];
  language?: string;
  pageno?: number;
}

interface SearxngSearchResult {
  title: string;
  url: string;
  img_src?: string;
  thumbnail_src?: string;
  thumbnail?: string;
  content?: string;
  author?: string;
  iframe_src?: string;
}

export class SearxngError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SearxngError';
  }
}

export const isSearxngError = (error: unknown): error is SearxngError =>
  error instanceof SearxngError;

const getValidatedSearxngURL = () => {
  const configuredURL = getSearxngURL().trim();

  if (!configuredURL) {
    throw new SearxngError(
      'SearXNG URL is not configured. Set it in Settings > Search or SEARXNG_API_URL.',
    );
  }

  try {
    return new URL(configuredURL);
  } catch (error) {
    throw new SearxngError(`SearXNG URL is invalid: ${configuredURL}`, {
      cause: error,
    });
  }
};

export const searchSearxng = async (
  query: string,
  opts?: SearxngSearchOptions,
) => {
  const searxngURL = getValidatedSearxngURL();
  const baseURL = searxngURL.toString().replace(/\/$/, '');
  const url = new URL(`${baseURL}/search`);

  url.searchParams.set('format', 'json');
  url.searchParams.append('q', query);

  if (opts) {
    Object.keys(opts).forEach((key) => {
      const value = opts[key as keyof SearxngSearchOptions];

      if (Array.isArray(value)) {
        url.searchParams.append(key, value.join(','));
        return;
      }

      url.searchParams.append(key, value as string);
    });
  }

  let res: Response;

  try {
    res = await fetch(url, {
      headers: {
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(10000),
    });
  } catch (error) {
    throw new SearxngError(
      `Could not reach SearXNG at ${searxngURL.toString()}. Start the service or update the configured URL.`,
      { cause: error },
    );
  }

  if (!res.ok) {
    throw new SearxngError(
      `SearXNG request failed with status ${res.status} at ${searxngURL.toString()}.`,
    );
  }

  let data: {
    results?: SearxngSearchResult[];
    suggestions?: string[];
  };

  try {
    data = await res.json();
  } catch (error) {
    throw new SearxngError(
      `SearXNG returned an invalid JSON response from ${searxngURL.toString()}.`,
      { cause: error },
    );
  }

  return {
    results: Array.isArray(data.results) ? data.results : [],
    suggestions: Array.isArray(data.suggestions) ? data.suggestions : [],
  };
};
