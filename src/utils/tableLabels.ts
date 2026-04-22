import type { Table } from '../types';

const TABLE_CODE_PATTERN = /^T-\d{2,}$/i;

export function formatTableCode(order: number): string {
  return `T-${String(order).padStart(2, '0')}`;
}

export function buildDefaultTableName(order: number): string {
  return formatTableCode(order);
}

export function getTableDisplayMeta(
  table: Table,
  tables: Table[]
): { label: string; subtitle?: string } {
  const trimmedName = table.name.trim();
  const tableIndex = tables.findIndex(entry => entry.id === table.id);
  const fallbackLabel =
    tableIndex >= 0 ? formatTableCode(tableIndex + 1) : trimmedName || 'Table';
  const label = TABLE_CODE_PATTERN.test(trimmedName)
    ? trimmedName.toUpperCase()
    : fallbackLabel;

  if (!trimmedName || trimmedName.toUpperCase() === label.toUpperCase()) {
    return { label };
  }

  return {
    label,
    subtitle: trimmedName,
  };
}
