package controlplane

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"golang.org/x/crypto/bcrypt"
)

type OperatorAuthenticator interface {
	Authenticate(username, password string) (string, error)
}

var ErrInvalidCredentials = errors.New("invalid credentials")

type SingleUserAuthenticator struct {
	Username     string
	PasswordHash string
}

func (a SingleUserAuthenticator) Authenticate(username, password string) (string, error) {
	if a.Username == "" || a.PasswordHash == "" {
		return "", ErrInvalidCredentials
	}
	if strings.TrimSpace(username) != a.Username {
		return "", ErrInvalidCredentials
	}
	if err := bcrypt.CompareHashAndPassword([]byte(a.PasswordHash), []byte(password)); err != nil {
		return "", ErrInvalidCredentials
	}
	return a.Username, nil
}

type loginRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

type loginResponse struct {
	Username  string    `json:"username"`
	ExpiresAt time.Time `json:"expires_at"`
}

type whoamiResponse struct {
	Username string `json:"username,omitempty"`
	AuthKind string `json:"auth_kind"`
}

func (s *HTTPServer) handleLogin(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if s.Authenticator == nil || s.Sessions == nil {
		http.Error(w, "panel auth not configured", http.StatusServiceUnavailable)
		return
	}
	var req loginRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid json: "+err.Error(), http.StatusBadRequest)
		return
	}
	username, err := s.Authenticator.Authenticate(req.Username, req.Password)
	if err != nil {
		if s.Audit != nil {
			s.Audit.Emit("panel_login_failed", map[string]string{
				"username":  req.Username,
				"client_ip": clientIPFromRequest(r),
			})
		}
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	sess, err := s.Sessions.Create(username)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	http.SetCookie(w, &http.Cookie{ // #nosec G124 -- Secure follows the request transport so plain-HTTP panels keep working
		Name:     sessionCookieName,
		Value:    sess.ID,
		Path:     "/",
		HttpOnly: true,
		Secure:   r.TLS != nil,
		SameSite: http.SameSiteLaxMode,
		Expires:  sess.ExpiresAt,
	})
	if s.Audit != nil {
		s.Audit.Emit("panel_login_succeeded", map[string]string{
			"username":  username,
			"client_ip": clientIPFromRequest(r),
		})
	}
	writeJSON(w, http.StatusOK, loginResponse{Username: username, ExpiresAt: sess.ExpiresAt})
}

func (s *HTTPServer) handleLogout(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if s.Sessions != nil {
		if c, err := r.Cookie(sessionCookieName); err == nil {
			s.Sessions.Revoke(c.Value)
		}
	}
	http.SetCookie(w, &http.Cookie{ // #nosec G124 -- Secure follows the request transport so plain-HTTP panels keep working
		Name:     sessionCookieName,
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		Secure:   r.TLS != nil,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   -1,
	})
	w.WriteHeader(http.StatusNoContent)
}

func (s *HTTPServer) handleWhoami(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if sess, ok := s.sessionFromRequest(r); ok {
		writeJSON(w, http.StatusOK, whoamiResponse{Username: sess.Username, AuthKind: "session"})
		return
	}
	if s.matchesBearer(r) {
		writeJSON(w, http.StatusOK, whoamiResponse{AuthKind: "bearer"})
		return
	}
	if s.Authenticator == nil && s.operatorBearer() == "" {
		writeJSON(w, http.StatusOK, whoamiResponse{AuthKind: "none"})
		return
	}
	http.Error(w, "unauthorized", http.StatusUnauthorized)
}

func (s *HTTPServer) sessionFromRequest(r *http.Request) (Session, bool) {
	if s.Sessions == nil {
		return Session{}, false
	}
	c, err := r.Cookie(sessionCookieName)
	if err != nil || c.Value == "" {
		return Session{}, false
	}
	sess, err := s.Sessions.Touch(c.Value)
	if err != nil {
		return Session{}, false
	}
	return sess, true
}

func (s *HTTPServer) matchesBearer(r *http.Request) bool {
	expected := s.operatorBearer()
	if expected == "" {
		return false
	}
	return r.Header.Get("Authorization") == "Bearer "+expected
}

func clientIPFromRequest(r *http.Request) string {
	if r == nil {
		return ""
	}
	return requestClientIP(r)
}
