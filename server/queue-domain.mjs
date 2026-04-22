import { randomBytes } from 'node:crypto';

export const callHoldMs = 1000 * 60;
export const expiredCustomerRetentionMs = 1000 * 60 * 5;

export function createInitialQueueState() {
  return {
    customers: [],
    tables: [],
    auth: {
      storeId: '',
      storeName: '',
      isLoggedIn: false,
    },
    isTablesConfigured: false,
    autoMode: false,
    nextQueueNumber: 1,
    version: 1,
  };
}

function deriveNextQueueNumber(customers) {
  return customers.reduce((max, customer) => Math.max(max, customer.queueNumber ?? 0), 0) + 1;
}

function normalizeCustomer(customer) {
  const normalizedJoinTime =
    typeof customer?.joinTime === 'string' ? customer.joinTime : new Date().toISOString();
  const normalizedExpiredAt =
    typeof customer?.expiredAt === 'string'
      ? customer.expiredAt
      : customer?.status === 'expired'
        ? normalizedJoinTime
        : undefined;

  return {
    id:
      typeof customer?.id === 'string' && customer.id.length > 0
        ? customer.id
        : randomBytes(8).toString('hex'),
    phone: typeof customer?.phone === 'string' ? customer.phone : '',
    email: typeof customer?.email === 'string' && customer.email.length > 0 ? customer.email : undefined,
    name: typeof customer?.name === 'string' && customer.name.length > 0 ? customer.name : undefined,
    source: customer?.source === 'walk-in' ? 'walk-in' : 'online',
    partySize: Number.isInteger(customer?.partySize) ? customer.partySize : 1,
    queueNumber: Number.isInteger(customer?.queueNumber) ? customer.queueNumber : 1,
    status:
      ['waiting', 'called', 'confirmed', 'seated', 'expired'].includes(customer?.status)
        ? customer.status
        : 'waiting',
    joinTime: normalizedJoinTime,
    callTime: typeof customer?.callTime === 'string' ? customer.callTime : undefined,
    expiredAt: normalizedExpiredAt,
    assignedTableId:
      typeof customer?.assignedTableId === 'string' ? customer.assignedTableId : undefined,
  };
}

function normalizeTable(table) {
  return {
    id:
      typeof table?.id === 'string' && table.id.length > 0
        ? table.id
        : randomBytes(6).toString('hex'),
    name: typeof table?.name === 'string' && table.name.length > 0 ? table.name : 'Table',
    capacity: Number.isInteger(table?.capacity) && table.capacity > 0 ? table.capacity : 2,
    status:
      ['available', 'reserved', 'occupied', 'cleaning'].includes(table?.status)
        ? table.status
        : 'available',
    assignedCustomerId:
      typeof table?.assignedCustomerId === 'string' ? table.assignedCustomerId : undefined,
  };
}

export function normalizeQueueState(queueState) {
  const initialState = createInitialQueueState();

  if (!queueState || typeof queueState !== 'object') {
    return initialState;
  }

  const customers = Array.isArray(queueState.customers)
    ? queueState.customers.map(normalizeCustomer)
    : [];
  const tables = Array.isArray(queueState.tables) ? queueState.tables.map(normalizeTable) : [];

  return {
    ...initialState,
    ...queueState,
    customers,
    tables,
    auth: {
      storeId:
        typeof queueState.auth?.storeId === 'string' ? queueState.auth.storeId : '',
      storeName:
        typeof queueState.auth?.storeName === 'string' ? queueState.auth.storeName : '',
      isLoggedIn: Boolean(queueState.auth?.isLoggedIn),
    },
    isTablesConfigured: Boolean(queueState.isTablesConfigured) && tables.length > 0,
    autoMode: Boolean(queueState.autoMode),
    nextQueueNumber:
      typeof queueState.nextQueueNumber === 'number' && queueState.nextQueueNumber > 0
        ? queueState.nextQueueNumber
        : deriveNextQueueNumber(customers),
    version:
      typeof queueState.version === 'number' && queueState.version > 0
        ? queueState.version
        : initialState.version,
  };
}

function withNextVersion(queueState, partial) {
  return {
    ...partial,
    version: queueState.version + 1,
  };
}

export function sanitizePublicQueueState(queueState) {
  return {
    ...queueState,
    customers: queueState.customers.map(customer => ({
      ...customer,
      phone: '',
      email: undefined,
      name: undefined,
    })),
    auth: {
      storeId: typeof queueState.auth?.storeId === 'string' ? queueState.auth.storeId : '',
      storeName: typeof queueState.auth?.storeName === 'string' ? queueState.auth.storeName : '',
      isLoggedIn: false,
    },
  };
}

function isInQueue(status) {
  return status === 'waiting' || status === 'called' || status === 'confirmed';
}

export function findBestTable(partySize, tables) {
  const availableTables = tables.filter(table => table.status === 'available');

  if (availableTables.length === 0) {
    return null;
  }

  let targetCapacity;
  if (partySize <= 3) {
    targetCapacity = 3;
  } else if (partySize === 4) {
    targetCapacity = 4;
  } else {
    targetCapacity = 8;
  }

  const sorted = [...availableTables].sort((left, right) => left.capacity - right.capacity);
  const exact = sorted.find(table => table.capacity >= partySize && table.capacity <= targetCapacity + 1);

  if (exact) {
    return exact;
  }

  return sorted.find(table => table.capacity >= partySize) ?? null;
}

function releaseCustomerTables(tables, customerId) {
  return tables.map(table =>
    table.assignedCustomerId === customerId
      ? { ...table, status: 'available', assignedCustomerId: undefined }
      : table
  );
}

function sortTablesForAutoMode(tables) {
  return [...tables].sort((left, right) => {
    if (left.capacity !== right.capacity) {
      return left.capacity - right.capacity;
    }

    return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' });
  });
}

function getExpiredCustomerAgeMs(customer, nowMs) {
  if (typeof customer?.expiredAt !== 'string') {
    return null;
  }

  const expiredAtMs = Date.parse(customer.expiredAt);
  if (!Number.isFinite(expiredAtMs)) {
    return null;
  }

  return nowMs - expiredAtMs;
}

export function configureTables(queueState, tables) {
  return withNextVersion(queueState, {
    ...queueState,
    tables,
    isTablesConfigured: tables.length > 0,
  });
}

export function addTable(queueState, capacity) {
  const nextIndex = queueState.tables.length + 1;
  const table = {
    id: randomBytes(6).toString('hex'),
    name: `T-${String(nextIndex).padStart(2, '0')}`,
    capacity,
    status: 'available',
  };

  return withNextVersion(queueState, {
    ...queueState,
    tables: [...queueState.tables, table],
    isTablesConfigured: true,
  });
}

export function clearQueue(queueState) {
  return withNextVersion(queueState, {
    ...queueState,
    customers: [],
    tables: queueState.tables.map(table => ({
      ...table,
      status: 'available',
      assignedCustomerId: undefined,
    })),
    nextQueueNumber: 1,
  });
}

export function joinQueue(queueState, phone, partySize, email, options = {}) {
  const normalizedPhone = typeof phone === 'string' ? phone : '';
  const source = options?.source === 'walk-in' ? 'walk-in' : 'online';
  const name =
    typeof options?.name === 'string' && options.name.trim().length > 0
      ? options.name.trim()
      : undefined;
  const existing =
    normalizedPhone.length > 0
      ? queueState.customers.find(
          customer => customer.phone === normalizedPhone && isInQueue(customer.status)
        )
      : null;

  if (existing) {
    return {
      customer: existing,
      state: queueState,
      changed: false,
    };
  }

  const customer = {
    id: randomBytes(8).toString('hex'),
    phone: normalizedPhone,
    email,
    name,
    source,
    partySize,
    queueNumber: queueState.nextQueueNumber,
    status: 'waiting',
    joinTime: new Date().toISOString(),
  };

  return {
    customer,
    changed: true,
    state: withNextVersion(queueState, {
      ...queueState,
      customers: [...queueState.customers, customer],
      nextQueueNumber: queueState.nextQueueNumber + 1,
    }),
  };
}

export function callCustomer(queueState, customerId, tableId) {
  const customer = queueState.customers.find(entry => entry.id === customerId);
  if (!customer || customer.status !== 'waiting') {
    return {
      changed: false,
      state: queueState,
      customer: null,
      table: null,
    };
  }

  const table = tableId
    ? queueState.tables.find(
        entry =>
          entry.id === tableId &&
          entry.status === 'available' &&
          entry.capacity >= customer.partySize
      ) ?? null
    : findBestTable(customer.partySize, queueState.tables);
  if (!table) {
    return {
      changed: false,
      state: queueState,
      customer,
      table: null,
    };
  }

  const updatedCustomer = {
    ...customer,
    status: 'called',
    callTime: new Date().toISOString(),
    expiredAt: undefined,
    assignedTableId: table.id,
  };

  return {
    changed: true,
    customer: updatedCustomer,
    table,
    state: withNextVersion(queueState, {
      ...queueState,
      customers: queueState.customers.map(entry =>
        entry.id === customerId ? updatedCustomer : entry
      ),
      tables: queueState.tables.map(entry =>
        entry.id === table.id
          ? { ...entry, status: 'reserved', assignedCustomerId: customerId }
          : entry
      ),
    }),
  };
}

export function confirmArrival(queueState, customerId) {
  const customer = queueState.customers.find(entry => entry.id === customerId);
  if (!customer || customer.status !== 'called') {
    return queueState;
  }

  return withNextVersion(queueState, {
    ...queueState,
    customers: queueState.customers.map(entry =>
      entry.id === customerId ? { ...entry, status: 'confirmed', expiredAt: undefined } : entry
    ),
    tables: queueState.tables.map(table =>
      table.assignedCustomerId === customerId ? { ...table, status: 'occupied' } : table
    ),
  });
}

export function seatCustomer(queueState, customerId) {
  const customer = queueState.customers.find(entry => entry.id === customerId);
  const canSeatDirectly =
    customer?.status === 'confirmed' ||
    (customer?.status === 'called' && customer.source === 'walk-in');
  if (!customer || !canSeatDirectly) {
    return queueState;
  }

  return withNextVersion(queueState, {
    ...queueState,
    customers: queueState.customers.map(entry =>
      entry.id === customerId ? { ...entry, status: 'seated', expiredAt: undefined } : entry
    ),
    tables: queueState.tables.map(table =>
      table.assignedCustomerId === customerId ? { ...table, status: 'occupied' } : table
    ),
  });
}

export function expireCustomer(queueState, customerId) {
  const customer = queueState.customers.find(entry => entry.id === customerId);
  if (!customer || (customer.status !== 'called' && customer.status !== 'confirmed')) {
    return queueState;
  }

  return withNextVersion(queueState, {
    ...queueState,
    customers: queueState.customers.map(entry =>
      entry.id === customerId
        ? {
            ...entry,
            status: 'expired',
            callTime: undefined,
            expiredAt: new Date().toISOString(),
            assignedTableId: undefined,
          }
        : entry
    ),
    tables: releaseCustomerTables(queueState.tables, customerId),
  });
}

export function requeueCustomer(queueState, customerId) {
  const customer = queueState.customers.find(entry => entry.id === customerId);
  if (!customer || customer.status === 'waiting' || customer.status === 'seated') {
    return queueState;
  }

  return withNextVersion(queueState, {
    ...queueState,
    customers: queueState.customers.map(entry =>
      entry.id === customerId
        ? {
            ...entry,
            status: 'waiting',
            callTime: undefined,
            expiredAt: undefined,
            assignedTableId: undefined,
          }
        : entry
    ),
    tables: releaseCustomerTables(queueState.tables, customerId),
  });
}

export function removeCustomerFromQueueState(queueState, customerId) {
  const exists = queueState.customers.some(customer => customer.id === customerId);
  if (!exists) {
    return queueState;
  }

  return withNextVersion(queueState, {
    ...queueState,
    customers: queueState.customers.filter(customer => customer.id !== customerId),
    tables: releaseCustomerTables(queueState.tables, customerId),
  });
}

export function setAutoMode(queueState, enabled) {
  if (queueState.autoMode === enabled) {
    return queueState;
  }

  return withNextVersion(queueState, {
    ...queueState,
    autoMode: enabled,
  });
}

export function pruneExpiredCustomers(
  queueState,
  nowMs = Date.now(),
  retentionMs = expiredCustomerRetentionMs
) {
  const expiredCustomers = queueState.customers.filter(customer => {
    if (customer.status !== 'expired') {
      return false;
    }

    const ageMs = getExpiredCustomerAgeMs(customer, nowMs);
    return ageMs !== null && ageMs >= retentionMs;
  });

  if (expiredCustomers.length === 0) {
    return {
      changed: false,
      removedCustomers: [],
      state: queueState,
    };
  }

  let nextState = queueState;
  for (const customer of expiredCustomers) {
    nextState = removeCustomerFromQueueState(nextState, customer.id);
  }

  return {
    changed: nextState !== queueState,
    removedCustomers: expiredCustomers,
    state: nextState,
  };
}

export function applyQueueAutomation(queueState, options = {}) {
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const retentionMs =
    Number.isFinite(options.expiredRetentionMs) && options.expiredRetentionMs > 0
      ? options.expiredRetentionMs
      : expiredCustomerRetentionMs;
  const pruned = pruneExpiredCustomers(queueState, nowMs, retentionMs);
  let nextState = pruned.state;
  const autoCalled = [];

  if (!nextState.autoMode) {
    return {
      state: nextState,
      autoCalled,
      removedExpiredCustomers: pruned.removedCustomers,
    };
  }

  while (true) {
    const availableTables = sortTablesForAutoMode(
      nextState.tables.filter(table => table.status === 'available')
    );
    const waitingCustomers = [...nextState.customers]
      .filter(customer => customer.status === 'waiting')
      .sort((left, right) => left.queueNumber - right.queueNumber);

    let matched = false;

    for (const table of availableTables) {
      const candidate = waitingCustomers.find(customer => customer.partySize <= table.capacity);
      if (!candidate) {
        continue;
      }

      const result = callCustomer(nextState, candidate.id, table.id);
      if (!result.changed || !result.customer || !result.table) {
        continue;
      }

      nextState = result.state;
      autoCalled.push({
        customer: result.customer,
        table: result.table,
      });
      matched = true;
      break;
    }

    if (!matched) {
      return {
        state: nextState,
        autoCalled,
        removedExpiredCustomers: pruned.removedCustomers,
      };
    }
  }
}

export function releaseTable(queueState, tableId) {
  const table = queueState.tables.find(entry => entry.id === tableId);
  if (!table || table.status === 'available') {
    return queueState;
  }

  const customers = table.assignedCustomerId
    ? table.status === 'reserved'
      ? queueState.customers.map(customer => {
          if (customer.id !== table.assignedCustomerId) {
            return customer;
          }

          return {
            ...customer,
            status: customer.status === 'called' ? 'waiting' : customer.status,
            callTime: undefined,
            expiredAt: undefined,
            assignedTableId: undefined,
          };
        })
      : queueState.customers.filter(customer => customer.id !== table.assignedCustomerId)
    : queueState.customers;

  return withNextVersion(queueState, {
    ...queueState,
    customers,
    tables: queueState.tables.map(entry =>
      entry.id === tableId
        ? { ...entry, status: 'available', assignedCustomerId: undefined }
        : entry
    ),
  });
}

export function isValidStoreId(storeId) {
  return /^[A-Z0-9-]{3,32}$/.test(storeId);
}

export function isValidOpaqueId(value) {
  return /^[A-Za-z0-9_-]{4,64}$/.test(value);
}

export function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export function normalizeConfiguredTables(tables) {
  if (!Array.isArray(tables)) {
    return null;
  }

  const ids = new Set();
  const names = new Set();
  const normalized = [];

  for (const table of tables) {
    if (!table || typeof table !== 'object') {
      return null;
    }

    const id = typeof table.id === 'string' ? table.id.trim() : '';
    const name = typeof table.name === 'string' ? table.name.trim() : '';
    const capacity = Number.parseInt(String(table.capacity ?? ''), 10);

    if (!isValidOpaqueId(id) || name.length < 1 || !Number.isInteger(capacity) || capacity <= 0) {
      return null;
    }

    const normalizedId = id.toLowerCase();
    const normalizedName = name.toLowerCase();
    if (ids.has(normalizedId) || names.has(normalizedName)) {
      return null;
    }

    ids.add(normalizedId);
    names.add(normalizedName);

    normalized.push({
      id,
      name,
      capacity,
      status:
        ['available', 'reserved', 'occupied', 'cleaning'].includes(table.status)
          ? table.status
          : 'available',
      assignedCustomerId:
        typeof table.assignedCustomerId === 'string' ? table.assignedCustomerId : undefined,
    });
  }

  return normalized;
}

export class QueueStateInvariantError extends Error {
  constructor(errors, context = {}) {
    super(`Queue state invariant violation: ${errors.join('; ')}`);
    this.name = 'QueueStateInvariantError';
    this.code = 'QUEUE_STATE_INVARIANT_VIOLATION';
    this.errors = errors;
    this.context = context;
  }
}

export function validateQueueStateInvariants(queueState) {
  const state = normalizeQueueState(queueState);
  const errors = [];
  const customerIds = new Set();
  const tableIds = new Set();
  const queueNumbers = new Set();
  const tableById = new Map();
  const customerById = new Map();
  const customerTableAssignments = new Map();
  let maxQueueNumber = 0;

  for (const table of state.tables) {
    if (tableIds.has(table.id)) {
      errors.push(`duplicate table id ${table.id}`);
    }
    tableIds.add(table.id);
    tableById.set(table.id, table);

    if ((table.status === 'available' || table.status === 'cleaning') && table.assignedCustomerId) {
      errors.push(`table ${table.id} is ${table.status} but still has an assigned customer`);
    }

    if (table.status === 'reserved' && !table.assignedCustomerId) {
      errors.push(`table ${table.id} is ${table.status} without an assigned customer`);
    }
  }

  for (const customer of state.customers) {
    if (customerIds.has(customer.id)) {
      errors.push(`duplicate customer id ${customer.id}`);
    }
    customerIds.add(customer.id);
    customerById.set(customer.id, customer);

    if (!Number.isInteger(customer.queueNumber) || customer.queueNumber <= 0) {
      errors.push(`customer ${customer.id} has an invalid queue number`);
    } else {
      maxQueueNumber = Math.max(maxQueueNumber, customer.queueNumber);
      if (queueNumbers.has(customer.queueNumber)) {
        errors.push(`duplicate queue number ${customer.queueNumber}`);
      }
      queueNumbers.add(customer.queueNumber);
    }

    if ((customer.status === 'waiting' || customer.status === 'expired') && customer.assignedTableId) {
      errors.push(`customer ${customer.id} is ${customer.status} but still has an assigned table`);
    }

    if (
      (customer.status === 'called' ||
        customer.status === 'confirmed' ||
        customer.status === 'seated') &&
      !customer.assignedTableId
    ) {
      errors.push(`customer ${customer.id} is ${customer.status} without an assigned table`);
    }

    if (customer.assignedTableId) {
      const table = tableById.get(customer.assignedTableId);
      if (!table) {
        errors.push(`customer ${customer.id} references missing table ${customer.assignedTableId}`);
      } else if (table.assignedCustomerId !== customer.id) {
        errors.push(`customer ${customer.id} and table ${table.id} disagree on assignment`);
      }
    }
  }

  for (const table of state.tables) {
    if (!table.assignedCustomerId) {
      continue;
    }

    const customer = customerById.get(table.assignedCustomerId);
    if (!customer) {
      if (table.status === 'reserved') {
        errors.push(`reserved table ${table.id} references missing customer ${table.assignedCustomerId}`);
      }
      continue;
    }

    const previousTableId = customerTableAssignments.get(customer.id);
    if (previousTableId) {
      errors.push(`customer ${customer.id} is assigned to multiple tables`);
    }
    customerTableAssignments.set(customer.id, table.id);

    if (customer.assignedTableId !== table.id) {
      errors.push(`table ${table.id} and customer ${customer.id} disagree on assignment`);
    }

    if (table.status === 'reserved' && customer.status !== 'called') {
      errors.push(`reserved table ${table.id} points to ${customer.status} customer ${customer.id}`);
    }

    if (
      table.status === 'occupied' &&
      customer.status !== 'confirmed' &&
      customer.status !== 'seated'
    ) {
      errors.push(`occupied table ${table.id} points to ${customer.status} customer ${customer.id}`);
    }
  }

  if (!Number.isInteger(state.nextQueueNumber) || state.nextQueueNumber <= 0) {
    errors.push('nextQueueNumber is invalid');
  } else if (state.nextQueueNumber <= maxQueueNumber) {
    errors.push('nextQueueNumber must be greater than all issued queue numbers');
  }

  return errors;
}

export function repairQueueStateForWrite(queueState) {
  const state = normalizeQueueState(queueState);
  const tableById = new Map(state.tables.map(table => [table.id, table]));
  const repairs = [];
  let changed = false;

  const customers = state.customers.filter(customer => {
    if (customer.status !== 'seated' || !customer.assignedTableId) {
      return true;
    }

    const table = tableById.get(customer.assignedTableId);
    const isActiveSeatedAssignment =
      table?.status === 'occupied' && table.assignedCustomerId === customer.id;

    if (isActiveSeatedAssignment) {
      return true;
    }

    changed = true;
    repairs.push({
      type: 'removed-stale-seated-customer',
      customerId: customer.id,
      tableId: customer.assignedTableId,
    });
    return false;
  });

  const customerById = new Map(customers.map(customer => [customer.id, customer]));
  const tables = state.tables.map(table => {
    if (!table.assignedCustomerId) {
      return table;
    }

    const customer = customerById.get(table.assignedCustomerId);
    if (!customer) {
      if (table.status === 'reserved') {
        changed = true;
        repairs.push({
          type: 'released-reserved-table-missing-customer',
          tableId: table.id,
          customerId: table.assignedCustomerId,
        });
        return {
          ...table,
          status: 'available',
          assignedCustomerId: undefined,
        };
      }

      return table;
    }

    if (customer.status === 'waiting' || customer.status === 'expired') {
      changed = true;
      repairs.push({
        type: 'released-table-for-inactive-customer',
        tableId: table.id,
        customerId: customer.id,
      });
      return {
        ...table,
        status: 'available',
        assignedCustomerId: undefined,
      };
    }

    return table;
  });

  const inactiveAssignmentCustomers = customers.map(customer => {
    if (
      (customer.status === 'waiting' || customer.status === 'expired') &&
      customer.assignedTableId
    ) {
      changed = true;
      repairs.push({
        type: 'cleared-inactive-customer-table',
        customerId: customer.id,
        tableId: customer.assignedTableId,
      });
      return {
        ...customer,
        assignedTableId: undefined,
      };
    }

    return customer;
  });

  if (!changed) {
    return { state, repairs };
  }

  return {
    state: {
      ...state,
      customers: inactiveAssignmentCustomers,
      tables,
      version: state.version + 1,
    },
    repairs,
  };
}

export function assertQueueStateInvariants(queueState, context = {}) {
  const errors = validateQueueStateInvariants(queueState);
  if (errors.length > 0) {
    throw new QueueStateInvariantError(errors, context);
  }
}

export function buildVersionConflictPayload(queueState, scope) {
  return {
    error: 'Queue state changed on another device. Refreshing to the latest version.',
    state: scope === 'merchant' ? queueState : sanitizePublicQueueState(queueState),
  };
}
