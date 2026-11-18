package controlplane

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/bcrypt"
)

func bcryptHash(t *testing.T, password string) string {
	t.Helper()
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.MinCost)
	if err != nil {
		t.Fatalf("bcrypt: %v", err)
	}
	return string(hash)
}

func makeAuthEnabledServer(t *testing.T, username, password string) (*HTTPServer, *SessionStore) {
	t.Helper()
	srv, _ := newTestHTTPServer(t)
	srv.Authenticator = SingleUserAuthenticator{Username: username, PasswordHash: bcryptHash(t, password)}
	srv.Sessions = NewSessionStore()
	return srv, srv.Sessions
}

func TestSessionStore_CreateTouchRevoke(t *testing.T) {
	st := NewSessionStore()
	sess, err := st.Create("alice")
	if err != nil || sess.ID == "" || sess.Username != "alice" {
		t.Fatalf("Create: sess=%+v err=%v", sess, err)
	}
	got, err := st.Touch(sess.ID)
	if err != nil || got.ID != sess.ID {
		t.Fatalf("Touch: got=%+v err=%v", got, err)
	}
	st.Revoke(sess.ID)
	if _, err := st.Touch(sess.ID); err == nil {
		t.Fatal("revoked session should not Touch")
	}
}

func TestSessionStore_Expired(t *testing.T) {
	st := NewSessionStore().WithTTL(time.Millisecond, time.Hour)
	sess, _ := st.Create("alice")
	time.Sleep(5 * time.Millisecond)
	if _, err := st.Touch(sess.ID); !errors.Is(err, ErrSessionExpired) {
		t.Fatalf("expected ErrSessionExpired, got %v", err)
	}
}

func TestSessionStore_IdleEvict(t *testing.T) {
	st := NewSessionStore().WithTTL(time.Hour, time.Millisecond)
	sess, _ := st.Create("alice")
	time.Sleep(5 * time.Millisecond)
	if _, err := st.Touch(sess.ID); !errors.Is(err, ErrSessionExpired) {
		t.Fatalf("idle session should evict, got %v", err)
	}
}

func TestSessionStore_SweepRemovesExpired(t *testing.T) {
	st := NewSessionStore().WithTTL(time.Millisecond, time.Hour)
	_, _ = st.Create("a")
	_, _ = st.Create("b")
	time.Sleep(5 * time.Millisecond)
	if n := st.Sweep(); n != 2 {
		t.Fatalf("Sweep should remove 2, got %d", n)
	}
}

func TestSingleUserAuth_GoodPassword(t *testing.T) {
	a := SingleUserAuthenticator{Username: "alice", PasswordHash: bcryptHash(t, "s3cret")}
	got, err := a.Authenticate("alice", "s3cret")
	if err != nil || got != "alice" {
		t.Fatalf("got=%q err=%v", got, err)
	}
}

func TestSingleUserAuth_BadPassword(t *testing.T) {
	a := SingleUserAuthenticator{Username: "alice", PasswordHash: bcryptHash(t, "s3cret")}
	if _, err := a.Authenticate("alice", "wrong"); !errors.Is(err, ErrInvalidCredentials) {
		t.Fatalf("expected ErrInvalidCredentials, got %v", err)
	}
}

func TestSingleUserAuth_BadUsername(t *testing.T) {
	a := SingleUserAuthenticator{Username: "alice", PasswordHash: bcryptHash(t, "x")}
	if _, err := a.Authenticate("bob", "x"); !errors.Is(err, ErrInvalidCredentials) {
		t.Fatal("wrong username should reject")
	}
}

func TestSingleUserAuth_EmptyConfig(t *testing.T) {
	if _, err := (SingleUserAuthenticator{}).Authenticate("alice", "x"); !errors.Is(err, ErrInvalidCredentials) {
		t.Fatal("empty config should reject")
	}
}

func TestHandleLogin_SuccessSetsCookie(t *testing.T) {
	srv, _ := makeAuthEnabledServer(t, "alice", "s3cret")
	body, _ := json.Marshal(loginRequest{Username: "alice", Password: "s3cret"})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/login", bytes.NewReader(body))
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", rec.Code, rec.Body.String())
	}
	cookies := rec.Result().Cookies()
	var sess *http.Cookie
	for _, c := range cookies {
		if c.Name == sessionCookieName {
			sess = c
			break
		}
	}
	if sess == nil || sess.Value == "" {
		t.Fatalf("missing session cookie: %+v", cookies)
	}
	if !sess.HttpOnly {
		t.Error("session cookie must be HttpOnly")
	}
}

func TestHandleLogin_BadPasswordRejected(t *testing.T) {
	srv, _ := makeAuthEnabledServer(t, "alice", "s3cret")
	body, _ := json.Marshal(loginRequest{Username: "alice", Password: "wrong"})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/login", bytes.NewReader(body))
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rec.Code)
	}
}

func TestHandleLogin_BadJSON(t *testing.T) {
	srv, _ := makeAuthEnabledServer(t, "alice", "x")
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/login", strings.NewReader("{"))
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", rec.Code)
	}
}

type recordingAudit struct {
	events []struct {
		action string
		meta   map[string]string
	}
}

func (r *recordingAudit) Emit(action string, metadata map[string]string) {
	r.events = append(r.events, struct {
		action string
		meta   map[string]string
	}{action, metadata})
}

func TestHandleLogin_WrongMethod(t *testing.T) {
	srv, _ := makeAuthEnabledServer(t, "alice", "x")
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/login", nil)
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405, got %d", rec.Code)
	}
}

func TestHandleLogin_EmitsAuditOnSuccess(t *testing.T) {
	srv, _ := makeAuthEnabledServer(t, "alice", "s3cret")
	audit := &recordingAudit{}
	srv.Audit = audit
	body, _ := json.Marshal(loginRequest{Username: "alice", Password: "s3cret"})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/login", bytes.NewReader(body))
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d body=%s", rec.Code, rec.Body.String())
	}
	if len(audit.events) != 1 || audit.events[0].action != "panel_login_succeeded" {
		t.Errorf("audit events: %+v", audit.events)
	}
	if audit.events[0].meta["username"] != "alice" {
		t.Errorf("username meta: %v", audit.events[0].meta)
	}
}

func TestHandleLogin_EmitsAuditOnFailure(t *testing.T) {
	srv, _ := makeAuthEnabledServer(t, "alice", "s3cret")
	audit := &recordingAudit{}
	srv.Audit = audit
	body, _ := json.Marshal(loginRequest{Username: "alice", Password: "wrong"})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/login", bytes.NewReader(body))
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status %d", rec.Code)
	}
	if len(audit.events) != 1 || audit.events[0].action != "panel_login_failed" {
		t.Errorf("audit events: %+v", audit.events)
	}
}

func TestHandleLogin_NotAvailableIfDisabled(t *testing.T) {
	srv, _ := newTestHTTPServer(t)
	body, _ := json.Marshal(loginRequest{Username: "x", Password: "y"})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/login", bytes.NewReader(body))
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("/v1/login should be absent when auth disabled, got %d", rec.Code)
	}
}

func TestHandleLogout_ClearsCookie(t *testing.T) {
	srv, st := makeAuthEnabledServer(t, "alice", "s3cret")
	sess, _ := st.Create("alice")
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/logout", nil)
	req.AddCookie(&http.Cookie{Name: sessionCookieName, Value: sess.ID})
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("expected 204, got %d", rec.Code)
	}
	if _, err := st.Touch(sess.ID); !errors.Is(err, ErrSessionUnknown) {
		t.Fatal("session should be revoked")
	}
	cookies := rec.Result().Cookies()
	cleared := false
	for _, c := range cookies {
		if c.Name == sessionCookieName && (c.MaxAge < 0 || c.Value == "") {
			cleared = true
		}
	}
	if !cleared {
		t.Fatalf("logout did not clear cookie: %+v", cookies)
	}
}

func TestHandleWhoami_SessionAndBearer(t *testing.T) {
	srv, st := makeAuthEnabledServer(t, "alice", "s3cret")
	srv.OperatorToken = "op-token"
	sess, _ := st.Create("alice")

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/whoami", nil)
	req.AddCookie(&http.Cookie{Name: sessionCookieName, Value: sess.ID})
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"username":"alice"`) {
		t.Fatalf("session whoami: code=%d body=%s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/v1/whoami", nil)
	req.Header.Set("Authorization", "Bearer op-token")
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"auth_kind":"bearer"`) {
		t.Fatalf("bearer whoami: code=%d body=%s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/v1/whoami", nil)
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("no auth whoami: code=%d", rec.Code)
	}
}

func TestHandleWhoami_NoAuthMode(t *testing.T) {
	srv, _ := newTestHTTPServer(t)
	srv.Token = ""
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/whoami", nil)
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("no-auth whoami should be 200, got %d body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"auth_kind":"none"`) {
		t.Fatalf("expected auth_kind=none, body=%s", rec.Body.String())
	}
}

func TestRequireBearer_AcceptsSessionCookie(t *testing.T) {
	srv, st := makeAuthEnabledServer(t, "alice", "s3cret")
	srv.OperatorToken = "op-token"
	sess, _ := st.Create("alice")
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/agents", nil)
	req.AddCookie(&http.Cookie{Name: sessionCookieName, Value: sess.ID})
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code == http.StatusUnauthorized {
		t.Fatalf("session cookie should authorize, got 401")
	}
}

func TestRequireBearer_RejectsWhenNeither(t *testing.T) {
	srv, _ := makeAuthEnabledServer(t, "alice", "s3cret")
	srv.OperatorToken = "op-token"
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/agents", nil)
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("missing auth should 401, got %d", rec.Code)
	}
}

func TestClientIPFromRequest(t *testing.T) {
	if got := clientIPFromRequest(nil); got != "" {
		t.Fatalf("nil request: %q", got)
	}
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.RemoteAddr = "10.0.0.1:1234"
	if got := clientIPFromRequest(req); got != "10.0.0.1" {
		t.Fatalf("plain RemoteAddr: got %q", got)
	}
	req.Header.Set("X-Forwarded-For", "1.2.3.4, 5.6.7.8")
	if got := clientIPFromRequest(req); got != "1.2.3.4" {
		t.Fatalf("XFF chain: got %q", got)
	}
	req2 := httptest.NewRequest(http.MethodGet, "/", nil)
	req2.RemoteAddr = "10.0.0.2:9999"
	req2.Header.Set("X-Real-IP", "7.7.7.7")
	if got := clientIPFromRequest(req2); got != "7.7.7.7" {
		t.Fatalf("X-Real-IP precedence: got %q", got)
	}
}

func TestHandlePanelSession(t *testing.T) {
	srv, st := makeAuthEnabledServer(t, "alice", "s3cret")
	h := srv.Handler()

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/v1/panel-session", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("no session: got %d want 401", rec.Code)
	}

	rec = httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/panel-session", nil)
	req.Header.Set("Authorization", "Bearer "+srv.operatorBearer())
	h.ServeHTTP(rec, req)
	if srv.operatorBearer() != "" && rec.Code != http.StatusUnauthorized {
		t.Fatalf("operator bearer must not unlock the session check, got %d", rec.Code)
	}

	sess, _ := st.Create("alice")
	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/v1/panel-session", nil)
	req.AddCookie(&http.Cookie{Name: sessionCookieName, Value: sess.ID})
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("valid session: got %d want 204", rec.Code)
	}

	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/v1/panel-session", nil))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("post: got %d", rec.Code)
	}
}

func TestHandlePanelSession_NoLoginConfigured(t *testing.T) {
	srv, _ := newTestHTTPServer(t)
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/v1/panel-session", nil))
	if rec.Code != http.StatusNoContent {
		t.Fatalf("without a login the panel is open; got %d want 204", rec.Code)
	}
}
