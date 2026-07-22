package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"golang.org/x/crypto/argon2"

	"github.com/daling/2fa/internal/storage"
)

const (
	argon2Time    = 1
	argon2Memory  = 64 * 1024
	argon2Threads = 4
	argon2KeyLen  = 32
	saltLen       = 16
	dummyHash     = "$argon2id$v=19$m=65536,t=1,p=4$MDEyMzQ1Njc4OWFiY2RlZg$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
)

var (
	ErrInvalidCredentials = errors.New("auth: invalid credentials")
	ErrUserDisabled       = errors.New("auth: user is disabled")
	ErrSessionExpired     = errors.New("auth: session expired")
	ErrSessionInvalid     = errors.New("auth: session invalid")
	ErrSessionRevoked     = errors.New("auth: session revoked")
)

type Clock interface {
	Now() time.Time
}

type systemClock struct{}

func (systemClock) Now() time.Time { return time.Now().UTC() }

type Service struct {
	store              storage.Store
	sessionTTL         time.Duration
	sessionMaxLifetime time.Duration
	clock              Clock
}

func NewService(store storage.Store, sessionTTL, sessionMaxLifetime time.Duration) *Service {
	return NewServiceWithClock(store, sessionTTL, sessionMaxLifetime, systemClock{})
}

func NewServiceWithClock(store storage.Store, sessionTTL, sessionMaxLifetime time.Duration, clock Clock) *Service {
	return &Service{
		store:              store,
		sessionTTL:         sessionTTL,
		sessionMaxLifetime: sessionMaxLifetime,
		clock:              clock,
	}
}

func (s *Service) HashPassword(password string) (string, error) {
	salt := make([]byte, saltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", fmt.Errorf("generate salt: %w", err)
	}

	hash := argon2.IDKey([]byte(password), salt, argon2Time, argon2Memory, argon2Threads, argon2KeyLen)

	encoded := fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s",
		argon2.Version, argon2Memory, argon2Time, argon2Threads,
		base64.RawStdEncoding.EncodeToString(salt),
		base64.RawStdEncoding.EncodeToString(hash))
	return encoded, nil
}

func (s *Service) VerifyPassword(password, encodedHash string) (bool, error) {
	parts := strings.Split(encodedHash, "$")
	if len(parts) != 6 || parts[1] != "argon2id" {
		return false, errors.New("parse hash: invalid format")
	}
	version, err := strconv.Atoi(strings.TrimPrefix(parts[2], "v="))
	if err != nil || version != argon2.Version {
		return false, errors.New("parse hash: unsupported version")
	}
	var memory, iterations uint32
	var threads uint8
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &memory, &iterations, &threads); err != nil {
		return false, fmt.Errorf("parse hash parameters: %w", err)
	}

	saltBytes, err := base64.RawStdEncoding.DecodeString(parts[4])
	if err != nil {
		return false, fmt.Errorf("decode salt: %w", err)
	}

	hashBytes, err := base64.RawStdEncoding.DecodeString(parts[5])
	if err != nil {
		return false, fmt.Errorf("decode hash: %w", err)
	}

	computedHash := argon2.IDKey([]byte(password), saltBytes, iterations, memory, threads, uint32(len(hashBytes)))

	if subtle.ConstantTimeCompare(hashBytes, computedHash) == 1 {
		return true, nil
	}
	return false, nil
}

func (s *Service) BurnInvalidPassword(password string) {
	_, _ = s.VerifyPassword(password, dummyHash)
}

func (s *Service) CreateSession(ctx context.Context, userID, deviceID string) (string, time.Time, error) {
	token, err := generateToken()
	if err != nil {
		return "", time.Time{}, err
	}

	now := s.clock.Now().UTC()
	expiresAt := now.Add(s.sessionTTL)
	absoluteExpiresAt := now.Add(s.sessionMaxLifetime)
	if expiresAt.After(absoluteExpiresAt) {
		expiresAt = absoluteExpiresAt
	}

	session := &storage.Session{
		TokenHash:         hashToken(token),
		UserID:            userID,
		DeviceID:          deviceID,
		ExpiresAt:         expiresAt,
		AbsoluteExpiresAt: absoluteExpiresAt,
		CreatedAt:         now,
	}

	if err := s.store.CreateSession(ctx, session); err != nil {
		return "", time.Time{}, err
	}

	return token, expiresAt, nil
}

func (s *Service) ValidateSession(ctx context.Context, token string) (*storage.User, *storage.Device, error) {
	tokenHash := hashToken(token)
	session, err := s.store.GetSession(ctx, tokenHash)
	if err != nil {
		if errors.Is(err, storage.ErrNotFound) {
			return nil, nil, ErrSessionInvalid
		}
		return nil, nil, err
	}

	now := s.clock.Now().UTC()
	if !now.Before(session.ExpiresAt) || !now.Before(session.AbsoluteExpiresAt) {
		if err := s.store.DeleteSession(ctx, tokenHash); err != nil {
			return nil, nil, fmt.Errorf("%w: delete expired session: %w", ErrSessionExpired, err)
		}
		return nil, nil, ErrSessionExpired
	}

	user, err := s.store.GetUserByID(ctx, session.UserID)
	if err != nil {
		if errors.Is(err, storage.ErrNotFound) {
			return nil, nil, ErrSessionInvalid
		}
		return nil, nil, err
	}

	if user.Disabled {
		return nil, nil, ErrUserDisabled
	}

	var device *storage.Device
	if session.DeviceID != "" {
		device, err = s.store.GetDevice(ctx, session.DeviceID)
		if err != nil && !errors.Is(err, storage.ErrNotFound) {
			return nil, nil, err
		}
		if errors.Is(err, storage.ErrNotFound) || device.Revoked || device.UserID != session.UserID {
			if err := s.store.DeleteSession(ctx, tokenHash); err != nil {
				return nil, nil, fmt.Errorf("%w: delete revoked session: %w", ErrSessionRevoked, err)
			}
			return nil, nil, ErrSessionRevoked
		}
	}

	if !session.ExpiresAt.After(now.Add(s.sessionTTL / 2)) {
		renewedExpiry := now.Add(s.sessionTTL)
		if renewedExpiry.After(session.AbsoluteExpiresAt) {
			renewedExpiry = session.AbsoluteExpiresAt
		}
		if renewedExpiry.After(session.ExpiresAt) {
			if err := s.store.UpdateSessionExpiry(ctx, tokenHash, renewedExpiry); err != nil {
				return nil, nil, err
			}
		}
	}

	if device != nil {
		if err := s.store.UpdateDeviceLastSeen(ctx, device.ID, now); err != nil {
			return nil, nil, err
		}
	}

	return user, device, nil
}

func (s *Service) DeleteSession(ctx context.Context, token string) error {
	return s.store.DeleteSession(ctx, hashToken(token))
}

func (s *Service) CreateDeviceAndBindSession(ctx context.Context, device *storage.Device, token string) error {
	return s.store.CreateDeviceAndBindSession(ctx, device, hashToken(token))
}

func hashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

func generateToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.URLEncoding.EncodeToString(b), nil
}

func GenerateID() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}
