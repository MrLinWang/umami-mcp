#!/usr/bin/env node
import { createRequire } from 'node:module';
import { Temporal } from '@js-temporal/polyfill';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createUmamiClient, isTimezone, loadConfig } from './umami.js';

const { version } = createRequire(import.meta.url)('../package.json');

const websiteInput = {
  websiteId: z.uuid().optional().describe('Website ID. Defaults to UMAMI_WEBSITE_ID when configured.'),
};

const timestamp = z.union([z.iso.datetime({ offset: true }), z.number().int().min(0).max(8_640_000_000_000_000)]);
const dateInput = {
  startAt: timestamp.optional().describe('Range start, ISO 8601 with offset or Unix milliseconds. Supply with endAt.'),
  endAt: timestamp.optional().describe('Range end, ISO 8601 with offset or Unix milliseconds. Supply with startAt.'),
  period: z.enum(['today', '24h', '7d', '30d', '0month']).optional()
    .describe('Relative range ending now. 0month means this calendar month. Default: 7d. Use in place of startAt and endAt.'),
  timezone: z.string().min(1).max(100).refine(isTimezone, 'Expected an IANA timezone.').optional()
    .describe('IANA timezone for calendar periods and time series. Defaults to UMAMI_TIMEZONE or UTC.'),
};

const pageInput = {
  page: z.number().int().min(1).default(1).describe('Page number, starting at 1.'),
  pageSize: z.number().int().min(1).max(100).default(25).describe('Rows per page, maximum 100.'),
};

const textFilter = z.string().min(1).max(500).optional();
const filtersInput = z.strictObject({
  country: z.string().regex(/^[A-Z]{2}$/).optional().describe('Uppercase country code, for example SG.'),
  region: textFilter,
  city: textFilter,
  browser: textFilter.describe('Umami browser key, for example chrome or edge-chromium.'),
  os: textFilter.describe('Umami OS label, for example Windows 10 or Mac OS.'),
  device: textFilter.describe('Umami device label, for example laptop or mobile.'),
  language: textFilter,
  hostname: textFilter,
  path: textFilter,
  referrer: textFilter,
  event: textFilter,
  utmSource: textFilter,
  utmMedium: textFilter,
  utmCampaign: textFilter,
}).optional().describe('Apply all supplied filters to the report.');

const metricTypes = [
  'path', 'entry', 'exit', 'title', 'query', 'hostname', 'referrer', 'domain', 'channel',
  'event', 'tag', 'browser', 'os', 'device', 'screen', 'language', 'country', 'region',
  'city', 'utmSource', 'utmMedium', 'utmCampaign', 'utmContent', 'utmTerm',
];

const compare = z.enum(['prev', 'yoy']).optional().describe('Compare with the previous period or the same period last year.');
const rollingHours = { '24h': 24, '7d': 168, '30d': 720 };
const activityLimit = 500;

function toMilliseconds(value) {
  return typeof value === 'number' ? value : Temporal.Instant.from(value).epochMilliseconds;
}

function resolveRange({ startAt, endAt, period, timezone }) {
  if (startAt !== undefined || endAt !== undefined) {
    if (startAt === undefined || endAt === undefined || period !== undefined) {
      throw new Error('Provide both startAt and endAt, or use period.');
    }
    const start = toMilliseconds(startAt);
    const end = toMilliseconds(endAt);
    if (start >= end) {
      throw new Error('startAt must be before endAt.');
    }
    return { startAt: start, endAt: end, timezone };
  }

  const now = Temporal.Now.zonedDateTimeISO(timezone);
  const selected = period ?? '7d';
  const start = selected === 'today'
    ? now.startOfDay()
    : selected === '0month'
      ? now.with({ day: 1 }).startOfDay()
      : now.subtract({ hours: rollingHours[selected] });
  return { startAt: start.epochMilliseconds, endAt: now.epochMilliseconds, timezone };
}

function slicePage(data, page, pageSize) {
  const offset = (page - 1) * pageSize;
  return { data: data.slice(offset, offset + pageSize), count: data.length, page, pageSize };
}

function selectPage(result, pagination, selectRow) {
  const { page, pageSize } = pagination;
  const source = Array.isArray(result) ? slicePage(result, page, pageSize) : result;
  if (!Array.isArray(source.data)) {
    throw new Error('Umami returned an unexpected list response.');
  }
  return {
    data: source.data.map(selectRow),
    count: source.count,
    page: source.page ?? page,
    pageSize: source.pageSize ?? pageSize,
  };
}

function createServer(config) {
  const server = new McpServer({ name: 'umami-mcp', version }, {
    instructions: 'Read analytics from the configured Umami instance. Use list_teams and list_websites to discover team websites. Reuse the returned range when paging or opening a session timeline. In session rows, visits counts distinct visits, views counts pageviews, and events counts custom events.',
  });
  const get = createUmamiClient(config);

  function requireWebsite(websiteId) {
    const selected = websiteId ?? config.websiteId;
    if (!selected) {
      throw new Error('Provide a websiteId from list_websites or configure UMAMI_WEBSITE_ID.');
    }
    return selected;
  }

  function register(name, description, input, handler) {
    server.registerTool(name, {
      description,
      inputSchema: z.strictObject(input),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    }, async (args, { signal }) => {
      const result = await handler(args, signal);
      return {
        structuredContent: result,
        content: [{ type: 'text', text: JSON.stringify(result) }],
      };
    });
  }

  function registerReport(name, description, endpoint, extraInput = {}) {
    register(name, description, { ...websiteInput, ...dateInput, filters: filtersInput, ...extraInput },
      async ({ websiteId, startAt, endAt, period, timezone = config.timezone, filters = {}, ...params }, signal) => {
        const id = requireWebsite(websiteId);
        const range = resolveRange({ startAt, endAt, period, timezone });
        const result = await get(`/websites/${id}/${endpoint}`, { ...range, ...filters, ...params }, signal);
        const data = Array.isArray(result) ? { data: result } : result;
        return { ...data, websiteId: id, range, filters };
      });
  }

  register('list_teams', 'List Umami teams accessible to the configured token. Use the team ID with list_websites.',
    pageInput, async (pagination, signal) => {
      const result = await get('/teams', pagination, signal);
      return selectPage(result, pagination, ({ id, name }) => ({ id, name }));
    });

  register('list_websites', 'List accessible websites. For a team website, pass teamId from list_teams.',
    { ...pageInput, teamId: z.uuid().optional().describe('Restrict the list to this team.') },
    async ({ teamId, ...pagination }, signal) => {
      const result = teamId
        ? await get(`/teams/${teamId}/websites`, pagination, signal)
        : await get('/websites', { ...pagination, includeTeams: true }, signal);
      const page = selectPage(result, pagination, ({ id, name, domain, teamId: websiteTeamId }) => ({
        id, name, domain, teamId: websiteTeamId ?? teamId ?? null,
      }));
      return config.websiteId ? { ...page, defaultWebsiteId: config.websiteId } : page;
    });

  registerReport('get_website_stats', 'Get pageviews, visitors, visits, bounces and total visit time.',
    'stats', { compare });

  registerReport('get_website_traffic', 'Get pageview and session counts grouped by time.',
    'pageviews', { unit: z.enum(['minute', 'hour', 'day', 'month', 'year']).default('day'), compare });

  registerReport('get_website_metrics', 'Get ranked analytics by page, referrer, browser, country, event, or another dimension.',
    'metrics', {
      type: z.enum(metricTypes),
      limit: z.number().int().min(1).max(100).default(20),
      offset: z.number().int().min(0).default(0),
    });

  registerReport('get_events', 'List tracked pageviews and custom events, newest first. Use sessionId to look up the visitor timeline.',
    'events', { ...pageInput, eventType: z.union([z.literal(1), z.literal(2)]).optional().describe('1 for pageviews, 2 for custom events.') });

  registerReport('get_sessions', 'List visitor sessions with device and geography, visit count, pageview count, custom event count, and timestamps. To find low-frequency visitors, page through the results and select rows by visits.',
    'sessions', pageInput);

  register('get_session_activity', 'Get a paginated timeline for a visitor session, with paths, referrers, timestamps and visit IDs. Umami may include activity from linked visitor IDs.',
    { ...websiteInput, ...dateInput, ...pageInput, sessionId: z.uuid() },
    async ({ websiteId, sessionId, startAt, endAt, period, timezone = config.timezone, page, pageSize }, signal) => {
      const id = requireWebsite(websiteId);
      const range = resolveRange({ startAt, endAt, period, timezone });
      const result = await get(`/websites/${id}/sessions/${sessionId}/activity`, {
        startAt: range.startAt, endAt: range.endAt,
      }, signal);
      if (!Array.isArray(result)) {
        throw new Error('Umami returned an unexpected session activity response.');
      }

      const activity = result.filter(({ createdAt }) => {
        const timestamp = Date.parse(createdAt);
        return timestamp >= range.startAt && timestamp <= range.endAt;
      });
      return { websiteId: id, sessionId, range, ...slicePage(activity, page, pageSize), isCapped: result.length >= activityLimit };
    });

  register('get_realtime', 'Get the Umami realtime snapshot for the last 30 minutes.',
    websiteInput, async ({ websiteId }, signal) => {
      const id = requireWebsite(websiteId);
      return { websiteId: id, data: await get(`/realtime/${id}`, {}, signal) };
    });

  return server;
}

try {
  await createServer(loadConfig()).connect(new StdioServerTransport());
} catch (error) {
  console.error(`umami-mcp: ${error.message}`);
  process.exitCode = 1;
}
