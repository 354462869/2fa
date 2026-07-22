package http

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/daling/2fa/internal/auth"
	"github.com/daling/2fa/internal/storage"
	"github.com/daling/2fa/internal/sync"
)

var (
	errMissingCredentials = errors.New("missing credentials")
	errAdminRequired      = errors.New("admin required")
)

type handlers struct {
	auth   *auth.Service
	sync   *sync.Service
	store  storage.Store
	logger *slog.Logger
}

func (h *handlers) handleRegister(w http.ResponseWriter, r *http.Request) {
	var req RegisterRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", "Invalid JSON")
		return
	}

	if len(req.Username) < 3 || len(req.Username) > 64 {
		writeError(w, http.StatusBadRequest, "invalid_username", "Username must be 3-64 characters")
		return
	}
	if len(req.Password) < 12 || len(req.Password) > 256 {
		writeError(w, http.StatusBadRequest, "invalid_password", "Password must be 12-256 characters")
		return
	}

	hash, err := h.auth.HashPassword(req.Password)
	if err != nil {
		h.logger.Error("hash password failed", "err", err)
		writeError(w, http.StatusInternalServerError, "internal_error", "Failed to process request")
		return
	}

	userID, err := auth.GenerateID()
	if err != nil {
		h.logger.Error("generate ID failed", "err", err)
		writeError(w, http.StatusInternalServerError, "internal_error", "Failed to process request")
		return
	}

	now := time.Now().UTC()
	user := &storage.User{
		ID:           userID,
		Username:     req.Username,
		PasswordHash: hash,
		Role:         "user",
		Disabled:     false,
		CreatedAt:    now,
		UpdatedAt:    now,
	}

	if err := h.store.CreateUser(r.Context(), user); err != nil {
		if errors.Is(err, storage.ErrUserExists) {
			writeError(w, http.StatusConflict, "user_exists", "Username already taken")
			return
		}
		h.logger.Error("create user failed", "err", err)
		writeError(w, http.StatusInternalServerError, "internal_error", "Failed to create user")
		return
	}

	token, expiresAt, err := h.auth.CreateSession(r.Context(), user.ID, "")
	if err != nil {
		h.logger.Error("create session failed", "err", err)
		writeError(w, http.StatusInternalServerError, "internal_error", "Failed to create session")
		return
	}

	h.audit(r.Context(), "user", &user.ID, "auth.register", nil, nil, r)

	writeJSON(w, http.StatusCreated, SessionResponse{
		Token: token,
		User: UserMe{
			ID:        user.ID,
			Username:  user.Username,
			Role:      user.Role,
			Disabled:  user.Disabled,
			CreatedAt: user.CreatedAt,
		},
		ExpiresAt: expiresAt,
	})
}

func (h *handlers) handleLogin(w http.ResponseWriter, r *http.Request) {
	var req LoginRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", "Invalid JSON")
		return
	}

	user, err := h.store.GetUserByUsername(r.Context(), req.Username)
	if err != nil {
		if errors.Is(err, storage.ErrNotFound) {
			h.auth.BurnInvalidPassword(req.Password)
			writeError(w, http.StatusUnauthorized, "auth.invalid_credentials", "Invalid username or password")
			return
		}
		h.logger.Error("get user failed", "err", err)
		writeError(w, http.StatusInternalServerError, "internal_error", "Failed to process request")
		return
	}

	valid, err := h.auth.VerifyPassword(req.Password, user.PasswordHash)
	if err != nil {
		h.logger.Error("verify password failed", "err", err)
		writeError(w, http.StatusInternalServerError, "internal_error", "Failed to process request")
		return
	}
	if !valid {
		writeError(w, http.StatusUnauthorized, "auth.invalid_credentials", "Invalid username or password")
		return
	}

	if user.Disabled {
		writeError(w, http.StatusUnauthorized, "auth.user_disabled", "Account is disabled")
		return
	}

	deviceID := ""
	if req.DeviceID != nil {
		deviceID = *req.DeviceID
		device, err := h.store.GetDevice(r.Context(), deviceID)
		if err != nil || device.UserID != user.ID || device.Revoked {
			writeError(w, http.StatusUnauthorized, "auth.invalid_credentials", "Invalid username or password")
			return
		}
	}

	token, expiresAt, err := h.auth.CreateSession(r.Context(), user.ID, deviceID)
	if err != nil {
		h.logger.Error("create session failed", "err", err)
		writeError(w, http.StatusInternalServerError, "internal_error", "Failed to create session")
		return
	}

	h.audit(r.Context(), "user", &user.ID, "auth.login", nil, nil, r)

	writeJSON(w, http.StatusOK, SessionResponse{
		Token: token,
		User: UserMe{
			ID:        user.ID,
			Username:  user.Username,
			Role:      user.Role,
			Disabled:  user.Disabled,
			CreatedAt: user.CreatedAt,
		},
		ExpiresAt: expiresAt,
	})
}

func (h *handlers) handleLogout(w http.ResponseWriter, r *http.Request) {
	token := extractToken(r)
	if token == "" {
		writeError(w, http.StatusUnauthorized, "auth.unauthorized", "Missing or invalid token")
		return
	}

	user, _, err := h.auth.ValidateSession(r.Context(), token)
	if err != nil {
		writeAuthError(w, err)
		return
	}

	if err := h.auth.DeleteSession(r.Context(), token); err != nil {
		h.logger.Error("delete session failed", "err", err)
	}

	h.audit(r.Context(), "user", &user.ID, "auth.logout", nil, nil, r)

	w.WriteHeader(http.StatusNoContent)
}

func (h *handlers) handleMe(w http.ResponseWriter, r *http.Request) {
	user, _, err := h.requireAuth(r)
	if err != nil {
		writeAuthError(w, err)
		return
	}

	writeJSON(w, http.StatusOK, UserMe{
		ID:        user.ID,
		Username:  user.Username,
		Role:      user.Role,
		Disabled:  user.Disabled,
		CreatedAt: user.CreatedAt,
	})
}

func (h *handlers) handleChangePassword(w http.ResponseWriter, r *http.Request) {
	user, _, err := h.requireAuth(r)
	if err != nil {
		writeAuthError(w, err)
		return
	}

	var req ChangePasswordRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", "Invalid JSON")
		return
	}

	valid, err := h.auth.VerifyPassword(req.CurrentPassword, user.PasswordHash)
	if err != nil {
		h.logger.Error("verify password failed", "err", err)
		writeError(w, http.StatusInternalServerError, "internal_error", "Failed to process request")
		return
	}
	if !valid {
		writeError(w, http.StatusUnauthorized, "auth.invalid_credentials", "Current password is incorrect")
		return
	}

	if len(req.NewPassword) < 12 || len(req.NewPassword) > 256 {
		writeError(w, http.StatusBadRequest, "invalid_password", "Password must be 12-256 characters")
		return
	}

	newHash, err := h.auth.HashPassword(req.NewPassword)
	if err != nil {
		h.logger.Error("hash password failed", "err", err)
		writeError(w, http.StatusInternalServerError, "internal_error", "Failed to process request")
		return
	}

	if err := h.store.UpdateUserPassword(r.Context(), user.ID, newHash); err != nil {
		h.logger.Error("update password failed", "err", err)
		writeError(w, http.StatusInternalServerError, "internal_error", "Failed to update password")
		return
	}

	h.audit(r.Context(), "user", &user.ID, "auth.password_change", nil, nil, r)

	w.WriteHeader(http.StatusNoContent)
}

func (h *handlers) handleListDevices(w http.ResponseWriter, r *http.Request) {
	user, _, err := h.requireAuth(r)
	if err != nil {
		writeAuthError(w, err)
		return
	}

	devices, err := h.store.ListDevicesByUser(r.Context(), user.ID)
	if err != nil {
		h.logger.Error("list devices failed", "err", err)
		writeError(w, http.StatusInternalServerError, "internal_error", "Failed to list devices")
		return
	}

	resp := make([]DeviceResponse, 0, len(devices))
	for _, d := range devices {
		resp = append(resp, DeviceResponse{
			ID:         d.ID,
			Label:      d.Label,
			CreatedAt:  d.CreatedAt,
			LastSeenAt: d.LastSeenAt,
			Revoked:    d.Revoked,
		})
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{"devices": resp})
}

func (h *handlers) handleRegisterDevice(w http.ResponseWriter, r *http.Request) {
	user, _, err := h.requireAuth(r)
	if err != nil {
		writeAuthError(w, err)
		return
	}

	var req RegisterDeviceRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", "Invalid JSON")
		return
	}

	if len(req.ID) < 8 || len(req.ID) > 64 {
		writeError(w, http.StatusBadRequest, "invalid_device_id", "Invalid device ID")
		return
	}
	if len(req.Label) > 100 {
		writeError(w, http.StatusBadRequest, "invalid_label", "Label too long")
		return
	}

	now := time.Now().UTC()
	device := &storage.Device{
		ID:         req.ID,
		UserID:     user.ID,
		Label:      req.Label,
		Revoked:    false,
		LastSeenAt: now,
		CreatedAt:  now,
	}

	if err := h.auth.CreateDeviceAndBindSession(r.Context(), device, extractToken(r)); err != nil {
		if errors.Is(err, storage.ErrDeviceExists) {
			writeError(w, http.StatusConflict, "device_exists", "Device ID already registered")
			return
		}
		if errors.Is(err, storage.ErrNotFound) {
			writeError(w, http.StatusUnauthorized, "auth.unauthorized", "Missing or invalid credentials")
			return
		}
		h.logger.Error("create device and bind session failed", "err", err)
		writeError(w, http.StatusInternalServerError, "internal_error", "Failed to register device")
		return
	}

	h.audit(r.Context(), "user", &user.ID, "device.register", strPtr("device"), &device.ID, r)

	writeJSON(w, http.StatusCreated, DeviceResponse{
		ID:         device.ID,
		Label:      device.Label,
		CreatedAt:  device.CreatedAt,
		LastSeenAt: device.LastSeenAt,
		Revoked:    device.Revoked,
	})
}

func (h *handlers) handleRevokeDevice(w http.ResponseWriter, r *http.Request) {
	user, _, err := h.requireAuth(r)
	if err != nil {
		writeAuthError(w, err)
		return
	}

	deviceID := r.PathValue("deviceId")
	device, err := h.store.GetDevice(r.Context(), deviceID)
	if err != nil {
		if errors.Is(err, storage.ErrNotFound) {
			writeError(w, http.StatusNotFound, "device.not_found", "Device not found")
			return
		}
		h.logger.Error("get device failed", "err", err)
		writeError(w, http.StatusInternalServerError, "internal_error", "Failed to revoke device")
		return
	}

	if device.UserID != user.ID {
		writeError(w, http.StatusNotFound, "device.not_found", "Device not found")
		return
	}

	if err := h.store.RevokeDevice(r.Context(), deviceID); err != nil {
		h.logger.Error("revoke device failed", "err", err)
		writeError(w, http.StatusInternalServerError, "internal_error", "Failed to revoke device")
		return
	}

	h.audit(r.Context(), "user", &user.ID, "device.revoke", strPtr("device"), &deviceID, r)

	w.WriteHeader(http.StatusNoContent)
}

func (h *handlers) handleGetVault(w http.ResponseWriter, r *http.Request) {
	user, _, err := h.requireAuth(r)
	if err != nil {
		writeAuthError(w, err)
		return
	}

	if user.Disabled {
		writeError(w, http.StatusForbidden, "auth.user_disabled", "Account is disabled")
		return
	}

	vault, err := h.sync.GetVault(r.Context(), user.ID)
	if err != nil {
		h.logger.Error("get vault failed", "err", err)
		writeError(w, http.StatusInternalServerError, "internal_error", "Failed to get vault")
		return
	}

	writeJSON(w, http.StatusOK, vaultToResponse(vault))
}

func (h *handlers) handlePutEnvelope(w http.ResponseWriter, r *http.Request) {
	user, _, err := h.requireAuth(r)
	if err != nil {
		writeAuthError(w, err)
		return
	}

	if user.Disabled {
		writeError(w, http.StatusForbidden, "auth.user_disabled", "Account is disabled")
		return
	}

	var req PutEnvelopeRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", "Invalid JSON")
		return
	}

	if err := guardSyncPasswordLeak(req.Envelope); err != nil {
		writeError(w, http.StatusBadRequest, "envelope.invalid", err.Error())
		return
	}

	envelopeBytes, err := json.Marshal(req.Envelope)
	if err != nil {
		writeError(w, http.StatusBadRequest, "envelope.invalid", "Invalid envelope")
		return
	}

	if _, err := h.store.GetOrCreateVault(r.Context(), user.ID); err != nil {
		h.logger.Error("get/create vault failed", "err", err)
		writeError(w, http.StatusInternalServerError, "internal_error", "Failed to update envelope")
		return
	}

	vault, err := h.sync.UpdateEnvelope(r.Context(), user.ID, req.ExpectedRev, envelopeBytes)
	if err != nil {
		if errors.Is(err, storage.ErrConflict) {
			writeJSON(w, http.StatusConflict, vaultToResponse(vault))
			return
		}
		h.logger.Error("update envelope failed", "err", err)
		writeError(w, http.StatusInternalServerError, "internal_error", "Failed to update envelope")
		return
	}

	h.audit(r.Context(), "user", &user.ID, "sync.envelope_update", nil, nil, r)

	writeJSON(w, http.StatusOK, vaultToResponse(vault))
}

func (h *handlers) handlePull(w http.ResponseWriter, r *http.Request) {
	user, _, err := h.requireAuth(r)
	if err != nil {
		writeAuthError(w, err)
		return
	}

	if user.Disabled {
		writeError(w, http.StatusForbidden, "auth.user_disabled", "Account is disabled")
		return
	}

	var req PullRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", "Invalid JSON")
		return
	}

	limit := req.Limit
	if limit <= 0 {
		limit = 500
	}
	if limit > 1000 {
		limit = 1000
	}

	if _, err := h.store.GetOrCreateVault(r.Context(), user.ID); err != nil {
		h.logger.Error("get/create vault failed", "err", err)
		writeError(w, http.StatusInternalServerError, "internal_error", "Failed to pull")
		return
	}

	items, groups, accounts, relations, nextSeq, hasMore, err := h.sync.Pull(r.Context(), user.ID, req.SinceSeq, limit)
	if err != nil {
		h.logger.Error("pull failed", "err", err)
		writeError(w, http.StatusInternalServerError, "internal_error", "Failed to pull")
		return
	}

	resp := PullResponse{
		Items:     make([]ItemResponse, 0, len(items)),
		Groups:    make([]GroupResponse, 0, len(groups)),
		Accounts:  make([]AccountResponse, 0, len(accounts)),
		Relations: make([]RelationResponse, 0, len(relations)),
		NextSeq:   nextSeq,
		HasMore:   hasMore,
	}
	for _, item := range items {
		resp.Items = append(resp.Items, itemToResponse(item))
	}
	for _, group := range groups {
		resp.Groups = append(resp.Groups, groupToResponse(group))
	}
	for _, account := range accounts {
		resp.Accounts = append(resp.Accounts, accountToResponse(account))
	}
	for _, relation := range relations {
		resp.Relations = append(resp.Relations, relationToResponse(relation))
	}

	writeJSON(w, http.StatusOK, resp)
}

func (h *handlers) handlePush(w http.ResponseWriter, r *http.Request) {
	user, _, err := h.requireAuth(r)
	if err != nil {
		writeAuthError(w, err)
		return
	}

	if user.Disabled {
		writeError(w, http.StatusForbidden, "auth.user_disabled", "Account is disabled")
		return
	}

	bodyBytes, err := io.ReadAll(io.LimitReader(r.Body, 16*1024*1024))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", "Failed to read body")
		return
	}

	var req PushRequest
	if err := decodeJSONBytes(bodyBytes, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", "Invalid JSON")
		return
	}

	if _, err := h.store.GetOrCreateVault(r.Context(), user.ID); err != nil {
		h.logger.Error("get/create vault failed", "err", err)
		writeError(w, http.StatusInternalServerError, "internal_error", "Failed to push")
		return
	}

	itemInputs := make([]storage.PushItemInput, 0, len(req.Items))
	for _, item := range req.Items {
		if !item.Deleted && item.Ciphertext == nil {
			writeError(w, http.StatusBadRequest, "invalid_item", "Non-deleted item requires ciphertext")
			return
		}
		var ctBytes []byte
		if item.Ciphertext != nil {
			b, _ := json.Marshal(item.Ciphertext)
			ctBytes = b
		}
		itemInputs = append(itemInputs, storage.PushItemInput{
			ID:          item.ID,
			GroupID:     item.GroupID,
			Deleted:     item.Deleted,
			ExpectedRev: item.ExpectedRev,
			Ciphertext:  ctBytes,
		})
	}

	groupInputs := make([]storage.PushGroupInput, 0, len(req.Groups))
	for _, group := range req.Groups {
		if !group.Deleted && group.Ciphertext == nil {
			writeError(w, http.StatusBadRequest, "invalid_group", "Non-deleted group requires ciphertext")
			return
		}
		var ctBytes []byte
		if group.Ciphertext != nil {
			b, _ := json.Marshal(group.Ciphertext)
			ctBytes = b
		}
		groupInputs = append(groupInputs, storage.PushGroupInput{
			ID:          group.ID,
			Deleted:     group.Deleted,
			SortIndex:   group.SortIndex,
			ExpectedRev: group.ExpectedRev,
			Ciphertext:  ctBytes,
		})
	}

	accountInputs := make([]storage.PushAccountInput, 0, len(req.Accounts))
	for _, account := range req.Accounts {
		if !account.Deleted && account.SecretCiphertext == nil {
			writeError(w, http.StatusBadRequest, "invalid_account", "Non-deleted account requires secret_ciphertext")
			return
		}
		var secretBytes []byte
		if account.SecretCiphertext != nil {
			b, _ := json.Marshal(account.SecretCiphertext)
			secretBytes = b
		}
		accountInputs = append(accountInputs, storage.PushAccountInput{
			ID:                  account.ID,
			Deleted:             account.Deleted,
			Kind:                account.Kind,
			Platform:            account.Platform,
			DisplayName:         account.DisplayName,
			LoginIdentifier:     account.LoginIdentifier,
			LoginIdentifierHash: account.LoginIdentifierHash,
			Status:              account.Status,
			TagsJSON:            []byte(account.TagsJSON),
			MetadataJSON:        []byte(account.MetadataJSON),
			ExpectedRev:         account.ExpectedRev,
			SecretCiphertext:    secretBytes,
		})
	}

	relationInputs := make([]storage.PushRelationInput, 0, len(req.Relations))
	for _, relation := range req.Relations {
		var secretBytes []byte
		if relation.SecretCiphertext != nil {
			b, _ := json.Marshal(relation.SecretCiphertext)
			secretBytes = b
		}
		kind := relation.Kind
		if kind == "" {
			kind = relation.RelationType
		}
		fromKind := relation.FromKind
		fromID := relation.FromID
		if fromID == "" && relation.FromAccountID != "" {
			fromID = relation.FromAccountID
			if fromKind == "" {
				fromKind = "account"
			}
		}
		toKind := relation.ToKind
		toID := relation.ToID
		if toID == "" && relation.ToAccountID != "" {
			toID = relation.ToAccountID
			if toKind == "" {
				toKind = "account"
			}
		}
		relationInputs = append(relationInputs, storage.PushRelationInput{
			ID:               relation.ID,
			Deleted:          relation.Deleted,
			Kind:             kind,
			FromKind:         fromKind,
			FromID:           fromID,
			ToKind:           toKind,
			ToID:             toID,
			MetadataJSON:     []byte(relation.MetadataJSON),
			ExpectedRev:      relation.ExpectedRev,
			SecretCiphertext: secretBytes,
		})
	}

	applied, conflicts, nextSeq, err := h.sync.Push(r.Context(), user.ID, itemInputs, groupInputs, accountInputs, relationInputs)
	if err != nil {
		h.logger.Error("push failed", "err", err)
		writeError(w, http.StatusInternalServerError, "internal_error", "Failed to push")
		return
	}

	resp := PushResponse{
		Applied:   make([]AppliedRecord, 0, len(applied)),
		Conflicts: make([]ConflictRecord, 0, len(conflicts)),
		NextSeq:   nextSeq,
	}
	for _, a := range applied {
		resp.Applied = append(resp.Applied, AppliedRecord{
			ID:   a.ID,
			Kind: a.Kind,
			Rev:  a.Rev,
			Seq:  a.Seq,
		})
	}
	for _, c := range conflicts {
		cr := ConflictRecord{
			ID:         c.ID,
			Kind:       c.Kind,
			CurrentRev: c.CurrentRev,
			CurrentSeq: c.CurrentSeq,
		}
		if c.Kind == "item" {
			if it, ok := c.Current.(*storage.Item); ok && it != nil {
				resp := itemToResponse(it)
				cr.CurrentItem = &resp
			}
		} else if c.Kind == "group" {
			if g, ok := c.Current.(*storage.Group); ok && g != nil {
				resp := groupToResponse(g)
				cr.CurrentGroup = &resp
			}
		} else if c.Kind == "account" {
			if a, ok := c.Current.(*storage.Account); ok && a != nil {
				resp := accountToResponse(a)
				cr.CurrentAccount = &resp
			}
		} else if c.Kind == "relation" {
			if rel, ok := c.Current.(*storage.Relation); ok && rel != nil {
				resp := relationToResponse(rel)
				cr.CurrentRelation = &resp
			}
		}
		resp.Conflicts = append(resp.Conflicts, cr)
	}

	if len(applied) > 0 {
		h.audit(r.Context(), "user", &user.ID, "sync.push", nil, nil, r)
	}

	writeJSON(w, http.StatusOK, resp)
}

func (h *handlers) handleGetItem(w http.ResponseWriter, r *http.Request) {
	user, _, err := h.requireAuth(r)
	if err != nil {
		writeAuthError(w, err)
		return
	}

	if user.Disabled {
		writeError(w, http.StatusForbidden, "auth.user_disabled", "Account is disabled")
		return
	}

	itemID := r.PathValue("itemId")
	item, err := h.sync.GetItem(r.Context(), user.ID, itemID)
	if err != nil {
		if errors.Is(err, storage.ErrNotFound) {
			writeError(w, http.StatusNotFound, "item.not_found", "Item not found")
			return
		}
		h.logger.Error("get item failed", "err", err)
		writeError(w, http.StatusInternalServerError, "internal_error", "Failed to get item")
		return
	}

	writeJSON(w, http.StatusOK, itemToResponse(item))
}

func (h *handlers) handleGetGroup(w http.ResponseWriter, r *http.Request) {
	user, _, err := h.requireAuth(r)
	if err != nil {
		writeAuthError(w, err)
		return
	}

	if user.Disabled {
		writeError(w, http.StatusForbidden, "auth.user_disabled", "Account is disabled")
		return
	}

	groupID := r.PathValue("groupId")
	group, err := h.sync.GetGroup(r.Context(), user.ID, groupID)
	if err != nil {
		if errors.Is(err, storage.ErrNotFound) {
			writeError(w, http.StatusNotFound, "group.not_found", "Group not found")
			return
		}
		h.logger.Error("get group failed", "err", err)
		writeError(w, http.StatusInternalServerError, "internal_error", "Failed to get group")
		return
	}

	writeJSON(w, http.StatusOK, groupToResponse(group))
}

func (h *handlers) handleGetAccount(w http.ResponseWriter, r *http.Request) {
	user, _, err := h.requireAuth(r)
	if err != nil {
		writeAuthError(w, err)
		return
	}

	if user.Disabled {
		writeError(w, http.StatusForbidden, "auth.user_disabled", "Account is disabled")
		return
	}

	accountID := r.PathValue("accountId")
	account, err := h.sync.GetAccount(r.Context(), user.ID, accountID)
	if err != nil {
		if errors.Is(err, storage.ErrNotFound) {
			writeError(w, http.StatusNotFound, "account.not_found", "Account not found")
			return
		}
		h.logger.Error("get account failed", "err", err)
		writeError(w, http.StatusInternalServerError, "internal_error", "Failed to get account")
		return
	}

	writeJSON(w, http.StatusOK, accountToResponse(account))
}

func (h *handlers) handleGetRelation(w http.ResponseWriter, r *http.Request) {
	user, _, err := h.requireAuth(r)
	if err != nil {
		writeAuthError(w, err)
		return
	}

	if user.Disabled {
		writeError(w, http.StatusForbidden, "auth.user_disabled", "Account is disabled")
		return
	}

	relationID := r.PathValue("relationId")
	relation, err := h.sync.GetRelation(r.Context(), user.ID, relationID)
	if err != nil {
		if errors.Is(err, storage.ErrNotFound) {
			writeError(w, http.StatusNotFound, "relation.not_found", "Relation not found")
			return
		}
		h.logger.Error("get relation failed", "err", err)
		writeError(w, http.StatusInternalServerError, "internal_error", "Failed to get relation")
		return
	}

	writeJSON(w, http.StatusOK, relationToResponse(relation))
}

func (h *handlers) handleAdminLogin(w http.ResponseWriter, r *http.Request) {
	var req LoginRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", "Invalid JSON")
		return
	}

	user, err := h.store.GetUserByUsername(r.Context(), req.Username)
	if err != nil {
		if errors.Is(err, storage.ErrNotFound) {
			h.auth.BurnInvalidPassword(req.Password)
			writeError(w, http.StatusUnauthorized, "auth.invalid_credentials", "Invalid credentials")
			return
		}
		writeError(w, http.StatusInternalServerError, "internal_error", "Failed to process request")
		return
	}

	valid, err := h.auth.VerifyPassword(req.Password, user.PasswordHash)
	if err != nil || !valid {
		writeError(w, http.StatusUnauthorized, "auth.invalid_credentials", "Invalid credentials")
		return
	}
	if user.Role != "admin" {
		writeError(w, http.StatusUnauthorized, "auth.invalid_credentials", "Invalid credentials")
		return
	}

	if user.Disabled {
		writeError(w, http.StatusForbidden, "auth.user_disabled", "Account is disabled")
		return
	}

	token, expiresAt, err := h.auth.CreateSession(r.Context(), user.ID, "")
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error", "Failed to create session")
		return
	}

	h.audit(r.Context(), "admin", &user.ID, "admin.login", nil, nil, r)

	writeJSON(w, http.StatusOK, SessionResponse{
		Token: token,
		User: UserMe{
			ID:        user.ID,
			Username:  user.Username,
			Role:      user.Role,
			Disabled:  user.Disabled,
			CreatedAt: user.CreatedAt,
		},
		ExpiresAt: expiresAt,
	})
}

func (h *handlers) handleAdminSetupStatus(w http.ResponseWriter, r *http.Request) {
	count, err := h.store.CountUsers(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error", "Failed to inspect setup state")
		return
	}

	writeJSON(w, http.StatusOK, AdminSetupStatusResponse{NeedsSetup: count == 0})
}

func (h *handlers) handleAdminSetup(w http.ResponseWriter, r *http.Request) {
	count, err := h.store.CountUsers(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error", "Failed to inspect setup state")
		return
	}
	if count != 0 {
		writeError(w, http.StatusConflict, "setup.already_initialized", "Server is already initialized")
		return
	}

	var req RegisterRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", "Invalid JSON")
		return
	}
	if len(req.Username) < 3 || len(req.Username) > 64 {
		writeError(w, http.StatusBadRequest, "invalid_username", "Username must be 3-64 characters")
		return
	}
	if len(req.Password) < 12 || len(req.Password) > 256 {
		writeError(w, http.StatusBadRequest, "invalid_password", "Password must be 12-256 characters")
		return
	}

	hash, err := h.auth.HashPassword(req.Password)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error", "Failed to process request")
		return
	}
	userID, err := auth.GenerateID()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error", "Failed to process request")
		return
	}

	now := time.Now().UTC()
	user := &storage.User{
		ID:           userID,
		Username:     req.Username,
		PasswordHash: hash,
		Role:         "admin",
		Disabled:     false,
		CreatedAt:    now,
		UpdatedAt:    now,
	}
	if err := h.store.CreateUser(r.Context(), user); err != nil {
		if errors.Is(err, storage.ErrUserExists) {
			writeError(w, http.StatusConflict, "setup.already_initialized", "Server is already initialized")
			return
		}
		writeError(w, http.StatusInternalServerError, "internal_error", "Failed to create admin user")
		return
	}

	token, expiresAt, err := h.auth.CreateSession(r.Context(), user.ID, "")
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error", "Failed to create session")
		return
	}

	h.audit(r.Context(), "system", nil, "admin.setup", strPtr("user"), &user.ID, r)

	writeJSON(w, http.StatusCreated, SessionResponse{
		Token: token,
		User: UserMe{
			ID:        user.ID,
			Username:  user.Username,
			Role:      user.Role,
			Disabled:  user.Disabled,
			CreatedAt: user.CreatedAt,
		},
		ExpiresAt: expiresAt,
	})
}

func (h *handlers) handleAdminListUsers(w http.ResponseWriter, r *http.Request) {
	_, err := h.requireAdmin(r)
	if err != nil {
		writeAuthError(w, err)
		return
	}

	limit := 50
	if l := r.URL.Query().Get("limit"); l != "" {
		if n, err := strconv.Atoi(l); err == nil && n > 0 && n <= 200 {
			limit = n
		}
	}
	cursor := r.URL.Query().Get("cursor")

	users, nextCursor, err := h.store.ListUsers(r.Context(), limit, cursor)
	if err != nil {
		h.logger.Error("list users failed", "err", err)
		writeError(w, http.StatusInternalServerError, "internal_error", "Failed to list users")
		return
	}

	resp := AdminUserPage{Users: make([]AdminUser, 0, len(users))}
	for _, u := range users {
		deviceCount, lastSyncAt, ctBytes, _ := h.store.GetUserStats(r.Context(), u.ID)
		resp.Users = append(resp.Users, AdminUser{
			ID:              u.ID,
			Username:        u.Username,
			Role:            u.Role,
			Disabled:        u.Disabled,
			DeviceCount:     deviceCount,
			LastSyncAt:      lastSyncAt,
			CiphertextBytes: ctBytes,
			CreatedAt:       u.CreatedAt,
		})
	}
	if nextCursor != "" {
		resp.NextCursor = &nextCursor
	}

	writeJSON(w, http.StatusOK, resp)
}

func (h *handlers) handleAdminGetUser(w http.ResponseWriter, r *http.Request) {
	_, err := h.requireAdmin(r)
	if err != nil {
		writeAuthError(w, err)
		return
	}

	userID := r.PathValue("userId")
	user, err := h.store.GetUserByID(r.Context(), userID)
	if err != nil {
		if errors.Is(err, storage.ErrNotFound) {
			writeError(w, http.StatusNotFound, "user.not_found", "User not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "internal_error", "Failed to get user")
		return
	}

	deviceCount, lastSyncAt, ctBytes, _ := h.store.GetUserStats(r.Context(), user.ID)

	writeJSON(w, http.StatusOK, AdminUser{
		ID:              user.ID,
		Username:        user.Username,
		Role:            user.Role,
		Disabled:        user.Disabled,
		DeviceCount:     deviceCount,
		LastSyncAt:      lastSyncAt,
		CiphertextBytes: ctBytes,
		CreatedAt:       user.CreatedAt,
	})
}

func (h *handlers) handleAdminDisableUser(w http.ResponseWriter, r *http.Request) {
	admin, err := h.requireAdmin(r)
	if err != nil {
		writeAuthError(w, err)
		return
	}

	userID := r.PathValue("userId")
	if _, err := h.store.GetUserByID(r.Context(), userID); err != nil {
		if errors.Is(err, storage.ErrNotFound) {
			writeError(w, http.StatusNotFound, "user.not_found", "User not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "internal_error", "Failed to disable user")
		return
	}

	if err := h.store.SetUserDisabled(r.Context(), userID, true); err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error", "Failed to disable user")
		return
	}
	h.store.DeleteSessionsByUser(r.Context(), userID)

	h.audit(r.Context(), "admin", &admin.ID, "admin.user.disable", strPtr("user"), &userID, r)

	w.WriteHeader(http.StatusNoContent)
}

func (h *handlers) handleAdminEnableUser(w http.ResponseWriter, r *http.Request) {
	admin, err := h.requireAdmin(r)
	if err != nil {
		writeAuthError(w, err)
		return
	}

	userID := r.PathValue("userId")
	if _, err := h.store.GetUserByID(r.Context(), userID); err != nil {
		if errors.Is(err, storage.ErrNotFound) {
			writeError(w, http.StatusNotFound, "user.not_found", "User not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "internal_error", "Failed to enable user")
		return
	}

	if err := h.store.SetUserDisabled(r.Context(), userID, false); err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error", "Failed to enable user")
		return
	}

	h.audit(r.Context(), "admin", &admin.ID, "admin.user.enable", strPtr("user"), &userID, r)

	w.WriteHeader(http.StatusNoContent)
}

func (h *handlers) handleAdminListUserDevices(w http.ResponseWriter, r *http.Request) {
	if _, err := h.requireAdmin(r); err != nil {
		writeAuthError(w, err)
		return
	}

	userID := r.PathValue("userId")
	if _, err := h.store.GetUserByID(r.Context(), userID); err != nil {
		if errors.Is(err, storage.ErrNotFound) {
			writeError(w, http.StatusNotFound, "user.not_found", "User not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "internal_error", "Failed to list devices")
		return
	}

	devices, err := h.store.ListDevicesByUser(r.Context(), userID)
	if err != nil {
		h.logger.Error("admin list user devices failed", "err", err)
		writeError(w, http.StatusInternalServerError, "internal_error", "Failed to list devices")
		return
	}

	resp := make([]DeviceResponse, 0, len(devices))
	for _, d := range devices {
		resp = append(resp, DeviceResponse{
			ID:         d.ID,
			Label:      d.Label,
			CreatedAt:  d.CreatedAt,
			LastSeenAt: d.LastSeenAt,
			Revoked:    d.Revoked,
		})
	}

	writeJSON(w, http.StatusOK, map[string]any{"devices": resp})
}

func (h *handlers) handleAdminListUserAccounts(w http.ResponseWriter, r *http.Request) {
	if _, err := h.requireAdmin(r); err != nil {
		writeAuthError(w, err)
		return
	}

	userID := r.PathValue("userId")
	if _, err := h.store.GetUserByID(r.Context(), userID); err != nil {
		if errors.Is(err, storage.ErrNotFound) {
			writeError(w, http.StatusNotFound, "user.not_found", "User not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "internal_error", "Failed to list accounts")
		return
	}

	accounts, err := h.store.ListAccountsByUser(r.Context(), userID)
	if err != nil {
		h.logger.Error("admin list user accounts failed", "err", err)
		writeError(w, http.StatusInternalServerError, "internal_error", "Failed to list accounts")
		return
	}

	resp := AdminAccountPage{Accounts: make([]AdminAccount, 0, len(accounts))}
	for _, account := range accounts {
		resp.Accounts = append(resp.Accounts, accountToAdmin(account))
	}
	writeJSON(w, http.StatusOK, resp)
}

func (h *handlers) handleAdminListUserRelations(w http.ResponseWriter, r *http.Request) {
	if _, err := h.requireAdmin(r); err != nil {
		writeAuthError(w, err)
		return
	}

	userID := r.PathValue("userId")
	if _, err := h.store.GetUserByID(r.Context(), userID); err != nil {
		if errors.Is(err, storage.ErrNotFound) {
			writeError(w, http.StatusNotFound, "user.not_found", "User not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "internal_error", "Failed to list relations")
		return
	}

	relations, err := h.store.ListRelationsByUser(r.Context(), userID)
	if err != nil {
		h.logger.Error("admin list user relations failed", "err", err)
		writeError(w, http.StatusInternalServerError, "internal_error", "Failed to list relations")
		return
	}

	resp := AdminRelationPage{Relations: make([]AdminRelation, 0, len(relations))}
	for _, relation := range relations {
		resp.Relations = append(resp.Relations, relationToAdmin(relation))
	}
	writeJSON(w, http.StatusOK, resp)
}

func (h *handlers) handleAdminRevokeDevice(w http.ResponseWriter, r *http.Request) {
	admin, err := h.requireAdmin(r)
	if err != nil {
		writeAuthError(w, err)
		return
	}

	userID := r.PathValue("userId")
	deviceID := r.PathValue("deviceId")

	device, err := h.store.GetDevice(r.Context(), deviceID)
	if err != nil {
		if errors.Is(err, storage.ErrNotFound) {
			writeError(w, http.StatusNotFound, "device.not_found", "Device not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "internal_error", "Failed to revoke device")
		return
	}

	if device.UserID != userID {
		writeError(w, http.StatusNotFound, "device.not_found", "Device not found")
		return
	}

	if err := h.store.RevokeDevice(r.Context(), deviceID); err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error", "Failed to revoke device")
		return
	}

	h.audit(r.Context(), "admin", &admin.ID, "admin.device.revoke", strPtr("device"), &deviceID, r)

	w.WriteHeader(http.StatusNoContent)
}

func (h *handlers) handleAdminAudit(w http.ResponseWriter, r *http.Request) {
	_, err := h.requireAdmin(r)
	if err != nil {
		writeAuthError(w, err)
		return
	}

	limit := 100
	if l := r.URL.Query().Get("limit"); l != "" {
		if n, err := strconv.Atoi(l); err == nil && n > 0 && n <= 500 {
			limit = n
		}
	}
	cursor := r.URL.Query().Get("cursor")

	entries, nextCursor, err := h.store.ListAuditEntries(r.Context(), limit, cursor)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error", "Failed to list audit log")
		return
	}

	resp := AuditPage{Entries: make([]AuditEntry, 0, len(entries))}
	for _, e := range entries {
		resp.Entries = append(resp.Entries, AuditEntry{
			ID:         e.ID,
			At:         e.At,
			ActorKind:  e.ActorKind,
			ActorID:    e.ActorID,
			Action:     e.Action,
			TargetKind: e.TargetKind,
			TargetID:   e.TargetID,
			IP:         e.IP,
			UserAgent:  e.UserAgent,
		})
	}
	if nextCursor != "" {
		resp.NextCursor = &nextCursor
	}

	writeJSON(w, http.StatusOK, resp)
}

func (h *handlers) requireAuth(r *http.Request) (*storage.User, *storage.Device, error) {
	token := extractToken(r)
	if token == "" {
		return nil, nil, errMissingCredentials
	}
	return h.auth.ValidateSession(r.Context(), token)
}

func (h *handlers) requireAdmin(r *http.Request) (*storage.User, error) {
	user, _, err := h.requireAuth(r)
	if err != nil {
		return nil, err
	}
	if user.Role != "admin" {
		return nil, errAdminRequired
	}
	return user, nil
}

func (h *handlers) audit(ctx context.Context, actorKind string, actorID *string, action string, targetKind, targetID *string, r *http.Request) {
	id, _ := auth.GenerateID()
	ip := r.RemoteAddr
	ua := r.UserAgent()

	entry := &storage.AuditEntry{
		ID:         id,
		At:         time.Now().UTC(),
		ActorKind:  actorKind,
		ActorID:    actorID,
		Action:     action,
		TargetKind: targetKind,
		TargetID:   targetID,
		IP:         &ip,
		UserAgent:  &ua,
	}
	if err := h.store.CreateAuditEntry(ctx, entry); err != nil {
		h.logger.Warn("audit log failed", "err", err)
	}
}

func extractToken(r *http.Request) string {
	authHeader := r.Header.Get("Authorization")
	if authHeader == "" {
		return ""
	}
	if !strings.HasPrefix(authHeader, "Bearer ") {
		return ""
	}
	return strings.TrimPrefix(authHeader, "Bearer ")
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, APIError{Code: code, Message: message})
}

func writeAuthError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errMissingCredentials), errors.Is(err, errAdminRequired):
		writeError(w, http.StatusUnauthorized, "auth.unauthorized", "Missing or invalid credentials")
	case errors.Is(err, auth.ErrSessionExpired):
		writeError(w, http.StatusUnauthorized, "auth.session_expired", "Session expired")
	case errors.Is(err, auth.ErrSessionInvalid):
		writeError(w, http.StatusUnauthorized, "auth.session_invalid", "Invalid session")
	case errors.Is(err, auth.ErrSessionRevoked):
		writeError(w, http.StatusUnauthorized, "auth.session_revoked", "Session revoked")
	case errors.Is(err, auth.ErrUserDisabled):
		writeError(w, http.StatusUnauthorized, "auth.user_disabled", "Account is disabled")
	default:
		slog.Default().Error("authentication validation failed", "err", err)
		writeError(w, http.StatusInternalServerError, "internal_error", "Failed to validate session")
	}
}

func decodeJSON(r *http.Request, dst interface{}) error {
	decoder := json.NewDecoder(http.MaxBytesReader(nil, r.Body, 16*1024*1024))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(dst); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return errors.New("request body must contain one JSON object")
	}
	return nil
}

func decodeJSONBytes(body []byte, dst interface{}) error {
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(dst); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return errors.New("request body must contain one JSON object")
	}
	return nil
}

func strPtr(s string) *string {
	return &s
}

func vaultToResponse(v *storage.Vault) VaultResponse {
	resp := VaultResponse{
		UserID:      v.UserID,
		Seq:         v.Seq,
		EnvelopeRev: v.EnvelopeRev,
		CreatedAt:   v.CreatedAt,
		UpdatedAt:   v.UpdatedAt,
	}
	if len(v.Envelope) > 0 {
		var env VaultEnvelope
		if err := json.Unmarshal(v.Envelope, &env); err == nil {
			resp.Envelope = &env
		}
	}
	return resp
}

func itemToResponse(item *storage.Item) ItemResponse {
	resp := ItemResponse{
		ID:        item.ID,
		GroupID:   item.GroupID,
		Rev:       item.Rev,
		Seq:       item.Seq,
		Deleted:   item.Deleted,
		UpdatedAt: item.UpdatedAt,
	}
	if !item.Deleted && len(item.Ciphertext) > 0 {
		var ct RecordCipher
		if err := json.Unmarshal(item.Ciphertext, &ct); err == nil {
			resp.Ciphertext = &ct
		}
	}
	return resp
}

func groupToResponse(group *storage.Group) GroupResponse {
	resp := GroupResponse{
		ID:        group.ID,
		Rev:       group.Rev,
		Seq:       group.Seq,
		Deleted:   group.Deleted,
		SortIndex: group.SortIndex,
		UpdatedAt: group.UpdatedAt,
	}
	if !group.Deleted && len(group.Ciphertext) > 0 {
		var ct RecordCipher
		if err := json.Unmarshal(group.Ciphertext, &ct); err == nil {
			resp.Ciphertext = &ct
		}
	}
	return resp
}

func accountToResponse(account *storage.Account) AccountResponse {
	resp := AccountResponse{
		ID:                  account.ID,
		Rev:                 account.Rev,
		Seq:                 account.Seq,
		Deleted:             account.Deleted,
		Kind:                account.Kind,
		Platform:            account.Platform,
		DisplayName:         account.DisplayName,
		LoginIdentifier:     account.LoginIdentifier,
		LoginIdentifierHash: account.LoginIdentifierHash,
		Status:              account.Status,
		TagsJSON:            json.RawMessage(account.TagsJSON),
		MetadataJSON:        json.RawMessage(account.MetadataJSON),
		CreatedAt:           account.CreatedAt,
		UpdatedAt:           account.UpdatedAt,
	}
	if !account.Deleted && len(account.SecretCiphertext) > 0 {
		var ct RecordCipher
		if err := json.Unmarshal(account.SecretCiphertext, &ct); err == nil {
			resp.SecretCiphertext = &ct
		}
	}
	return resp
}

func relationToResponse(relation *storage.Relation) RelationResponse {
	resp := RelationResponse{
		ID:           relation.ID,
		Rev:          relation.Rev,
		Seq:          relation.Seq,
		Deleted:      relation.Deleted,
		Kind:         relation.Kind,
		FromKind:     relation.FromKind,
		FromID:       relation.FromID,
		ToKind:       relation.ToKind,
		ToID:         relation.ToID,
		RelationType: relation.Kind,
		MetadataJSON: json.RawMessage(relation.MetadataJSON),
		CreatedAt:    relation.CreatedAt,
		UpdatedAt:    relation.UpdatedAt,
	}
	if relation.FromKind == "account" && relation.FromID != "" {
		v := relation.FromID
		resp.FromAccountID = &v
	}
	if relation.ToKind == "account" && relation.ToID != "" {
		v := relation.ToID
		resp.ToAccountID = &v
	}
	if !relation.Deleted && len(relation.SecretCiphertext) > 0 {
		var ct RecordCipher
		if err := json.Unmarshal(relation.SecretCiphertext, &ct); err == nil {
			resp.SecretCiphertext = &ct
		}
	}
	return resp
}

func accountToAdmin(account *storage.Account) AdminAccount {
	return AdminAccount{
		ID:                  account.ID,
		Rev:                 account.Rev,
		Seq:                 account.Seq,
		Deleted:             account.Deleted,
		Kind:                account.Kind,
		Platform:            account.Platform,
		DisplayName:         account.DisplayName,
		LoginIdentifier:     account.LoginIdentifier,
		LoginIdentifierHash: account.LoginIdentifierHash,
		Status:              account.Status,
		TagsJSON:            json.RawMessage(account.TagsJSON),
		MetadataJSON:        json.RawMessage(account.MetadataJSON),
		CreatedAt:           account.CreatedAt,
		UpdatedAt:           account.UpdatedAt,
	}
}

func relationToAdmin(relation *storage.Relation) AdminRelation {
	resp := AdminRelation{
		ID:           relation.ID,
		Rev:          relation.Rev,
		Seq:          relation.Seq,
		Deleted:      relation.Deleted,
		Kind:         relation.Kind,
		FromKind:     relation.FromKind,
		FromID:       relation.FromID,
		ToKind:       relation.ToKind,
		ToID:         relation.ToID,
		RelationType: relation.Kind,
		MetadataJSON: json.RawMessage(relation.MetadataJSON),
		CreatedAt:    relation.CreatedAt,
		UpdatedAt:    relation.UpdatedAt,
	}
	if relation.FromKind == "account" && relation.FromID != "" {
		v := relation.FromID
		resp.FromAccountID = &v
	}
	if relation.ToKind == "account" && relation.ToID != "" {
		v := relation.ToID
		resp.ToAccountID = &v
	}
	return resp
}

func guardSyncPasswordLeak(env VaultEnvelope) error {
	suspicious := []string{"password", "passphrase", "secret", "plaintext"}
	for _, key := range suspicious {
		if strings.Contains(strings.ToLower(env.Alg), key) {
			return errors.New("envelope contains suspicious field name")
		}
		if strings.Contains(strings.ToLower(env.Kdf), key) {
			return errors.New("envelope contains suspicious field name")
		}
	}
	for k := range env.KdfParams {
		lk := strings.ToLower(k)
		for _, key := range suspicious {
			if strings.Contains(lk, key) {
				return errors.New("kdf params contain suspicious key name")
			}
		}
	}
	return nil
}
