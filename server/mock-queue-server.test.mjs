import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import net from 'node:net';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  callCustomer as callCustomerInDomain,
  confirmArrival,
  configureTables as configureTablesInDomain,
  createInitialQueueState,
  joinQueue,
  releaseTable as releaseTableInDomain,
  repairQueueStateForWrite,
  seatCustomer as seatCustomerInDomain,
  validateQueueStateInvariants,
} from './queue-domain.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverScriptPath = join(__dirname, 'mock-queue-server.mjs');

async function getFreePort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === 'object') {
          resolvePort(address.port);
          return;
        }

        rejectPort(new Error('Unable to allocate a free port for tests.'));
      });
    });
    server.on('error', rejectPort);
  });
}

async function startServer(options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'queueflow-test-'));
  const port = await getFreePort();
  const child = spawn(process.execPath, [serverScriptPath], {
    cwd: dirname(serverScriptPath),
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      DEFAULT_STORE_ID: 'RESTO-001',
      DEFAULT_STORE_PASSWORD: 'admin123',
      QUEUEFLOW_DATA_DIR: dataDir,
      ...(options.env ?? {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const waitForReady = new Promise((resolveReady, rejectReady) => {
    let stderr = '';

    child.stdout.on('data', chunk => {
      const text = chunk.toString();
      if (text.includes('Mock queue server listening on')) {
        resolveReady();
      }
    });

    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
    });

    child.once('exit', code => {
      rejectReady(new Error(`Test server exited early with code ${code}. ${stderr}`.trim()));
    });
  });

  await waitForReady;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    async stop() {
      child.kill('SIGTERM');
      await new Promise(resolveStop => {
        child.once('exit', () => resolveStop());
      });
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

async function jsonRequest(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, options);
  const payload = await response.json().catch(() => null);
  return {
    ok: response.ok,
    status: response.status,
    headers: response.headers,
    payload,
  };
}

async function loginMerchant(baseUrl) {
  const response = await jsonRequest(baseUrl, '/auth/login', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      storeId: 'RESTO-001',
      password: 'admin123',
    }),
  });

  assert.equal(response.status, 200);
  assert.ok(response.payload?.token);
  return response.payload.token;
}

async function registerMerchant(baseUrl, overrides = {}) {
  const response = await jsonRequest(baseUrl, '/merchant/register', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      storeName: 'North Harbor Grill',
      ownerName: 'Alicia Tan',
      ownerEmail: 'owner@example.com',
      contactPhone: '+60 12-345 6789',
      planCode: 'growth',
      ...overrides,
    }),
  });

  assert.equal(response.status, 201);
  assert.ok(response.payload?.token);
  assert.ok(response.payload?.auth?.storeId);
  assert.ok(response.payload?.provisioning?.temporaryPassword);
  return response.payload;
}

async function configureTables(baseUrl, merchantToken) {
  return configureCustomTables(baseUrl, merchantToken, [
    { id: 'table-a', name: 'Table A', capacity: 4 },
    { id: 'table-b', name: 'Table B', capacity: 8 },
  ]);
}

async function configureCustomTables(baseUrl, merchantToken, tables) {
  const response = await jsonRequest(baseUrl, '/stores/RESTO-001/tables/configure', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${merchantToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      expectedVersion: 1,
      tables,
    }),
  });

  assert.equal(response.status, 200);
  return response.payload.state;
}

async function sleep(ms) {
  await new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

async function fetchCustomerEntrySession(baseUrl) {
  const response = await jsonRequest(baseUrl, '/stores/RESTO-001/customer-entry-session', {
    method: 'GET',
    headers: {
      Accept: 'application/json',
    },
  });

  assert.equal(response.status, 200);
  assert.ok(response.payload?.token);
  return response.payload.token;
}

async function joinCustomer(baseUrl, body, headers = {}) {
  const entryToken = await fetchCustomerEntrySession(baseUrl);
  return jsonRequest(baseUrl, '/stores/RESTO-001/customers/join', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Queue-Entry-Token': entryToken,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

test('public health endpoint exposes status without store ids or env details', async t => {
  const server = await startServer();
  t.after(async () => {
    await server.stop();
  });

  const response = await jsonRequest(server.baseUrl, '/health', {
    method: 'GET',
    headers: {
      Accept: 'application/json',
    },
  });

  assert.equal(response.status, 200);
  assert.equal(response.payload.ok, true);
  assert.equal(response.payload.stores, undefined);
  assert.equal(response.payload.notificationMissingEnv, undefined);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.match(response.headers.get('x-request-id') ?? '', /^[a-f0-9]{24}$/);
});

test('login endpoint rate limits repeated attempts from the same client and store', async t => {
  const server = await startServer();
  t.after(async () => {
    await server.stop();
  });

  let lastResponse = null;
  for (let attempt = 0; attempt < 11; attempt += 1) {
    lastResponse = await jsonRequest(server.baseUrl, '/auth/login', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        storeId: 'RESTO-001',
        password: `wrong-${attempt}`,
      }),
    });
  }

  assert.equal(lastResponse.status, 429);
  assert.match(lastResponse.payload.error, /too many requests/i);
  assert.ok(Number.parseInt(lastResponse.headers.get('retry-after') ?? '0', 10) > 0);
});

test('oversized JSON payloads are rejected before route handling', async t => {
  const server = await startServer({
    env: {
      QUEUEFLOW_MAX_JSON_BODY_BYTES: '96',
    },
  });
  t.after(async () => {
    await server.stop();
  });

  const response = await jsonRequest(server.baseUrl, '/auth/login', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      storeId: 'RESTO-001',
      password: 'x'.repeat(200),
    }),
  });

  assert.equal(response.status, 413);
  assert.equal(response.payload.type, 'body-too-large');
  assert.match(response.payload.error, /too large/i);
});

test('malformed JSON payloads receive a clear API error', async t => {
  const server = await startServer();
  t.after(async () => {
    await server.stop();
  });

  const response = await jsonRequest(server.baseUrl, '/auth/login', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: '{"storeId":',
  });

  assert.equal(response.status, 400);
  assert.equal(response.payload.type, 'invalid-json');
  assert.match(response.payload.error, /invalid json/i);
});

test('configured CORS allowlist rejects disallowed browser origins before auth', async t => {
  const server = await startServer({
    env: {
      QUEUEFLOW_ALLOWED_ORIGINS: 'https://trusted.example',
    },
  });
  t.after(async () => {
    await server.stop();
  });

  const response = await jsonRequest(server.baseUrl, '/auth/login', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Origin: 'https://evil.example',
    },
    body: JSON.stringify({
      storeId: 'RESTO-001',
      password: 'admin123',
    }),
  });

  assert.equal(response.status, 403);
  assert.match(response.payload.error, /origin is not allowed/i);

  const preflight = await fetch(`${server.baseUrl}/auth/login`, {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://evil.example',
      'Access-Control-Request-Method': 'POST',
    },
  });

  assert.equal(preflight.status, 403);
});

test('API preserves valid caller request ids and rejects invalid route ids early', async t => {
  const server = await startServer();
  t.after(async () => {
    await server.stop();
  });

  const requestId = 'frontdesk-req-123';
  const healthResponse = await jsonRequest(server.baseUrl, '/health', {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      'X-Request-Id': requestId,
    },
  });

  assert.equal(healthResponse.status, 200);
  assert.equal(healthResponse.headers.get('x-request-id'), requestId);

  const invalidStoreResponse = await jsonRequest(
    server.baseUrl,
    '/stores/not_valid!/public-queue-state',
    {
      method: 'GET',
      headers: {
        Accept: 'application/json',
      },
    }
  );

  assert.equal(invalidStoreResponse.status, 400);
  assert.match(invalidStoreResponse.payload.error, /invalid store id/i);
});

test('merchant can call a customer to a specific table instead of the default best-fit table', async t => {
  const server = await startServer();
  t.after(async () => {
    await server.stop();
  });

  const merchantToken = await loginMerchant(server.baseUrl);
  await configureTables(server.baseUrl, merchantToken);

  const joinResponse = await joinCustomer(server.baseUrl, {
    phone: '60101010101',
    partySize: 2,
  });

  assert.equal(joinResponse.status, 200);

  const customerId = joinResponse.payload.customer.id;
  const merchantState = await fetchMerchantState(server.baseUrl, merchantToken);
  const callResponse = await jsonRequest(
    server.baseUrl,
    `/stores/RESTO-001/customers/${customerId}/call`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${merchantToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        expectedVersion: merchantState.version,
        tableId: 'table-b',
      }),
    }
  );

  assert.equal(callResponse.status, 200);
  assert.equal(callResponse.payload.state.customers[0].assignedTableId, 'table-b');
  assert.equal(
    callResponse.payload.state.tables.find(table => table.id === 'table-b')?.assignedCustomerId,
    customerId
  );
  assert.equal(
    callResponse.payload.state.tables.find(table => table.id === 'table-a')?.status,
    'available'
  );
});

test('merchant add-table route appends tables atomically in order', async t => {
  const server = await startServer();
  t.after(async () => {
    await server.stop();
  });

  const merchantToken = await loginMerchant(server.baseUrl);

  const addFirst = await jsonRequest(server.baseUrl, '/stores/RESTO-001/tables/add', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${merchantToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      capacity: 2,
    }),
  });

  const addSecond = await jsonRequest(server.baseUrl, '/stores/RESTO-001/tables/add', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${merchantToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      capacity: 4,
    }),
  });

  assert.equal(addFirst.status, 200);
  assert.equal(addSecond.status, 200);
  assert.equal(addSecond.payload.state.tables.length, 2);
  assert.equal(addSecond.payload.state.tables[0].name, 'T-01');
  assert.equal(addSecond.payload.state.tables[1].name, 'T-02');
  assert.equal(addSecond.payload.state.tables[0].capacity, 2);
  assert.equal(addSecond.payload.state.tables[1].capacity, 4);
});

test('merchant can add a walk-in customer with pax only and optional name', async t => {
  const server = await startServer();
  t.after(async () => {
    await server.stop();
  });

  const merchantToken = await loginMerchant(server.baseUrl);
  await configureTables(server.baseUrl, merchantToken);

  const walkInResponse = await jsonRequest(server.baseUrl, '/stores/RESTO-001/customers/walk-in', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${merchantToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      partySize: 3,
      name: 'Mr Tan',
    }),
  });

  assert.equal(walkInResponse.status, 200);
  assert.equal(walkInResponse.payload.customer.partySize, 3);
  assert.equal(walkInResponse.payload.customer.name, 'Mr Tan');
  assert.equal(walkInResponse.payload.customer.source, 'walk-in');
  assert.equal(walkInResponse.payload.customer.phone, '');
  assert.equal(walkInResponse.payload.state.customers.length, 1);

  const customerId = walkInResponse.payload.customer.id;
  const callResponse = await jsonRequest(
    server.baseUrl,
    `/stores/RESTO-001/customers/${customerId}/call`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${merchantToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        expectedVersion: walkInResponse.payload.state.version,
      }),
    }
  );

  assert.equal(callResponse.status, 200);
  assert.equal(callResponse.payload.state.customers[0].status, 'called');
});

test('merchant can add a phone customer through the merchant flow without a customer session token', async t => {
  const server = await startServer();
  t.after(async () => {
    await server.stop();
  });

  const merchantToken = await loginMerchant(server.baseUrl);
  await configureTables(server.baseUrl, merchantToken);

  const addResponse = await jsonRequest(server.baseUrl, '/stores/RESTO-001/customers/manual', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${merchantToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      phone: '41414145144114',
      partySize: 3,
    }),
  });

  assert.equal(addResponse.status, 200);
  assert.equal(addResponse.payload.customer.phone, '41414145144114');
  assert.equal(addResponse.payload.customer.partySize, 3);
  assert.equal(addResponse.payload.customer.source, 'online');
  assert.equal(addResponse.payload.recovered, false);
});

test('merchant can seat a called walk-in customer without customer confirmation', async t => {
  const server = await startServer();
  t.after(async () => {
    await server.stop();
  });

  const merchantToken = await loginMerchant(server.baseUrl);
  await configureTables(server.baseUrl, merchantToken);

  const walkInResponse = await jsonRequest(server.baseUrl, '/stores/RESTO-001/customers/walk-in', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${merchantToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      partySize: 4,
      name: 'Walk-in guest',
    }),
  });

  assert.equal(walkInResponse.status, 200);
  const customerId = walkInResponse.payload.customer.id;

  const calledResponse = await jsonRequest(
    server.baseUrl,
    `/stores/RESTO-001/customers/${customerId}/call`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${merchantToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        expectedVersion: walkInResponse.payload.state.version,
      }),
    }
  );

  assert.equal(calledResponse.status, 200);
  assert.equal(calledResponse.payload.state.customers[0].status, 'called');

  const seatResponse = await jsonRequest(
    server.baseUrl,
    `/stores/RESTO-001/customers/${customerId}/seat`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${merchantToken}`,
        'Content-Type': 'application/json',
      },
    }
  );

  assert.equal(seatResponse.status, 200);
  assert.equal(seatResponse.payload.state.customers[0].status, 'seated');
  assert.equal(seatResponse.payload.state.tables[0].status, 'occupied');
});

test('auto mode calls the next waiting customer when a table becomes available and keeps seating manual', async t => {
  const server = await startServer();
  t.after(async () => {
    await server.stop();
  });

  const merchantToken = await loginMerchant(server.baseUrl);
  await configureCustomTables(server.baseUrl, merchantToken, [
    { id: 'table-a', name: 'T-01', capacity: 4 },
  ]);

  const firstWalkIn = await jsonRequest(server.baseUrl, '/stores/RESTO-001/customers/walk-in', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${merchantToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      partySize: 2,
      name: 'First',
    }),
  });
  const secondWalkIn = await jsonRequest(server.baseUrl, '/stores/RESTO-001/customers/walk-in', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${merchantToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      partySize: 2,
      name: 'Second',
    }),
  });

  assert.equal(firstWalkIn.status, 200);
  assert.equal(secondWalkIn.status, 200);

  const beforeAutoMode = await fetchMerchantState(server.baseUrl, merchantToken);
  const autoModeResponse = await jsonRequest(server.baseUrl, '/stores/RESTO-001/auto-mode', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${merchantToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      expectedVersion: beforeAutoMode.version,
      enabled: true,
    }),
  });

  assert.equal(autoModeResponse.status, 200);
  assert.equal(autoModeResponse.payload.state.autoMode, true);

  const firstCustomer = autoModeResponse.payload.state.customers.find(
    customer => customer.queueNumber === 1
  );
  const secondCustomer = autoModeResponse.payload.state.customers.find(
    customer => customer.queueNumber === 2
  );

  assert.equal(firstCustomer?.status, 'called');
  assert.equal(secondCustomer?.status, 'waiting');

  const seatResponse = await jsonRequest(
    server.baseUrl,
    `/stores/RESTO-001/customers/${firstCustomer.id}/seat`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${merchantToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        expectedVersion: autoModeResponse.payload.state.version,
      }),
    }
  );

  assert.equal(seatResponse.status, 200);
  const seatedFirst = seatResponse.payload.state.customers.find(customer => customer.id === firstCustomer.id);
  const stillWaitingSecond = seatResponse.payload.state.customers.find(
    customer => customer.id === secondCustomer.id
  );
  assert.equal(seatedFirst?.status, 'seated');
  assert.equal(stillWaitingSecond?.status, 'waiting');

  const afterSeat = await fetchMerchantState(server.baseUrl, merchantToken);
  const releaseResponse = await jsonRequest(server.baseUrl, '/stores/RESTO-001/tables/table-a/release', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${merchantToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      expectedVersion: afterSeat.version,
    }),
  });

  assert.equal(releaseResponse.status, 200);
  const autoCalledSecond = releaseResponse.payload.state.customers.find(
    customer => customer.id === secondCustomer.id
  );
  assert.equal(autoCalledSecond?.status, 'called');
  assert.equal(autoCalledSecond?.assignedTableId, 'table-a');
});

test('expired customers are automatically removed after the retention window', async t => {
  const server = await startServer({
    env: {
      QUEUE_EXPIRED_RETENTION_MS: '80',
    },
  });
  t.after(async () => {
    await server.stop();
  });

  const merchantToken = await loginMerchant(server.baseUrl);
  await configureCustomTables(server.baseUrl, merchantToken, [
    { id: 'table-a', name: 'T-01', capacity: 4 },
  ]);

  const walkInResponse = await jsonRequest(server.baseUrl, '/stores/RESTO-001/customers/walk-in', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${merchantToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      partySize: 2,
      name: 'Timeout',
    }),
  });

  assert.equal(walkInResponse.status, 200);

  const customerId = walkInResponse.payload.customer.id;
  const callResponse = await jsonRequest(
    server.baseUrl,
    `/stores/RESTO-001/customers/${customerId}/call`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${merchantToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        expectedVersion: walkInResponse.payload.state.version,
      }),
    }
  );

  assert.equal(callResponse.status, 200);

  const expireResponse = await jsonRequest(
    server.baseUrl,
    `/stores/RESTO-001/customers/${customerId}/expire`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${merchantToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        expectedVersion: callResponse.payload.state.version,
      }),
    }
  );

  assert.equal(expireResponse.status, 200);
  assert.equal(
    expireResponse.payload.state.customers.find(customer => customer.id === customerId)?.status,
    'expired'
  );

  await sleep(220);

  const refreshedState = await fetchMerchantState(server.baseUrl, merchantToken);
  assert.equal(refreshedState.customers.some(customer => customer.id === customerId), false);
});

async function fetchMerchantState(baseUrl, merchantToken) {
  const response = await jsonRequest(baseUrl, '/stores/RESTO-001/queue-state', {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${merchantToken}`,
    },
  });

  assert.equal(response.status, 200);
  return response.payload;
}

test('concurrent customer joins keep queue numbers unique and ordered', async t => {
  const server = await startServer();
  t.after(async () => {
    await server.stop();
  });

  const merchantToken = await loginMerchant(server.baseUrl);
  await configureTables(server.baseUrl, merchantToken);

  const joins = await Promise.all(
    Array.from({ length: 12 }, (_, index) =>
      joinCustomer(server.baseUrl, {
        phone: `60177000${String(index).padStart(4, '0')}`,
        partySize: 2,
      })
    )
  );

  for (const response of joins) {
    assert.equal(response.status, 200);
  }

  const state = await fetchMerchantState(server.baseUrl, merchantToken);
  const sortedCustomers = [...state.customers].sort(
    (left, right) => left.queueNumber - right.queueNumber
  );
  const queueNumbers = sortedCustomers.map(customer => customer.queueNumber);

  assert.equal(sortedCustomers.length, 12);
  assert.deepEqual(queueNumbers, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  assert.equal(new Set(queueNumbers).size, 12);
  assert.equal(new Set(sortedCustomers.map(customer => customer.id)).size, 12);
  assert.equal(state.nextQueueNumber, 13);
});

test('concurrent calls to one table cannot assign two customers to the same table', async t => {
  const server = await startServer();
  t.after(async () => {
    await server.stop();
  });

  const merchantToken = await loginMerchant(server.baseUrl);
  await configureCustomTables(server.baseUrl, merchantToken, [
    { id: 'table-a', name: 'Table A', capacity: 4 },
  ]);

  const firstJoin = await joinCustomer(server.baseUrl, {
    phone: '60188000001',
    partySize: 2,
  });
  const secondJoin = await joinCustomer(server.baseUrl, {
    phone: '60188000002',
    partySize: 2,
  });

  assert.equal(firstJoin.status, 200);
  assert.equal(secondJoin.status, 200);

  const [firstCall, secondCall] = await Promise.all([
    jsonRequest(server.baseUrl, `/stores/RESTO-001/customers/${firstJoin.payload.customer.id}/call`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${merchantToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ tableId: 'table-a' }),
    }),
    jsonRequest(server.baseUrl, `/stores/RESTO-001/customers/${secondJoin.payload.customer.id}/call`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${merchantToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ tableId: 'table-a' }),
    }),
  ]);

  assert.deepEqual([firstCall.status, secondCall.status].sort(), [200, 409]);

  const state = await fetchMerchantState(server.baseUrl, merchantToken);
  const calledCustomers = state.customers.filter(customer => customer.status === 'called');
  const table = state.tables.find(entry => entry.id === 'table-a');

  assert.equal(calledCustomers.length, 1);
  assert.equal(table.status, 'reserved');
  assert.equal(table.assignedCustomerId, calledCustomers[0].id);
  assert.equal(calledCustomers[0].assignedTableId, 'table-a');
});

test('repeated customer confirm is retry-safe and records one confirmed event', async t => {
  const server = await startServer();
  t.after(async () => {
    await server.stop();
  });

  const merchantToken = await loginMerchant(server.baseUrl);
  await configureTables(server.baseUrl, merchantToken);
  const joinResponse = await joinCustomer(server.baseUrl, {
    phone: '60188000003',
    partySize: 2,
  });

  assert.equal(joinResponse.status, 200);

  const merchantState = await fetchMerchantState(server.baseUrl, merchantToken);
  const callResponse = await jsonRequest(
    server.baseUrl,
    `/stores/RESTO-001/customers/${joinResponse.payload.customer.id}/call`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${merchantToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        expectedVersion: merchantState.version,
      }),
    }
  );

  assert.equal(callResponse.status, 200);

  const confirmOptions = {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Queue-Customer-Token': joinResponse.payload.customerToken,
    },
    body: JSON.stringify({}),
  };
  const firstConfirm = await jsonRequest(
    server.baseUrl,
    `/stores/RESTO-001/customers/${joinResponse.payload.customer.id}/confirm`,
    confirmOptions
  );
  const secondConfirm = await jsonRequest(
    server.baseUrl,
    `/stores/RESTO-001/customers/${joinResponse.payload.customer.id}/confirm`,
    confirmOptions
  );

  assert.equal(firstConfirm.status, 200);
  assert.equal(secondConfirm.status, 200);

  const eventsResponse = await jsonRequest(server.baseUrl, '/stores/RESTO-001/queue-events', {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${merchantToken}`,
    },
  });
  const confirmedEvents = eventsResponse.payload.events.filter(
    event => event.eventType === 'confirmed'
  );

  assert.equal(eventsResponse.status, 200);
  assert.equal(confirmedEvents.length, 1);
});

test('merchant bearer tokens cannot operate customer actions across stores', async t => {
  const server = await startServer();
  t.after(async () => {
    await server.stop();
  });

  const defaultMerchantToken = await loginMerchant(server.baseUrl);
  await configureCustomTables(server.baseUrl, defaultMerchantToken, [
    { id: 'table-a', name: 'Table A', capacity: 4 },
  ]);
  const otherStore = await registerMerchant(server.baseUrl, {
    storeName: 'East Pier Cafe',
    ownerEmail: 'east-pier@example.com',
  });

  const walkInResponse = await jsonRequest(server.baseUrl, '/stores/RESTO-001/customers/walk-in', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${defaultMerchantToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      partySize: 2,
      name: 'Cross Store Guard',
    }),
  });

  assert.equal(walkInResponse.status, 200);

  const callResponse = await jsonRequest(
    server.baseUrl,
    `/stores/RESTO-001/customers/${walkInResponse.payload.customer.id}/call`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${defaultMerchantToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ tableId: 'table-a' }),
    }
  );

  assert.equal(callResponse.status, 200);

  const crossStoreSeat = await jsonRequest(
    server.baseUrl,
    `/stores/RESTO-001/customers/${walkInResponse.payload.customer.id}/seat`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${otherStore.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    }
  );

  assert.equal(crossStoreSeat.status, 401);

  const state = await fetchMerchantState(server.baseUrl, defaultMerchantToken);
  const customer = state.customers.find(entry => entry.id === walkInResponse.payload.customer.id);
  assert.equal(customer.status, 'called');
});

test('same phone restores the existing queue ticket instead of creating a duplicate customer', async t => {
  const server = await startServer();
  t.after(async () => {
    await server.stop();
  });

  const merchantToken = await loginMerchant(server.baseUrl);
  await configureTables(server.baseUrl, merchantToken);

  const firstJoin = await joinCustomer(server.baseUrl, {
    phone: '60123456789',
    email: 'guest@example.com',
    partySize: 2,
  });

  assert.equal(firstJoin.status, 200);
  assert.equal(firstJoin.payload.recovered, false);
  assert.equal(firstJoin.payload.state.customers.length, 1);

  const secondJoin = await joinCustomer(
    server.baseUrl,
    {
      phone: '60123456789',
      partySize: 4,
    },
    {
      'X-Queue-Customer-Token': firstJoin.payload.customerToken,
    }
  );

  assert.equal(secondJoin.status, 200);
  assert.equal(secondJoin.payload.recovered, true);
  assert.equal(secondJoin.payload.state.customers.length, 1);
  assert.equal(secondJoin.payload.customer.id, firstJoin.payload.customer.id);
  assert.equal(secondJoin.payload.customer.queueNumber, firstJoin.payload.customer.queueNumber);
  assert.equal(secondJoin.payload.customerToken, firstJoin.payload.customerToken);
});

test('same phone cannot recover an active queue ticket without the original customer session token', async t => {
  const server = await startServer();
  t.after(async () => {
    await server.stop();
  });

  const merchantToken = await loginMerchant(server.baseUrl);
  await configureTables(server.baseUrl, merchantToken);

  const firstJoin = await joinCustomer(server.baseUrl, {
    phone: '60123450000',
    partySize: 2,
  });

  assert.equal(firstJoin.status, 200);

  const secondJoin = await joinCustomer(server.baseUrl, {
    phone: '60123450000',
    partySize: 2,
  });

  assert.equal(secondJoin.status, 409);
  assert.match(secondJoin.payload.error, /reopen the original page\/browser/i);
});

test('customer session validation only succeeds for the active customer token', async t => {
  const server = await startServer();
  t.after(async () => {
    await server.stop();
  });

  const merchantToken = await loginMerchant(server.baseUrl);
  await configureTables(server.baseUrl, merchantToken);

  const joinResponse = await joinCustomer(server.baseUrl, {
    phone: '60188888888',
    partySize: 2,
  });

  assert.equal(joinResponse.status, 200);

  const customerId = joinResponse.payload.customer.id;
  const customerToken = joinResponse.payload.customerToken;

  const validSession = await jsonRequest(
    server.baseUrl,
    `/stores/RESTO-001/customers/${customerId}/session`,
    {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'X-Queue-Customer-Token': customerToken,
      },
    }
  );

  assert.equal(validSession.status, 200);
  assert.equal(validSession.payload.valid, true);
  assert.equal(validSession.payload.customerId, customerId);
  assert.equal(validSession.payload.status, 'waiting');

  const invalidSession = await jsonRequest(
    server.baseUrl,
    `/stores/RESTO-001/customers/${customerId}/session`,
    {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'X-Queue-Customer-Token': 'invalid-token',
      },
    }
  );

  assert.equal(invalidSession.status, 403);
  assert.match(invalidSession.payload.error, /queue session is no longer valid/i);
});

test('merchant actions return a clear missing-customer error instead of generic not found', async t => {
  const server = await startServer();
  t.after(async () => {
    await server.stop();
  });

  const merchantToken = await loginMerchant(server.baseUrl);
  await configureTables(server.baseUrl, merchantToken);

  const response = await jsonRequest(
    server.baseUrl,
    '/stores/RESTO-001/customers/missing-customer/call',
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${merchantToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        expectedVersion: 2,
      }),
    }
  );

  assert.equal(response.status, 404);
  assert.match(response.payload.error, /customer is no longer in the active queue/i);
});

test('customer joins require an entry token and replay the same consumed join safely', async t => {
  const server = await startServer();
  t.after(async () => {
    await server.stop();
  });

  const merchantToken = await loginMerchant(server.baseUrl);
  await configureTables(server.baseUrl, merchantToken);

  const missingEntrySession = await jsonRequest(server.baseUrl, '/stores/RESTO-001/customers/join', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      phone: '60170000000',
      partySize: 2,
    }),
  });

  assert.equal(missingEntrySession.status, 401);

  const entryToken = await fetchCustomerEntrySession(server.baseUrl);
  const firstJoin = await jsonRequest(server.baseUrl, '/stores/RESTO-001/customers/join', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Queue-Entry-Token': entryToken,
    },
    body: JSON.stringify({
      phone: '60170000000',
      partySize: 2,
    }),
  });

  assert.equal(firstJoin.status, 200);

  const replayedJoin = await jsonRequest(server.baseUrl, '/stores/RESTO-001/customers/join', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Queue-Entry-Token': entryToken,
    },
    body: JSON.stringify({
      phone: '60170000000',
      partySize: 2,
    }),
  });

  assert.equal(replayedJoin.status, 200);
  assert.equal(replayedJoin.payload.customer.id, firstJoin.payload.customer.id);
  assert.equal(replayedJoin.payload.customerToken, firstJoin.payload.customerToken);
  assert.equal(replayedJoin.payload.state.customers.length, 1);

  const conflictingReplay = await jsonRequest(server.baseUrl, '/stores/RESTO-001/customers/join', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Queue-Entry-Token': entryToken,
    },
    body: JSON.stringify({
      phone: '60170000001',
      partySize: 2,
    }),
  });

  assert.equal(conflictingReplay.status, 409);
  assert.match(conflictingReplay.payload.error, /different join request/i);
});

test('customer push subscription endpoint requires a valid customer token', async t => {
  const server = await startServer();
  t.after(async () => {
    await server.stop();
  });

  const merchantToken = await loginMerchant(server.baseUrl);
  await configureTables(server.baseUrl, merchantToken);

  const joinResponse = await joinCustomer(server.baseUrl, {
    phone: '60199999999',
    partySize: 2,
  });

  assert.equal(joinResponse.status, 200);
  const customerId = joinResponse.payload.customer.id;
  const customerToken = joinResponse.payload.customerToken;

  const unauthorizedResponse = await jsonRequest(
    server.baseUrl,
    `/stores/RESTO-001/customers/${customerId}/push-subscriptions`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        subscription: {
          endpoint: 'https://push.example.com/subscriptions/demo-device',
          expirationTime: null,
          keys: {
            p256dh: 'demo-p256dh',
            auth: 'demo-auth',
          },
        },
      }),
    }
  );

  assert.equal(unauthorizedResponse.status, 401);

  const subscribeResponse = await jsonRequest(
    server.baseUrl,
    `/stores/RESTO-001/customers/${customerId}/push-subscriptions`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-Queue-Customer-Token': customerToken,
      },
      body: JSON.stringify({
        subscription: {
          endpoint: 'https://push.example.com/subscriptions/demo-device',
          expirationTime: null,
          keys: {
            p256dh: 'demo-p256dh',
            auth: 'demo-auth',
          },
        },
      }),
    }
  );

  assert.equal(subscribeResponse.status, 200);
  assert.equal(
    subscribeResponse.payload.endpoint,
    'https://push.example.com/subscriptions/demo-device'
  );

  const leaveResponse = await jsonRequest(
    server.baseUrl,
    `/stores/RESTO-001/customers/${customerId}/leave`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-Queue-Customer-Token': customerToken,
      },
    }
  );

  assert.equal(leaveResponse.status, 200);

  const staleTokenResponse = await jsonRequest(
    server.baseUrl,
    `/stores/RESTO-001/customers/${customerId}/push-subscriptions`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-Queue-Customer-Token': customerToken,
      },
      body: JSON.stringify({
        subscription: {
          endpoint: 'https://push.example.com/subscriptions/demo-device',
        },
      }),
    }
  );

  assert.equal(staleTokenResponse.status, 403);
});

test('queue lifecycle actions are recorded and clear-queue preserves the configured tables', async t => {
  const server = await startServer();
  t.after(async () => {
    await server.stop();
  });

  const merchantToken = await loginMerchant(server.baseUrl);
  await configureTables(server.baseUrl, merchantToken);

  const joinResponse = await joinCustomer(server.baseUrl, {
    phone: '60111111111',
    email: 'queue@example.com',
    partySize: 2,
  });

  assert.equal(joinResponse.status, 200);
  const customerId = joinResponse.payload.customer.id;
  const customerToken = joinResponse.payload.customerToken;
  assert.ok(customerToken);

  const merchantState = await fetchMerchantState(server.baseUrl, merchantToken);
  const callResponse = await jsonRequest(
    server.baseUrl,
    `/stores/RESTO-001/customers/${customerId}/call`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${merchantToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        expectedVersion: merchantState.version,
      }),
    }
  );

  assert.equal(callResponse.status, 200);

  const expireResponse = await jsonRequest(
    server.baseUrl,
    `/stores/RESTO-001/customers/${customerId}/expire`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${merchantToken}`,
        'Content-Type': 'application/json',
      },
    }
  );

  assert.equal(expireResponse.status, 200);

  const leaveResponse = await jsonRequest(
    server.baseUrl,
    `/stores/RESTO-001/customers/${customerId}/leave`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-Queue-Customer-Token': customerToken,
      },
    }
  );

  assert.equal(leaveResponse.status, 200);
  assert.equal(leaveResponse.payload.state.customers.length, 0);

  const secondJoin = await joinCustomer(server.baseUrl, {
    phone: '60222222222',
    partySize: 4,
  });

  assert.equal(secondJoin.status, 200);

  const beforeClear = await fetchMerchantState(server.baseUrl, merchantToken);
  const clearResponse = await jsonRequest(server.baseUrl, '/stores/RESTO-001/clear-queue', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${merchantToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      expectedVersion: beforeClear.version,
    }),
  });

  assert.equal(clearResponse.status, 200);
  assert.equal(clearResponse.payload.state.customers.length, 0);
  assert.equal(clearResponse.payload.state.tables.length, 2);
  assert.deepEqual(
    clearResponse.payload.state.tables.map(table => table.status),
    ['available', 'available']
  );

  const eventsResponse = await jsonRequest(server.baseUrl, '/stores/RESTO-001/queue-events?limit=20', {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${merchantToken}`,
    },
  });

  assert.equal(eventsResponse.status, 200);
  const eventTypes = eventsResponse.payload.events.map(event => event.eventType);
  assert.ok(eventTypes.includes('joined'));
  assert.ok(eventTypes.includes('called'));
  assert.ok(eventTypes.includes('expired'));
  assert.ok(eventTypes.includes('left'));
  assert.ok(eventTypes.includes('queue_cleared'));
});

test('table configure route preserves non-available statuses for remote table updates', async t => {
  const server = await startServer();
  t.after(async () => {
    await server.stop();
  });

  const merchantToken = await loginMerchant(server.baseUrl);
  await configureTables(server.baseUrl, merchantToken);

  const updatedState = await fetchMerchantState(server.baseUrl, merchantToken);
  const response = await jsonRequest(server.baseUrl, '/stores/RESTO-001/tables/configure', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${merchantToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      expectedVersion: updatedState.version,
      tables: [
        {
          id: 'table-a',
          name: 'Table A',
          capacity: 4,
          status: 'cleaning',
        },
        {
          id: 'table-b',
          name: 'Table B',
          capacity: 8,
          status: 'occupied',
          assignedCustomerId: 'customer-123',
        },
      ],
    }),
  });

  assert.equal(response.status, 200);
  assert.equal(response.payload.state.tables[0].status, 'cleaning');
  assert.equal(response.payload.state.tables[1].status, 'occupied');
  assert.equal(response.payload.state.tables[1].assignedCustomerId, 'customer-123');
});

test('releasing an occupied table removes the finished seated customer from the active store state', () => {
  const configuredState = configureTablesInDomain(createInitialQueueState(), [
    { id: 'table-1', name: 'T-01', capacity: 3, status: 'available' },
  ]);
  const joined = joinQueue(configuredState, '60333333333', 2);
  assert.ok(joined.customer);

  const called = callCustomerInDomain(joined.state, joined.customer.id, 'table-1');
  const confirmed = confirmArrival(called.state, joined.customer.id);
  const seated = seatCustomerInDomain(confirmed, joined.customer.id);
  const released = releaseTableInDomain(seated, 'table-1');

  assert.equal(seated.customers.filter(customer => customer.status === 'seated').length, 1);
  assert.equal(released.customers.length, 0);
  assert.equal(released.tables[0].status, 'available');
  assert.equal(released.tables[0].assignedCustomerId, undefined);
});

test('legacy queue state repair removes stale seated assignments before strict writes', () => {
  const state = {
    ...createInitialQueueState(),
    version: 4,
    nextQueueNumber: 5,
    customers: [
      {
        id: 'active-seated',
        phone: '',
        source: 'walk-in',
        partySize: 2,
        queueNumber: 1,
        status: 'seated',
        joinTime: new Date().toISOString(),
        assignedTableId: 'table-active',
      },
      {
        id: 'stale-seated',
        phone: '',
        source: 'walk-in',
        partySize: 2,
        queueNumber: 2,
        status: 'seated',
        joinTime: new Date().toISOString(),
        assignedTableId: 'table-free',
      },
      {
        id: 'expired-with-table',
        phone: '',
        source: 'online',
        partySize: 2,
        queueNumber: 3,
        status: 'expired',
        joinTime: new Date().toISOString(),
        expiredAt: new Date().toISOString(),
        assignedTableId: 'table-expired',
      },
    ],
    tables: [
      {
        id: 'table-active',
        name: 'T-01',
        capacity: 2,
        status: 'occupied',
        assignedCustomerId: 'active-seated',
      },
      {
        id: 'table-free',
        name: 'T-02',
        capacity: 2,
        status: 'available',
      },
      {
        id: 'table-expired',
        name: 'T-03',
        capacity: 2,
        status: 'reserved',
        assignedCustomerId: 'expired-with-table',
      },
    ],
  };

  assert.notEqual(validateQueueStateInvariants(state).length, 0);

  const repair = repairQueueStateForWrite(state);

  assert.equal(repair.repairs.length, 3);
  assert.equal(repair.state.version, 5);
  assert.equal(
    repair.state.customers.some(customer => customer.id === 'stale-seated'),
    false
  );
  assert.equal(
    repair.state.customers.find(customer => customer.id === 'expired-with-table')?.assignedTableId,
    undefined
  );
  assert.equal(
    repair.state.tables.find(table => table.id === 'table-expired')?.status,
    'available'
  );
  assert.deepEqual(validateQueueStateInvariants(repair.state), []);
});

test('merchant registration provisions a unique store, issues credentials, and allows profile updates', async t => {
  const server = await startServer();
  t.after(async () => {
    await server.stop();
  });

  const registration = await registerMerchant(server.baseUrl);
  const storeId = registration.auth.storeId;
  const merchantToken = registration.token;
  const temporaryPassword = registration.provisioning.temporaryPassword;

  assert.match(storeId, /^[A-Z0-9-]{3,32}$/);
  assert.equal(registration.profile.ownerEmail, 'owner@example.com');
  assert.equal(registration.profile.planCode, 'growth');
  assert.equal(registration.profile.subscriptionStatus, 'trialing');
  assert.equal(registration.profile.billing.provider, 'none');
  assert.equal(registration.profile.billing.checkoutEnabled, false);
  assert.equal(registration.profile.billing.portalEnabled, false);
  assert.equal(registration.profile.billing.plans.growth.planCode, 'growth');
  assert.equal(registration.profile.billing.config.configured, false);
  assert.deepEqual(registration.profile.billing.config.missingEnv, [
    'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET',
  ]);
  assert.equal(registration.profile.notifications.provider, 'disabled');
  assert.equal(registration.profile.notifications.deliveryEnabled, false);
  assert.equal(registration.profile.notifications.config.configured, false);
  assert.deepEqual(registration.profile.notifications.config.missingEnv, [
    'QUEUE_SMTP_HOST',
    'QUEUE_SMTP_USER',
    'QUEUE_SMTP_PASSWORD',
  ]);

  const sessionResponse = await jsonRequest(server.baseUrl, '/auth/session', {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${merchantToken}`,
    },
  });

  assert.equal(sessionResponse.status, 200);
  assert.equal(sessionResponse.payload.auth.storeId, storeId);

  const profileResponse = await jsonRequest(server.baseUrl, `/stores/${storeId}/profile`, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${merchantToken}`,
    },
  });

  assert.equal(profileResponse.status, 200);
  assert.equal(profileResponse.payload.profile.storeId, storeId);
  assert.equal(profileResponse.payload.profile.billing.provider, 'none');
  assert.equal(profileResponse.payload.profile.notifications.provider, 'disabled');

  const updateResponse = await jsonRequest(server.baseUrl, `/stores/${storeId}/profile`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${merchantToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      storeName: 'North Harbor Prime',
      ownerName: 'Alicia Chen',
      contactPhone: '+60 13-000 0000',
      planCode: 'scale',
    }),
  });

  assert.equal(updateResponse.status, 200);
  assert.equal(updateResponse.payload.profile.storeName, 'North Harbor Prime');
  assert.equal(updateResponse.payload.profile.ownerName, 'Alicia Chen');
  assert.equal(updateResponse.payload.profile.planCode, 'scale');

  const loginResponse = await jsonRequest(server.baseUrl, '/auth/login', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      storeId,
      password: temporaryPassword,
    }),
  });

  assert.equal(loginResponse.status, 200);
  assert.equal(loginResponse.payload.auth.storeName, 'North Harbor Prime');
});

test('merchant registration accepts a custom login password for future sign-ins', async t => {
  const server = await startServer();
  t.after(async () => {
    await server.stop();
  });

  const password = 'OwnerPass123';
  const registration = await registerMerchant(server.baseUrl, {
    storeName: 'Custom Password Cafe',
    ownerEmail: 'custom-password@example.com',
    password,
  });

  assert.equal(registration.provisioning.temporaryPassword, password);

  const loginResponse = await jsonRequest(server.baseUrl, '/auth/login', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      storeId: registration.auth.storeId,
      password,
    }),
  });

  assert.equal(loginResponse.status, 200);
  assert.equal(loginResponse.payload.auth.storeId, registration.auth.storeId);
});

test('merchant can change the store login password after signing in', async t => {
  const server = await startServer();
  t.after(async () => {
    await server.stop();
  });

  const merchantToken = await loginMerchant(server.baseUrl);

  const wrongCurrentResponse = await jsonRequest(server.baseUrl, '/stores/RESTO-001/password', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${merchantToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      currentPassword: 'wrong-password',
      nextPassword: 'UpdatedPass123',
    }),
  });

  assert.equal(wrongCurrentResponse.status, 403);

  const updateResponse = await jsonRequest(server.baseUrl, '/stores/RESTO-001/password', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${merchantToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      currentPassword: 'admin123',
      nextPassword: 'UpdatedPass123',
    }),
  });

  assert.equal(updateResponse.status, 200);
  assert.equal(updateResponse.payload.ok, true);

  const oldPasswordLogin = await jsonRequest(server.baseUrl, '/auth/login', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      storeId: 'RESTO-001',
      password: 'admin123',
    }),
  });

  assert.equal(oldPasswordLogin.status, 401);

  const newPasswordLogin = await jsonRequest(server.baseUrl, '/auth/login', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      storeId: 'RESTO-001',
      password: 'UpdatedPass123',
    }),
  });

  assert.equal(newPasswordLogin.status, 200);
  assert.equal(newPasswordLogin.payload.auth.storeId, 'RESTO-001');
});

test('billing checkout returns a clear configuration error when Stripe is not set up', async t => {
  const server = await startServer();
  t.after(async () => {
    await server.stop();
  });

  const registration = await registerMerchant(server.baseUrl);
  const checkoutResponse = await jsonRequest(
    server.baseUrl,
    `/stores/${registration.auth.storeId}/billing/checkout`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${registration.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        planCode: 'scale',
      }),
    }
  );

  assert.equal(checkoutResponse.status, 503);
  assert.match(checkoutResponse.payload.error, /Stripe billing is not configured/i);
});

test('merchant test notification email returns a clear configuration error when email delivery is not set up', async t => {
  const server = await startServer();
  t.after(async () => {
    await server.stop();
  });

  const registration = await registerMerchant(server.baseUrl);
  const response = await jsonRequest(
    server.baseUrl,
    `/stores/${registration.auth.storeId}/notifications/test-email`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${registration.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        recipient: 'owner@example.com',
      }),
    }
  );

  assert.equal(response.status, 503);
  assert.match(response.payload.error, /Email delivery is not configured/i);
});
