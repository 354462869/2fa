import { describe, expect, it } from 'vitest';
import { formatAge, resolveItemTimestamp, comparePlaintextItems, type PlaintextItemWithDates } from './age';
import type { Account, Relation } from '@2fa/api-types';

describe('age and timestamp helpers', () => {
  describe('formatAge', () => {
    it('handles same day age', () => {
      const start = '2026-06-23T12:00:00Z';
      const end = new Date('2026-06-23T15:00:00Z');
      expect(formatAge(start, end)).toBe('0天');
    });

    it('handles age under a month', () => {
      const start = '2026-06-13T12:00:00Z';
      const end = new Date('2026-06-23T12:00:00Z');
      expect(formatAge(start, end)).toBe('10天');
    });

    it('handles age over a month with zero days omitted', () => {
      const start = '2026-05-23T12:00:00Z';
      const end = new Date('2026-06-23T12:00:00Z');
      expect(formatAge(start, end)).toBe('1月');
    });

    it('handles age over a month with days', () => {
      const start = '2026-05-20T12:00:00Z';
      const end = new Date('2026-06-23T12:00:00Z');
      expect(formatAge(start, end)).toBe('1月3天');
    });

    it('handles the requested month and day example', () => {
      const start = '2026-05-10T12:00:00Z';
      const end = new Date('2026-06-23T12:00:00Z');
      expect(formatAge(start, end)).toBe('1月13天');
    });

    it('handles age over a year with zero months and days omitted', () => {
      const start = '2025-06-23T12:00:00Z';
      const end = new Date('2026-06-23T12:00:00Z');
      expect(formatAge(start, end)).toBe('1年');
    });

    it('handles age over a year with months only', () => {
      const start = '2025-04-23T12:00:00Z';
      const end = new Date('2026-06-23T12:00:00Z');
      expect(formatAge(start, end)).toBe('1年2月');
    });

    it('handles age over a year with days only', () => {
      const start = '2025-06-20T12:00:00Z';
      const end = new Date('2026-06-23T12:00:00Z');
      expect(formatAge(start, end)).toBe('1年3天');
    });

    it('handles age over a year with months and days', () => {
      const start = '2024-04-20T12:00:00Z';
      const end = new Date('2026-06-23T12:00:00Z');
      expect(formatAge(start, end)).toBe('2年2月3天');
    });

    it('handles the requested year, month, and day example', () => {
      const start = '2025-04-10T12:00:00Z';
      const end = new Date('2026-06-23T12:00:00Z');
      expect(formatAge(start, end)).toBe('1年2月13天');
    });

    it('gracefully handles invalid start date', () => {
      expect(formatAge('invalid-date')).toBe('未知');
    });

    it('gracefully handles future start date', () => {
      const start = '2026-07-23T12:00:00Z';
      const end = new Date('2026-06-23T12:00:00Z');
      expect(formatAge(start, end)).toBe('0天');
    });
  });

  describe('resolveItemTimestamp', () => {
    const mockItem: PlaintextItemWithDates = {
      id: 'item-123',
      group_id: 'group-456',
      rev: 1,
      seq: 1,
      deleted: false,
      updated_at: '2026-06-01T00:00:00Z',
      issuer: 'Test',
      account: 'user',
      secret: 'ABC',
    };

    it('falls back to the current time if no creation timestamp is present', () => {
      const now = new Date('2026-06-23T00:00:00Z');
      expect(resolveItemTimestamp(mockItem, [], [], now)).toBe('2026-06-23T00:00:00.000Z');
    });

    it('uses item.created_at if present on the runtime object', () => {
      const itemWithCreated = { ...mockItem, created_at: '2026-05-01T00:00:00Z' };
      expect(resolveItemTimestamp(itemWithCreated, [], [])).toBe('2026-05-01T00:00:00Z');
    });

    it('uses item.created_at before synced account metadata', () => {
      const itemWithCreated = { ...mockItem, created_at: '2026-05-01T00:00:00Z' };
      const accounts: Account[] = [
        {
          id: 'item-123',
          rev: 1,
          seq: 1,
          deleted: false,
          kind: 'site',
          platform: 'test',
          display_name: 'test',
          status: 'active',
          metadata_json: { client_created_at: '2026-02-01T00:00:00Z' },
          created_at: '2026-04-01T00:00:00Z',
          updated_at: '2026-06-01T00:00:00Z',
        },
      ];
      expect(resolveItemTimestamp(itemWithCreated, accounts, [])).toBe('2026-05-01T00:00:00Z');
    });

    it('uses synced account metadata before relation timestamps', () => {
      const accounts: Account[] = [
        {
          id: 'item-123',
          rev: 1,
          seq: 1,
          deleted: false,
          kind: 'site',
          platform: 'test',
          display_name: 'test',
          status: 'active',
          metadata_json: { client_created_at: '2026-02-01T00:00:00Z' },
          created_at: '2026-04-01T00:00:00Z',
          updated_at: '2026-06-01T00:00:00Z',
        },
      ];
      const relations: Relation[] = [
        {
          id: 'rel-1',
          rev: 1,
          seq: 1,
          deleted: false,
          kind: 'item_group',
          from_kind: 'account',
          from_id: 'item-123',
          to_kind: 'group',
          to_id: 'group-456',
          created_at: '2026-03-01T00:00:00Z',
          updated_at: '2026-06-01T00:00:00Z',
        },
      ];
      expect(resolveItemTimestamp(mockItem, accounts, relations)).toBe('2026-02-01T00:00:00Z');
    });

    it('uses relation.created_at before account.created_at when metadata is absent', () => {
      const accounts: Account[] = [
        {
          id: 'item-123',
          rev: 1,
          seq: 1,
          deleted: false,
          kind: 'site',
          platform: 'test',
          display_name: 'test',
          status: 'active',
          created_at: '2026-04-01T00:00:00Z',
          updated_at: '2026-06-01T00:00:00Z',
        },
      ];
      const relations: Relation[] = [
        {
          id: 'rel-1',
          rev: 1,
          seq: 1,
          deleted: false,
          kind: 'item_group',
          from_kind: 'account',
          from_id: 'item-123',
          to_kind: 'group',
          to_id: 'group-456',
          created_at: '2026-03-01T00:00:00Z',
          updated_at: '2026-06-01T00:00:00Z',
        },
      ];
      expect(resolveItemTimestamp(mockItem, accounts, relations)).toBe('2026-03-01T00:00:00Z');
    });
  });

  describe('comparePlaintextItems', () => {
    const getType = (item: PlaintextItemWithDates) => {
      if (item.issuer.includes('google')) return 'google';
      if (item.issuer.includes('gpt')) return 'gpt';
      return 'site';
    };

    it('sorts by type priority first', () => {
      const itemA: PlaintextItemWithDates = {
        id: 'item-a',
        group_id: null,
        rev: 1,
        seq: 1,
        deleted: false,
        updated_at: '2026-06-01T00:00:00Z',
        created_at: '2026-06-01T00:00:00Z',
        issuer: 'google',
        account: 'user',
        secret: 'A',
      };
      const itemB: PlaintextItemWithDates = {
        id: 'item-b',
        group_id: null,
        rev: 1,
        seq: 1,
        deleted: false,
        updated_at: '2026-06-20T00:00:00Z',
        issuer: 'gpt',
        account: 'user',
        secret: 'B',
      };

      const res = comparePlaintextItems(itemA, itemB, getType, [], []);
      expect(res).toBeLessThan(0);
    });

    it('sorts by timestamp descending (newer first) if types are the same', () => {
      const itemA: PlaintextItemWithDates = {
        id: 'item-a',
        group_id: null,
        rev: 1,
        seq: 1,
        deleted: false,
        updated_at: '2026-06-01T00:00:00Z',
        created_at: '2026-06-01T00:00:00Z',
        issuer: 'google',
        account: 'user',
        secret: 'A',
      };
      const itemB: PlaintextItemWithDates = {
        id: 'item-b',
        group_id: null,
        rev: 1,
        seq: 1,
        deleted: false,
        updated_at: '2026-06-20T00:00:00Z',
        created_at: '2026-06-20T00:00:00Z',
        issuer: 'google',
        account: 'user',
        secret: 'B',
      };

      const res = comparePlaintextItems(itemA, itemB, getType, [], []);
      expect(res).toBeGreaterThan(0);
    });

    it('uses resolved timestamp for sorting', () => {
      const itemA: PlaintextItemWithDates = {
        id: 'item-a',
        group_id: null,
        rev: 1,
        seq: 1,
        deleted: false,
        updated_at: '2026-06-20T00:00:00Z',
        issuer: 'google',
        account: 'user',
        secret: 'A',
      };
      const itemB: PlaintextItemWithDates = {
        id: 'item-b',
        group_id: null,
        rev: 1,
        seq: 1,
        deleted: false,
        updated_at: '2026-06-15T00:00:00Z',
        issuer: 'google',
        account: 'user',
        secret: 'B',
      };

      const accounts: Account[] = [
        {
          id: 'item-b',
          rev: 1,
          seq: 1,
          deleted: false,
          kind: 'google',
          platform: 'test',
          display_name: 'test',
          status: 'active',
          created_at: '2026-06-25T00:00:00Z',
          updated_at: '2026-06-15T00:00:00Z',
        }
      ];

      const res = comparePlaintextItems(itemA, itemB, getType, accounts, []);
      expect(res).toBeGreaterThan(0);
    });

    it('falls back to name tie breaker if types and timestamps match', () => {
      const itemA: PlaintextItemWithDates = {
        id: 'item-a',
        group_id: null,
        rev: 1,
        seq: 1,
        deleted: false,
        updated_at: '2026-06-20T00:00:00Z',
        issuer: 'google',
        account: 'alice',
        secret: 'A',
      };
      const itemB: PlaintextItemWithDates = {
        id: 'item-b',
        group_id: null,
        rev: 1,
        seq: 1,
        deleted: false,
        updated_at: '2026-06-20T00:00:00Z',
        issuer: 'google',
        account: 'bob',
        secret: 'B',
      };

      const res = comparePlaintextItems(itemA, itemB, getType, [], []);
      expect(res).toBeLessThan(0);
    });
  });
});
