import type { Account, Relation } from '@2fa/api-types';

export interface PlaintextItemWithDates {
  id: string;
  group_id: string | null;
  rev: number;
  seq: number;
  deleted: boolean;
  updated_at: string;
  issuer: string;
  account: string;
  secret: string;
  notes?: string;
  created_at?: string;
}

function getMetadataCreatedAt(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const metadata = value as Record<string, unknown>;
  return typeof metadata.client_created_at === 'string' ? metadata.client_created_at : null;
}

export function resolveItemTimestamp(
  item: PlaintextItemWithDates,
  accounts: Account[],
  relations: Relation[],
  fallbackDate: Date = new Date()
): string {
  // 1. relation.created_at for the item/group relation if available
  if (item.group_id) {
    const rel = relations.find(r => 
      !r.deleted &&
      ((r.from_id === item.id && r.to_id === item.group_id) ||
       (r.from_id === item.group_id && r.to_id === item.id))
    );
    if (rel) {
      const metadataCreatedAt = getMetadataCreatedAt(rel.metadata_json);
      if (metadataCreatedAt) return metadataCreatedAt;
      if (rel.created_at) return rel.created_at;
    }
  }

  // 2. account.created_at by item/account id if available
  const acct = accounts.find(a => !a.deleted && a.id === item.id);
  if (acct) {
    const metadataCreatedAt = getMetadataCreatedAt(acct.metadata_json);
    if (metadataCreatedAt) return metadataCreatedAt;
    if (acct.created_at) return acct.created_at;
  }

  // 3. item.created_at if present on the runtime object
  if (item.created_at) {
    return item.created_at;
  }

  // 4. current time for legacy records without a creation timestamp
  return fallbackDate.toISOString();
}

export function formatAge(startDateStr: string, endDate: Date = new Date()): string {
  const startDate = new Date(startDateStr);
  if (Number.isNaN(startDate.getTime())) {
    return '未知';
  }

  if (endDate < startDate) {
    return '0天';
  }

  let years = endDate.getFullYear() - startDate.getFullYear();
  let months = endDate.getMonth() - startDate.getMonth();
  let days = endDate.getDate() - startDate.getDate();

  if (days < 0) {
    const prevMonth = new Date(endDate.getFullYear(), endDate.getMonth(), 0);
    days += prevMonth.getDate();
    months--;
  }

  if (months < 0) {
    months += 12;
    years--;
  }

  if (years === 0 && months === 0) {
    return `${days}天`;
  }

  if (years === 0) {
    if (days === 0) {
      return `${months}月`;
    }
    return `${months}月${days}天`;
  }

  if (months === 0 && days === 0) {
    return `${years}年`;
  }
  if (months === 0) {
    return `${years}年${days}天`;
  }
  if (days === 0) {
    return `${years}年${months}月`;
  }
  return `${years}年${months}月${days}天`;
}

export type AccountKind = 'google' | 'gpt' | 'email' | 'proxy' | 'site';

export const ACCOUNT_TYPE_SORT_ORDER: Record<AccountKind, number> = {
  google: 0,
  gpt: 1,
  email: 2,
  proxy: 3,
  site: 4
};

export function comparePlaintextItems(
  a: PlaintextItemWithDates,
  b: PlaintextItemWithDates,
  getType: (item: PlaintextItemWithDates) => AccountKind,
  accounts: Account[],
  relations: Relation[]
): number {
  const typeDiff = ACCOUNT_TYPE_SORT_ORDER[getType(a)] - ACCOUNT_TYPE_SORT_ORDER[getType(b)];
  if (typeDiff !== 0) return typeDiff;

  const tsA = resolveItemTimestamp(a, accounts, relations);
  const tsB = resolveItemTimestamp(b, accounts, relations);
  const timeA = Date.parse(tsA);
  const timeB = Date.parse(tsB);
  const timeDiff = (Number.isNaN(timeB) ? 0 : timeB) - (Number.isNaN(timeA) ? 0 : timeA);
  if (timeDiff !== 0) return timeDiff;

  return (a.account || a.issuer || a.id).localeCompare(b.account || b.issuer || b.id);
}
