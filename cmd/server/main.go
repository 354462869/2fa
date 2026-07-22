package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/daling/2fa/internal/auth"
	"github.com/daling/2fa/internal/config"
	apphttp "github.com/daling/2fa/internal/http"
	"github.com/daling/2fa/internal/storage"
	"github.com/daling/2fa/internal/sync"
)

const shutdownGrace = 10 * time.Second

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo}))
	slog.SetDefault(logger)

	cfg, err := config.Load()
	if err != nil {
		logger.Error("config load failed", "err", err)
		os.Exit(2)
	}

	store, err := storage.NewSQLiteStore(cfg.DBPath)
	if err != nil {
		logger.Error("storage init failed", "err", err)
		os.Exit(2)
	}
	defer store.Close()

	authSvc := auth.NewService(store, cfg.SessionTTL, cfg.SessionMaxLifetime)
	syncSvc := sync.NewService(store)

	if err := bootstrapAdmin(context.Background(), logger, store, authSvc, cfg); err != nil {
		logger.Error("admin bootstrap failed", "err", err)
		os.Exit(2)
	}

	router := apphttp.NewRouter(apphttp.RouterDeps{
		Logger: logger,
		Config: cfg,
		Store:  store,
		Auth:   authSvc,
		Sync:   syncSvc,
	})

	server := &http.Server{
		Addr:              cfg.Addr,
		Handler:           router,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       90 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	go func() {
		logger.Info("server listening", "addr", cfg.Addr, "env", cfg.Env)
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("server error", "err", err)
			stop()
		}
	}()

	<-ctx.Done()
	logger.Info("shutting down")

	shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownGrace)
	defer cancel()
	if err := server.Shutdown(shutdownCtx); err != nil {
		logger.Error("shutdown error", "err", err)
		os.Exit(1)
	}
}

func bootstrapAdmin(ctx context.Context, logger *slog.Logger, store storage.Store, authSvc *auth.Service, cfg config.Config) error {
	if cfg.BootstrapAdminUsername == "" || cfg.BootstrapAdminPassword == "" {
		return nil
	}

	count, err := store.CountUsers(ctx)
	if err != nil {
		return err
	}
	if count > 0 {
		return nil
	}

	if len(cfg.BootstrapAdminPassword) < 12 {
		return errors.New("bootstrap admin password must be at least 12 characters")
	}

	hash, err := authSvc.HashPassword(cfg.BootstrapAdminPassword)
	if err != nil {
		return err
	}

	id, err := auth.GenerateID()
	if err != nil {
		return err
	}

	now := time.Now().UTC()
	user := &storage.User{
		ID:           id,
		Username:     cfg.BootstrapAdminUsername,
		PasswordHash: hash,
		Role:         "admin",
		Disabled:     false,
		CreatedAt:    now,
		UpdatedAt:    now,
	}

	if err := store.CreateUser(ctx, user); err != nil {
		return err
	}

	logger.Info("bootstrap admin created", "username", user.Username)
	return nil
}
