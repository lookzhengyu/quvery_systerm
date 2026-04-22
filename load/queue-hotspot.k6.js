import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

http.setResponseCallback(http.expectedStatuses({ min: 200, max: 299 }, 409));

const mutationLatency = new Trend('queue_mutation_latency_ms', true);
const queueInvariantFailures = new Rate('queue_invariant_failures');
const acceptedMutations = new Counter('queue_mutations_accepted');
const lockConflicts = new Counter('queue_lock_conflicts');

export const options = {
  scenarios: {
    hot_store_walkins: {
      executor: 'constant-arrival-rate',
      rate: Number(__ENV.K6_WALKIN_RATE || 8),
      timeUnit: '1s',
      duration: __ENV.K6_DURATION || '45s',
      preAllocatedVUs: Number(__ENV.K6_PREALLOCATED_VUS || 30),
      maxVUs: Number(__ENV.K6_MAX_VUS || 80),
      exec: 'hotStoreWalkIn',
    },
    single_table_lock_conflicts: {
      executor: 'constant-arrival-rate',
      rate: Number(__ENV.K6_CALL_RATE || 4),
      timeUnit: '1s',
      duration: __ENV.K6_DURATION || '45s',
      preAllocatedVUs: Number(__ENV.K6_PREALLOCATED_VUS || 30),
      maxVUs: Number(__ENV.K6_MAX_VUS || 80),
      exec: 'singleTableLockConflict',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.02'],
    queue_invariant_failures: ['rate==0'],
    queue_mutation_latency_ms: ['p(95)<1500', 'p(99)<3000'],
  },
};

function jsonHeaders(extra = {}) {
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    ...extra,
  };
}

function postJson(path, body, headers = {}) {
  const response = http.post(
    `${__ENV.BASE_URL}${path}`,
    JSON.stringify(body),
    { headers: jsonHeaders(headers) }
  );
  mutationLatency.add(response.timings.duration);
  if (response.status >= 200 && response.status < 300) {
    acceptedMutations.add(1);
  }
  if (response.status === 409) {
    lockConflicts.add(1);
  }
  return response;
}

function assertResponse(response, name, statuses = [200]) {
  const ok = check(response, {
    [name]: result => statuses.includes(result.status),
  });
  queueInvariantFailures.add(ok ? 0 : 1);
  return ok;
}

export function setup() {
  if (!__ENV.BASE_URL) {
    throw new Error('BASE_URL is required. Use npm run load:k6:postgres to start a local server.');
  }

  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const registration = postJson('/merchant/register', {
    storeName: `K6 Hotspot ${suffix}`,
    ownerName: 'K6 Runner',
    ownerEmail: `k6-${suffix}@example.com`,
    contactPhone: '+60 12-345 6789',
    password: `K6-${suffix}-Password`,
    planCode: 'scale',
  });
  assertResponse(registration, 'register store', [201]);

  const payload = registration.json();
  const storeId = payload.auth.storeId;
  const merchantToken = payload.token;
  const configure = postJson(
    `/stores/${storeId}/tables/configure`,
    {
      expectedVersion: 1,
      tables: [{ id: 'table-a', name: 'Table A', capacity: 4 }],
    },
    { Authorization: `Bearer ${merchantToken}` }
  );
  assertResponse(configure, 'configure table');

  return {
    storeId,
    merchantToken,
  };
}

export function hotStoreWalkIn(data) {
  const response = postJson(
    `/stores/${data.storeId}/customers/walk-in`,
    {
      partySize: 2,
      name: `VU ${__VU} ITER ${__ITER}`,
    },
    { Authorization: `Bearer ${data.merchantToken}` }
  );
  assertResponse(response, 'walk-in write accepted');
  sleep(0.1);
}

export function singleTableLockConflict(data) {
  const join = postJson(
    `/stores/${data.storeId}/customers/walk-in`,
    {
      partySize: 2,
      name: `Lock ${__VU} ${__ITER}`,
    },
    { Authorization: `Bearer ${data.merchantToken}` }
  );
  if (!assertResponse(join, 'lock customer created')) {
    return;
  }

  const customerId = join.json().customer.id;
  const call = postJson(
    `/stores/${data.storeId}/customers/${customerId}/call`,
    { tableId: 'table-a' },
    { Authorization: `Bearer ${data.merchantToken}` }
  );
  assertResponse(call, 'call returns success or expected conflict', [200, 409]);
  sleep(0.1);
}
