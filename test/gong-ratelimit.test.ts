import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	envNumber,
	GongClient,
	parseRetryAfterMs,
	RateLimiter,
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

	it('throws the original Gong error after exhausting retries', async () => {
		fetchMock.mockResolvedValue(
			mockResponse({ status: 429, body: { errors: ['rate limit'] } }),
		);

		await expect(makeClient(1).searchCalls({})).rejects.toThrow(
			/Gong API error: 429/,
		);
		// attempt 0 + 1 retry = 2 calls.
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});
});
