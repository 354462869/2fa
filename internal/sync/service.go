package sync

import (
	"context"

	"github.com/daling/2fa/internal/storage"
)

type Service struct {
	store storage.Store
}

func NewService(store storage.Store) *Service {
	return &Service{store: store}
}

func (s *Service) GetVault(ctx context.Context, userID string) (*storage.Vault, error) {
	return s.store.GetOrCreateVault(ctx, userID)
}

func (s *Service) UpdateEnvelope(ctx context.Context, userID string, expectedRev *int64, envelope []byte) (*storage.Vault, error) {
	return s.store.UpdateVaultEnvelope(ctx, userID, expectedRev, envelope)
}

func (s *Service) Pull(ctx context.Context, userID string, sinceSeq int64, limit int) ([]*storage.Item, []*storage.Group, []*storage.Account, []*storage.Relation, int64, bool, error) {
	return s.store.PullRecords(ctx, userID, sinceSeq, limit)
}

func (s *Service) Push(ctx context.Context, userID string, items []storage.PushItemInput, groups []storage.PushGroupInput, accounts []storage.PushAccountInput, relations []storage.PushRelationInput) ([]storage.AppliedResult, []storage.ConflictResult, int64, error) {
	return s.store.PushRecords(ctx, userID, items, groups, accounts, relations)
}

func (s *Service) GetItem(ctx context.Context, userID, itemID string) (*storage.Item, error) {
	return s.store.GetItem(ctx, userID, itemID)
}

func (s *Service) GetGroup(ctx context.Context, userID, groupID string) (*storage.Group, error) {
	return s.store.GetGroup(ctx, userID, groupID)
}

func (s *Service) GetAccount(ctx context.Context, userID, accountID string) (*storage.Account, error) {
	return s.store.GetAccount(ctx, userID, accountID)
}

func (s *Service) GetRelation(ctx context.Context, userID, relationID string) (*storage.Relation, error) {
	return s.store.GetRelation(ctx, userID, relationID)
}
