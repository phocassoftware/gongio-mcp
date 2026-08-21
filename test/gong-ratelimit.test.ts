import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	envNumber,
	formatRetryWait,
	GongClient,
	GongRateLimitError,
	parseRetryAfterMs,
	RateLimiter,
	requestPath,
} from '../src/gong.js';
import type { CallDetailsResponse } from '../src/schemas.js';

/**
 * Build a mock fetch Response good enough for GongClient.
 * `status` drives the retry logic; `body` is returned by json().
 */
function mockResponse(opts: {
	status?: number;
	body?: unknown;
	retryAfter?: string;
}): Response {
	const status = opts.status ?? 200;
	return {
		ok: status >= 200 && status < 300,
		status,
		statusText: status === 429 ? 'Too Many Requests' : 'OK',
		headers: {
			get: (name: string) =>
				name.toLowerCase() === 'retry-after' ? (opts.retryAfter ?? null) : null,
		},
		json: async () => opts.body,
		text: async () => (opts.body ? JSON.stringify(opts.body) : ''),
	} as unknown as Response;
}

const EMPTY_CALLS: CallDetailsResponse = {
	requestId: 'test',
	records: { totalRecords: 0, currentPageSize: 0, currentPageNumber: 1 },
	calls: [],
};

describe('envNumber', () => {
	it('falls back when unset or empty (envsubst renders unset as "")', () => {
		expect(envNumber(undefined, 5, 0, 20)).toBe(5);
		expect(envNumber('', 5, 0, 20)).toBe(5);
	});
	it('falls back on non-numeric values instead of returning NaN', () => {
		// The bug this guards: Number("off") === NaN would make
		// `attempt >= maxRetries` always false -> unbounded 429 retry loop.
		expect(envNumber('off', 5, 0, 20)).toBe(5);
		expect(Number.isNaN(envNumber('off', 5, 0, 20))).toBe(false);
	});
	it('parses and clamps to [min, max]', () => {
		expect(envNumber('3', 5, 0, 20)).toBe(3);
		expect(envNumber('999', 5, 0, 20)).toBe(20); // clamp high
		expect(envNumber('-1', 5, 0, 20)).toBe(0); // clamp low
		expect(envNumber('0', 5, 0, 20)).toBe(0); // explicit 0 honoured
	});
});

describe('parseRetryAfterMs', () => {
	it('parses delta-seconds', () => {
		expect(parseRetryAfterMs('2')).toBe(2000);
	});
	it('parses an HTTP-date relative to now', () => {
		const now = () => 1_000_000;
		// 5s in the future
		const future = new Date(1_005_000).toUTCString();
		expect(parseRetryAfterMs(future, now)).toBe(5000);
	});
	it('returns undefined for missing/garbage headers', () => {
		expect(parseRetryAfterMs(null)).toBeUndefined();
		expect(parseRetryAfterMs('not-a-date')).toBeUndefined();
	});
});

describe('formatRetryWait', () => {
	it('keeps seconds for short waits', () => {
		expect(formatRetryWait(2000)).toBe('about 2 seconds');
		expect(formatRetryWait(59_000)).toBe('about 59 seconds');
		// Math.round would give 0 here; the clamp to a 1s minimum keeps the
		// message from reading "about 0 seconds".
		expect(formatRetryWait(1)).toBe('about a second');
	});
	it('switches to minutes, singular at one', () => {
		expect(formatRetryWait(60_000)).toBe('about a minute');
		expect(formatRetryWait(15 * 60_000)).toBe('about 15 minutes');
	});
	it('switches to hours and drops sub-5-minute noise', () => {
		expect(formatRetryWait(3600_000)).toBe('about an hour');
		expect(formatRetryWait(3720_000)).toBe('about an hour'); // 62m -> 2m rest, dropped
		expect(formatRetryWait(2 * 3600_000)).toBe('about 2 hours');
	});
	it('renders the wait seen in production (4808s) in words', () => {
		// The message that prompted this: "wait about 4808 seconds".
		expect(formatRetryWait(4_808_000)).toBe('about an hour and 20 minutes');
	});
});

describe('GongRateLimitError message', () => {
	it('tells the caller to narrow the request when the wait is short', () => {
		const err = new GongRateLimitError(30_000);
		expect(err.message).toContain('about 30 seconds');
		expect(err.message).toMatch(/narrow your request/);
		expect(err.message).toMatch(/contact IT/);
	});

	it('says narrowing will not help once the allowance is spent', () => {
		// A long Retry-After is the daily allowance, not burst pacing: retrying
		// variations just spends more requests. Advice has to flip.
		const err = new GongRateLimitError(4_808_000);
		expect(err.message).toContain('about an hour and 20 minutes');
		expect(err.message).toMatch(/shared across everyone here/);
		expect(err.message).toMatch(
			/retrying or narrowing this request won't get through/,
		);
		expect(err.message).toMatch(/contact IT/);
		// Still no mechanics, and no raw seconds count.
		expect(err.message).not.toMatch(/company-wide|429|10,?000|seconds/);
	});

	it('falls back to a vague wait when Gong sends no Retry-After', () => {
		const err = new GongRateLimitError();
		expect(err.message).toMatch(/wait a minute and try again/);
		expect(err.message).toMatch(/narrow your request/);
	});
});

describe('requestPath', () => {
	it('keeps the path and drops the opaque cursor query', () => {
		expect(
			requestPath('https://api.gong.io/v2/calls?cursor=abc123&limit=100'),
		).toBe('/v2/calls');
	});
	it('falls back to the raw string when the URL will not parse', () => {
		expect(requestPath('/v2/calls')).toBe('/v2/calls');
	});
});

describe('RateLimiter', () => {
	it('spaces request starts by minIntervalMs and never sleeps on the first', async () => {
		const sleeps: number[] = [];
		const sleep = async (ms: number) => {
			sleeps.push(ms);
		};
		// Frozen clock isolates spacing from wall-clock drift.
		const limiter = new RateLimiter(400, () => 1000, sleep);

		await limiter.acquire(); // slot 1000 -> wait 0 (no sleep)
		await limiter.acquire(); // slot 1400 -> wait 400
		await limiter.acquire(); // slot 1800 -> wait 800

		expect(sleeps).toEqual([400, 800]);
	});

	it('is a no-op when minIntervalMs <= 0 (rate limiting disabled)', async () => {
		const sleep = vi.fn();
		const limiter = new RateLimiter(0, () => 1000, sleep);
		await limiter.acquire();
		await limiter.acquire();
		expect(sleep).not.toHaveBeenCalled();
	});
});

describe('GongClient 429 handling', () => {
	let fetchMock: ReturnType<typeof vi.fn>;
	let sleeps: number[];

	beforeEach(() => {
		fetchMock = vi.fn();
		global.fetch = fetchMock;
		sleeps = [];
	});
	afterEach(() => vi.restoreAllMocks());

	function makeClient(maxRetries = 5) {
		return new GongClient(
			{ accessKey: 'k', accessKeySecret: 's' },
			{
				maxRps: 0, // disable pacing; we assert retry back-off only
				maxRetries,
				baseBackoffMs: 500,
				now: () => 0,
				sleep: async (ms) => {
					sleeps.push(ms);
				},
			},
		);
	}

	it('retries a 429 then succeeds', async () => {
		fetchMock
			.mockResolvedValueOnce(mockResponse({ status: 429 }))
			.mockResolvedValueOnce(mockResponse({ status: 200, body: EMPTY_CALLS }));

		const result = await makeClient().searchCalls({});

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(result.calls).toEqual([]);
		// One back-off between the two attempts (attempt 0 => 500ms base).
		expect(sleeps).toHaveLength(1);
		expect(sleeps[0]).toBeGreaterThanOrEqual(500); // 500 + jitter
	});

	it('honours Retry-After over exponential back-off', async () => {
		fetchMock
			.mockResolvedValueOnce(mockResponse({ status: 429, retryAfter: '2' }))
			.mockResolvedValueOnce(mockResponse({ status: 200, body: EMPTY_CALLS }));

		await makeClient().searchCalls({});

		expect(sleeps).toEqual([2000]); // exact, no jitter when Retry-After present
	});

	it('throws a clear GongRateLimitError once retries are exhausted', async () => {
		fetchMock.mockResolvedValue(
			mockResponse({ status: 429, body: { errors: ['rate limit'] } }),
		);

		const err = await makeClient(1)
			.searchCalls({})
			.catch((e) => e);
		expect(err).toBeInstanceOf(GongRateLimitError);
		// Plain, business-user reason — no quota mechanics, not the raw 429 body.
		expect(err.message).toMatch(/temporarily rate-limiting/i);
		expect(err.message).toMatch(/try again/i);
		expect(err.message).toMatch(/contact IT/);
		expect(err.message).not.toMatch(/company-wide|429|10,000/);
		// attempt 0 + 1 retry = 2 calls.
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it('fails fast (no sleep) when Retry-After exceeds the budget', async () => {
		fetchMock.mockResolvedValue(
			mockResponse({ status: 429, retryAfter: '60' }),
		);
		const client = new GongClient(
			{ accessKey: 'k', accessKeySecret: 's' },
			{
				maxRps: 0,
				maxRetries: 5,
				maxRetryMs: 20_000, // 20s budget; Gong asked for 60s -> give up now
				now: () => 0,
				sleep: async (ms) => {
					sleeps.push(ms);
				},
			},
		);

		const err = await client.searchCalls({}).catch((e) => e);
		expect(err).toBeInstanceOf(GongRateLimitError);
		expect(err.message).toMatch(/wait about a minute/); // Retry-After, in words
		expect(fetchMock).toHaveBeenCalledTimes(1); // did not retry
		expect(sleeps).toEqual([]); // never slept into the 60s
	});

	it('logs every 429 retry to stderr with path, attempt and wait', async () => {
		// The only trace throttling leaves: a retried 429 succeeds silently, and
		// the container's middleware logs the HTTP 200 that carries a tool error.
		fetchMock
			.mockResolvedValueOnce(mockResponse({ status: 429, retryAfter: '2' }))
			.mockResolvedValueOnce(mockResponse({ status: 200, body: EMPTY_CALLS }));
		const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});

		await makeClient().searchCalls({});

		expect(stderr).toHaveBeenCalledTimes(1);
		const line = stderr.mock.calls[0]?.[0] as string;
		expect(line).toContain('gong 429 retrying:');
		expect(line).toContain('path=/v2/calls/extensive');
		expect(line).toContain('attempt=1');
		expect(line).toContain('waitMs=2000');
		expect(line).toContain('retryAfterMs=2000');
	});

	it('logs the give-up with the reason it stopped', async () => {
		fetchMock.mockResolvedValue(mockResponse({ status: 429 }));
		const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});

		await makeClient(1)
			.searchCalls({})
			.catch(() => undefined);

		const lines = stderr.mock.calls.map((c) => c[0] as string);
		// One retry line, then the give-up line naming the bound that ended it.
		expect(lines.filter((l) => l.includes('gong 429 retrying:'))).toHaveLength(
			1,
		);
		const gaveUp = lines.find((l) => l.includes('gong 429 gave up:'));
		expect(gaveUp).toBeDefined();
		expect(gaveUp).toContain('attempts=2');
		expect(gaveUp).toContain('reason=retries-exhausted');
	});

	it('labels a give-up forced by the wall-clock budget', async () => {
		fetchMock.mockResolvedValue(
			mockResponse({ status: 429, retryAfter: '60' }),
		);
		const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
		const client = new GongClient(
			{ accessKey: 'k', accessKeySecret: 's' },
			{ maxRps: 0, maxRetries: 5, maxRetryMs: 20_000, now: () => 0 },
		);

		await client.searchCalls({}).catch(() => undefined);

		const gaveUp = stderr.mock.calls
			.map((c) => c[0] as string)
			.find((l) => l.includes('gong 429 gave up:'));
		expect(gaveUp).toContain('reason=budget-exhausted');
		expect(gaveUp).toContain('retryAfterMs=60000');
	});

	it('stops retrying once the wall-clock budget is spent (not just maxRetries)', async () => {
		fetchMock.mockResolvedValue(mockResponse({ status: 429 }));
		let clock = 0;
		const client = new GongClient(
			{ accessKey: 'k', accessKeySecret: 's' },
			{
				maxRps: 0,
				maxRetries: 100, // high, so the BUDGET is what stops it
				maxRetryMs: 20_000,
				baseBackoffMs: 1000,
				now: () => clock,
				sleep: async (ms) => {
					clock += ms; // time advances as we back off
				},
			},
		);

		const err = await client.searchCalls({}).catch((e) => e);
		expect(err).toBeInstanceOf(GongRateLimitError);
		expect(clock).toBeLessThan(20_000); // never sleeps past the budget
		expect(fetchMock.mock.calls.length).toBeGreaterThan(2); // did retry a few times
		expect(err.message).toMatch(/temporarily rate-limiting/i);
	});
});
