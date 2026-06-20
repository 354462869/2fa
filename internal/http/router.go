// Package http builds the HTTP router for the 2fa server.
package http

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/daling/2fa/internal/auth"
	"github.com/daling/2fa/internal/config"
	"github.com/daling/2fa/internal/storage"
	"github.com/daling/2fa/internal/sync"
)

const (
	apiVersion    = "v1"
	serverVersion = "0.2.0"
)

type RouterDeps struct {
	Logger *slog.Logger
	Config config.Config
	Store  storage.Store
	Auth   *auth.Service
	Sync   *sync.Service
}

func NewRouter(deps RouterDeps) http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /v1/meta/health", handleHealth)
	mux.HandleFunc("GET /v1/meta/version", handleVersion)

	if deps.Store != nil && deps.Auth != nil && deps.Sync != nil {
		h := &handlers{
			auth:   deps.Auth,
			sync:   deps.Sync,
			store:  deps.Store,
			logger: deps.Logger,
		}

		authRL := newRateLimiter(deps.Config.RateLimitAuthPerMin)
		syncRL := newRateLimiter(deps.Config.RateLimitSyncPerMin)

		mux.Handle("POST /v1/auth/register", authRL.middleware(http.HandlerFunc(h.handleRegister)))
		mux.Handle("POST /v1/auth/login", authRL.middleware(http.HandlerFunc(h.handleLogin)))
		mux.HandleFunc("POST /v1/auth/logout", h.handleLogout)
		mux.HandleFunc("GET /v1/auth/me", h.handleMe)
		mux.HandleFunc("PUT /v1/auth/password", h.handleChangePassword)

		mux.HandleFunc("GET /v1/devices", h.handleListDevices)
		mux.HandleFunc("POST /v1/devices", h.handleRegisterDevice)
		mux.HandleFunc("DELETE /v1/devices/{deviceId}", h.handleRevokeDevice)

		mux.Handle("GET /v1/sync/vault", syncRL.middleware(http.HandlerFunc(h.handleGetVault)))
		mux.Handle("PUT /v1/sync/vault/envelope", syncRL.middleware(http.HandlerFunc(h.handlePutEnvelope)))
		mux.Handle("POST /v1/sync/pull", syncRL.middleware(http.HandlerFunc(h.handlePull)))
		mux.Handle("POST /v1/sync/push", syncRL.middleware(http.HandlerFunc(h.handlePush)))
		mux.Handle("GET /v1/sync/items/{itemId}", syncRL.middleware(http.HandlerFunc(h.handleGetItem)))
		mux.Handle("GET /v1/sync/groups/{groupId}", syncRL.middleware(http.HandlerFunc(h.handleGetGroup)))
		mux.Handle("GET /v1/sync/accounts/{accountId}", syncRL.middleware(http.HandlerFunc(h.handleGetAccount)))
		mux.Handle("GET /v1/sync/relations/{relationId}", syncRL.middleware(http.HandlerFunc(h.handleGetRelation)))

		mux.HandleFunc("GET /v1/admin/setup/status", h.handleAdminSetupStatus)
		mux.Handle("POST /v1/admin/setup", authRL.middleware(http.HandlerFunc(h.handleAdminSetup)))
		mux.Handle("POST /v1/admin/auth/login", authRL.middleware(http.HandlerFunc(h.handleAdminLogin)))
		mux.HandleFunc("GET /v1/admin/users", h.handleAdminListUsers)
		mux.HandleFunc("GET /v1/admin/users/{userId}", h.handleAdminGetUser)
		mux.HandleFunc("POST /v1/admin/users/{userId}/disable", h.handleAdminDisableUser)
		mux.HandleFunc("POST /v1/admin/users/{userId}/enable", h.handleAdminEnableUser)
		mux.HandleFunc("GET /v1/admin/users/{userId}/devices", h.handleAdminListUserDevices)
		mux.HandleFunc("GET /v1/admin/users/{userId}/accounts", h.handleAdminListUserAccounts)
		mux.HandleFunc("GET /v1/admin/users/{userId}/relations", h.handleAdminListUserRelations)
		mux.HandleFunc("DELETE /v1/admin/users/{userId}/devices/{deviceId}", h.handleAdminRevokeDevice)
		mux.HandleFunc("GET /v1/admin/audit", h.handleAdminAudit)
	} else {
		for _, p := range businessRoutes {
			mux.HandleFunc(p, handleNotImplemented)
		}
	}
	if deps.Config.AdminAssetsDir != "" {
		mux.Handle("GET /", adminAssetsHandler(deps.Config.AdminAssetsDir))
	}

	return withRequestLogging(deps.Logger, withCORS(deps.Config, withSecretNameGuard(mux)))
}

func adminAssetsHandler(dir string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := filepath.Clean(strings.TrimPrefix(r.URL.Path, "/"))
		if path == "." {
			path = "index.html"
		}
		if strings.HasPrefix(path, "..") {
			serveAdminFile(w, r, filepath.Join(dir, "index.html"))
			return
		}

		fullPath := filepath.Join(dir, path)
		info, err := os.Stat(fullPath)
		if err != nil || info.IsDir() {
			serveAdminFile(w, r, filepath.Join(dir, "index.html"))
			return
		}
		serveAdminFile(w, r, fullPath)
	})
}

func serveAdminFile(w http.ResponseWriter, r *http.Request, path string) {
	file, err := os.Open(path)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer file.Close()

	info, err := file.Stat()
	if err != nil || info.IsDir() {
		http.NotFound(w, r)
		return
	}
	if ctype := mime.TypeByExtension(filepath.Ext(path)); ctype != "" {
		w.Header().Set("Content-Type", ctype)
	}
	contents, err := io.ReadAll(file)
	if err != nil {
		http.Error(w, http.StatusText(http.StatusInternalServerError), http.StatusInternalServerError)
		return
	}
	http.ServeContent(w, r, info.Name(), info.ModTime(), bytes.NewReader(contents))
}

var businessRoutes = []string{
	"POST /v1/auth/register",
	"POST /v1/auth/login",
	"POST /v1/auth/logout",
	"GET /v1/auth/me",
	"PUT /v1/auth/password",

	"GET /v1/devices",
	"POST /v1/devices",
	"DELETE /v1/devices/{deviceId}",

	"GET /v1/sync/vault",
	"PUT /v1/sync/vault/envelope",
	"POST /v1/sync/pull",
	"POST /v1/sync/push",
	"GET /v1/sync/items/{itemId}",
	"GET /v1/sync/groups/{groupId}",
	"GET /v1/sync/accounts/{accountId}",
	"GET /v1/sync/relations/{relationId}",

	"GET /v1/admin/setup/status",
	"POST /v1/admin/setup",
	"POST /v1/admin/auth/login",
	"GET /v1/admin/users",
	"GET /v1/admin/users/{userId}",
	"POST /v1/admin/users/{userId}/disable",
	"POST /v1/admin/users/{userId}/enable",
	"GET /v1/admin/users/{userId}/devices",
	"GET /v1/admin/users/{userId}/accounts",
	"GET /v1/admin/users/{userId}/relations",
	"DELETE /v1/admin/users/{userId}/devices/{deviceId}",
	"GET /v1/admin/audit",
}

func handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func handleVersion(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{
		"version": serverVersion,
		"api":     apiVersion,
	})
}

func handleNotImplemented(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusNotImplemented, map[string]string{
		"code":    "not_implemented",
		"message": "endpoint scaffolded; implementation pending",
	})
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(body); err != nil {
		slog.Default().Warn("response encode failed", "err", err)
	}
}
