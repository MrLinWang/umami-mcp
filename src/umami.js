import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { parse } from 'dotenv';
import { z } from 'zod';

const credentials = ['UMAMI_URL', 'UMAMI_API_TOKEN', 'UMAMI_TOKEN'];
const defaultEnvFile = new URL('../.env', import.meta.url);

export function isTimezone(value) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function readValues(envFile) {
  if (envFile !== undefined) {
    return parse(readFileSync(envFile));
  }

  if (credentials.some(key => process.env[key] !== undefined)) {
    return process.env;
  }

  try {
    return parse(readFileSync(defaultEnvFile));
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
    return {};
  }
}

function parseApiUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('UMAMI_URL must be an absolute HTTP or HTTPS URL.');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('UMAMI_URL must be an HTTP or HTTPS URL without credentials, a query, or a fragment.');
  }

  return `${url.origin}${url.pathname.replace(/\/+$/, '')}/api`;
}

export function loadConfig() {
  const { values: options } = parseArgs({
    options: { 'env-file': { type: 'string' } },
  });
  const values = readValues(options['env-file']);
  const token = values.UMAMI_API_TOKEN?.trim() || values.UMAMI_TOKEN?.trim();
  if (!values.UMAMI_URL?.trim() || !token) {
    throw new Error('Set UMAMI_URL and UMAMI_API_TOKEN (or UMAMI_TOKEN) using --env-file, environment variables, or the project .env file.');
  }
  if (!/^[\x21-\x7E]+$/.test(token)) {
    throw new Error('The Umami token must be a single token without whitespace.');
  }

  const websiteId = values.UMAMI_WEBSITE_ID?.trim() || undefined;
  if (websiteId && !z.uuid().safeParse(websiteId).success) {
    throw new Error('UMAMI_WEBSITE_ID must be a valid website UUID.');
  }
  const timezone = values.UMAMI_TIMEZONE?.trim() || 'UTC';
  if (!isTimezone(timezone)) {
    throw new Error('UMAMI_TIMEZONE must be an IANA timezone, such as Asia/Shanghai.');
  }

  return { apiUrl: parseApiUrl(values.UMAMI_URL.trim()), token, websiteId, timezone };
}

const statusMessages = {
  400: 'Check the query parameters and the features supported by this Umami version.',
  401: 'Check whether the token is valid and has access to this website or team.',
  403: 'The token does not have access to this resource.',
  404: 'Check the website or session ID and whether the endpoint exists on this Umami instance.',
  429: 'Umami is rate limiting requests. Wait before retrying.',
};

export function createUmamiClient({ apiUrl, token }) {
  return async function get(path, params, signal) {
    const url = new URL(`${apiUrl}${path}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }

    const timeout = AbortSignal.timeout(20_000);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
        redirect: 'manual',
        signal: requestSignal,
      });
    } catch {
      if (requestSignal.aborted) {
        throw new Error(timeout.aborted ? 'The Umami request timed out.' : 'The Umami request was canceled.');
      }
      throw new Error('Could not connect to Umami. Check UMAMI_URL and network access.');
    }

    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      if (response.status >= 300 && response.status < 400) {
        throw new Error('Umami redirected the API request. Set UMAMI_URL to the final instance URL.');
      }
      const detail = statusMessages[response.status];
      throw new Error(`Umami returned HTTP ${response.status}.${detail ? ` ${detail}` : ''}`);
    }

    try {
      const data = await response.json();
      if (data && typeof data === 'object') {
        return data;
      }
    } catch {
      if (requestSignal.aborted) {
        throw new Error(timeout.aborted ? 'The Umami request timed out.' : 'The Umami request was canceled.');
      }
    }
    throw new Error('Umami returned an unexpected response. Check the instance URL and API version.');
  };
}
