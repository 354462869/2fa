package http

import (
	"net"
	"net/http"
	"sync"
	"time"
)

type rateLimiter struct {
	mu        sync.Mutex
	buckets   map[string]*bucket
	perMinute int
}

type bucket struct {
	tokens    float64
	lastRefil time.Time
}

func newRateLimiter(perMinute int) *rateLimiter {
	return &rateLimiter{
		buckets:   make(map[string]*bucket),
		perMinute: perMinute,
	}
}

func (rl *rateLimiter) allow(key string) bool {
	rl.mu.Lock()
	defer rl.mu.Unlock()

	now := time.Now()
	b, ok := rl.buckets[key]
	if !ok {
		b = &bucket{tokens: float64(rl.perMinute), lastRefil: now}
		rl.buckets[key] = b
	}

	elapsed := now.Sub(b.lastRefil).Seconds()
	b.tokens += elapsed * (float64(rl.perMinute) / 60.0)
	if b.tokens > float64(rl.perMinute) {
		b.tokens = float64(rl.perMinute)
	}
	b.lastRefil = now

	if b.tokens >= 1.0 {
		b.tokens -= 1.0
		return true
	}
	return false
}

func (rl *rateLimiter) middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		key := clientIP(r)
		if !rl.allow(key) {
			writeError(w, http.StatusTooManyRequests, "rate_limited", "Too many requests")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func clientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		return xff
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
