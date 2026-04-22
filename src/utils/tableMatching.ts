import type { Table } from '../types';

/**
 * Smart table matching logic:
 * 1-3 pax  → 3-person table (smallest suitable)
 * 4 pax    → 4-person table
 * 5-8 pax  → 7-8 person table
 *
 * Returns the best available table or null.
 */
export function findBestTable(partySize: number, tables: Table[]): Table | null {
  const availableTables = tables.filter(t => t.status === 'available');

  if (availableTables.length === 0) return null;

  // Determine target capacity tier
  let targetCapacity: number;
  if (partySize <= 3) {
    targetCapacity = 3;
  } else if (partySize === 4) {
    targetCapacity = 4;
  } else {
    // 5-8 pax: large table
    targetCapacity = 8;
  }

  // First try: find a table that exactly matches or is the smallest viable option
  // Sort by capacity ascending so we pick the most efficient table
  const sorted = [...availableTables].sort((a, b) => a.capacity - b.capacity);

  // Find the smallest table that fits the party
  const exact = sorted.find(t => t.capacity >= partySize && t.capacity <= targetCapacity + 1);
  if (exact) return exact;

  // Fallback: any table that fits the party (largest available)
  const fallback = sorted.filter(t => t.capacity >= partySize);
  if (fallback.length > 0) return fallback[0];

  return null;
}

/**
 * Returns estimated minutes per party ahead in queue.
 * Base: 4 minutes per group ahead.
 */
export function calcEstimatedWait(position: number): number {
  return position * 4;
}
