package config

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestSafePath(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"empty", "", ""},
		{"absolute", "/etc/firefik/rules.conf", "/etc/firefik/rules.conf"},
		{"absolute with dot segments", "/etc/firefik/../firefik/rules.conf", "/etc/firefik/rules.conf"},
		{"relative rejected", "etc/rules.conf", ""},
		{"traversal resolved to absolute", "/etc/../../../etc/passwd", "/etc/passwd"},
		{"dash sentinel rejected for path contexts", "-", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := SafePath(tc.in); got != tc.want {
				t.Fatalf("SafePath(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

func TestEffectiveChainName(t *testing.T) {
	cases := []struct {
		name, chain, suffix, want string
	}{
		{"no suffix", "FIREFIK", "", "FIREFIK"},
		{"simple suffix", "FIREFIK", "v2", "FIREFIK-v2"},
		{"chain with own dashes", "FIREFIK-PROD", "v2", "FIREFIK-PROD-v2"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c := &Config{ChainName: tc.chain, ChainSuffix: tc.suffix}
			if got := c.EffectiveChainName(); got != tc.want {
				t.Fatalf("got %q, want %q", got, tc.want)
			}
		})
	}
}

func TestValidateChainSuffix(t *testing.T) {
	ok := []string{"", "v2", "blue", "rel_1", "v-2"}
	bad := []string{"v 2", "v$2", "с2", "v/2"}
	for _, s := range ok {
		c := &Config{ChainSuffix: s}
		if err := c.ValidateChainSuffix(); err != nil {
			t.Fatalf("expected %q to be valid: %v", s, err)
		}
	}
	for _, s := range bad {
		c := &Config{ChainSuffix: s}
		if err := c.ValidateChainSuffix(); err == nil {
			t.Fatalf("expected %q to be rejected", s)
		}
	}
}

func TestDefaultDropLogRate(t *testing.T) {
	cases := []struct {
		name    string
		enabled bool
		rate    int
		want    int
	}{
		{"on by default rate", true, 10, 10},
		{"disabled", false, 10, 0},
		{"zero rate disables", true, 0, 0},
		{"capped", true, 50000, 1000},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c := &Config{LogDefaultDrop: tc.enabled, LogDefaultDropRate: tc.rate}
			if got := c.DefaultDropLogRate(); got != tc.want {
				t.Fatalf("got %d, want %d", got, tc.want)
			}
		})
	}
	t.Setenv("FIREFIK_LOG_DEFAULT_DROP", "")
	t.Setenv("FIREFIK_LOG_DEFAULT_DROP_RATE", "")
	if got := Load().DefaultDropLogRate(); got != 10 {
		t.Fatalf("default load rate = %d, want 10", got)
	}
}

func TestControlPlaneProxyURL(t *testing.T) {
	cases := []struct {
		name, http, admin, want string
	}{
		{"unset", "", "", ""},
		{"falls back to agent http", "https://fw.example:8443", "", "https://fw.example:8443"},
		{"admin overrides", "https://fw.example:8443", "https://fw-adm.example", "https://fw-adm.example"},
		{"admin only", "", "https://fw-adm.example", "https://fw-adm.example"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c := &Config{ControlPlaneHTTP: tc.http, ControlPlaneAdminHTTP: tc.admin}
			if got := c.ControlPlaneProxyURL(); got != tc.want {
				t.Fatalf("got %q, want %q", got, tc.want)
			}
		})
	}
}

func TestFinaliseForRuntime(t *testing.T) {
	c := &Config{ChainName: "FIREFIK", ChainSuffix: "v2"}
	if err := c.FinaliseForRuntime(); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if c.EffectiveChain != "FIREFIK-v2" {
		t.Fatalf("EffectiveChain = %q", c.EffectiveChain)
	}

	c2 := &Config{ChainName: "FIREFIK", ChainSuffix: "bad space"}
	if err := c2.FinaliseForRuntime(); err == nil {
		t.Fatalf("expected validation error")
	}
}

func TestGetEnvFileMode_Fallback(t *testing.T) {
	t.Setenv("FIREFIK_SOCKET_MODE_TEST", "")
	if got := getEnvFileMode("FIREFIK_SOCKET_MODE_TEST", 0o660); got != 0o660 {
		t.Fatalf("want default 0660, got %o", got)
	}
	t.Setenv("FIREFIK_SOCKET_MODE_TEST", "600")
	if got := getEnvFileMode("FIREFIK_SOCKET_MODE_TEST", 0o660); got != 0o600 {
		t.Fatalf("want 0600, got %o", got)
	}
	t.Setenv("FIREFIK_SOCKET_MODE_TEST", "not-octal")
	if got := getEnvFileMode("FIREFIK_SOCKET_MODE_TEST", 0o660); got != 0o660 {
		t.Fatalf("want fallback on invalid, got %o", got)
	}
}

func unsetAllFirefikEnv(t *testing.T) {
	t.Helper()
	for _, kv := range os.Environ() {
		for i := 0; i < len(kv); i++ {
			if kv[i] == '=' {
				key := kv[:i]
				if len(key) >= 8 && key[:8] == "FIREFIK_" {
					t.Setenv(key, "")
				}
				break
			}
		}
	}
}

func TestLoad_Defaults(t *testing.T) {
	unsetAllFirefikEnv(t)

	c := Load()
	if c == nil {
		t.Fatal("Load returned nil")
	}
	if c.ListenAddr != "unix:///run/firefik/api.sock" {
		t.Errorf("ListenAddr default mismatch: %q", c.ListenAddr)
	}
	if c.SocketMode != 0o660 {
		t.Errorf("SocketMode default = %o, want 0660", c.SocketMode)
	}
	if c.LogLevel != "info" {
		t.Errorf("LogLevel default = %q", c.LogLevel)
	}
	if c.ChainName != "FIREFIK" {
		t.Errorf("ChainName default = %q", c.ChainName)
	}
	if c.ParentChain != "DOCKER-USER" {
		t.Errorf("ParentChain default = %q", c.ParentChain)
	}
	if c.DefaultPolicy != "RETURN" {
		t.Errorf("DefaultPolicy default = %q", c.DefaultPolicy)
	}
	if !c.AutoAllowlist {
		t.Errorf("AutoAllowlist default should be true")
	}
	if c.ConfigFile != "/etc/firefik/rules.conf" {
		t.Errorf("ConfigFile default = %q", c.ConfigFile)
	}
	if c.EnableIPv6 {
		t.Errorf("EnableIPv6 default should be false")
	}
	if c.Backend != "auto" {
		t.Errorf("Backend default = %q", c.Backend)
	}
	if c.MaxBodyBytes != 1<<20 {
		t.Errorf("MaxBodyBytes default = %d", c.MaxBodyBytes)
	}
	if c.RateLimitRPS != 10 {
		t.Errorf("RateLimitRPS default = %v", c.RateLimitRPS)
	}
	if c.RateLimitBurst != 20 {
		t.Errorf("RateLimitBurst default = %d", c.RateLimitBurst)
	}
	if c.RequestTimeoutMS != 30000 {
		t.Errorf("RequestTimeoutMS default = %d", c.RequestTimeoutMS)
	}
	if !c.AuditRotation.Compress {
		t.Errorf("AuditRotation.Compress default should be true")
	}
	if c.AuditRotation.MaxSizeMB != 100 {
		t.Errorf("AuditRotation.MaxSizeMB default = %d", c.AuditRotation.MaxSizeMB)
	}
	if !c.StatefulAccept {
		t.Errorf("StatefulAccept default should be true")
	}
	if c.WSMaxSubscribers != 20 {
		t.Errorf("WSMaxSubscribers default = %d", c.WSMaxSubscribers)
	}
	if c.MetricsRateRPS != 1.0 {
		t.Errorf("MetricsRateRPS default = %v", c.MetricsRateRPS)
	}
	if c.MetricsListenAddr != "" {
		t.Errorf("MetricsListenAddr default should be empty, got %q", c.MetricsListenAddr)
	}
	if c.MetricsTLSCert != "" {
		t.Errorf("MetricsTLSCert default should be empty, got %q", c.MetricsTLSCert)
	}
	if c.MetricsTLSKey != "" {
		t.Errorf("MetricsTLSKey default should be empty, got %q", c.MetricsTLSKey)
	}
	if c.AutogenMode != "off" {
		t.Errorf("AutogenMode default = %q", c.AutogenMode)
	}
	if c.ScheduleInterval != 60 {
		t.Errorf("ScheduleInterval default = %d", c.ScheduleInterval)
	}
	if c.ControlPlaneSnapshotS != 30 {
		t.Errorf("ControlPlaneSnapshotS default = %d", c.ControlPlaneSnapshotS)
	}
	if c.ControlPlaneHeartbeatS != 30 {
		t.Errorf("ControlPlaneHeartbeatS default = %d", c.ControlPlaneHeartbeatS)
	}
	if len(c.AllowedOrigins) != 0 {
		t.Errorf("AllowedOrigins default should be empty, got %v", c.AllowedOrigins)
	}
	if len(c.AllowedUIDs) != 0 {
		t.Errorf("AllowedUIDs default should be empty, got %v", c.AllowedUIDs)
	}
}

func TestLoad_AllEnvsSet(t *testing.T) {
	unsetAllFirefikEnv(t)

	tokenFile := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(tokenFile, []byte("  secret-token-123  \n"), 0o600); err != nil {
		t.Fatalf("write token file: %v", err)
	}

	t.Setenv("FIREFIK_LISTEN_ADDR", "unix:///tmp/custom.sock")
	t.Setenv("FIREFIK_SOCKET_MODE", "600")
	t.Setenv("FIREFIK_SOCKET_GROUP", "firefik")
	t.Setenv("FIREFIK_LOG_LEVEL", "debug")
	t.Setenv("FIREFIK_CHAIN", "CHAIN1")
	t.Setenv("FIREFIK_AUTO_ALLOWLIST", "false")
	t.Setenv("FIREFIK_ENABLE_IPV6", "true")
	t.Setenv("FIREFIK_ALLOWED_ORIGINS", "https://a.com, https://b.com ,,https://c.com")
	t.Setenv("FIREFIK_ALLOWED_UIDS", "0,1000, 2000 ,nope,3000")
	t.Setenv("FIREFIK_MAX_BODY_BYTES", "4096")
	t.Setenv("FIREFIK_RATE_LIMIT_RPS", "2.5")
	t.Setenv("FIREFIK_RATE_LIMIT_BURST", "50")
	t.Setenv("FIREFIK_API_TOKEN_FILE", tokenFile)
	t.Setenv("FIREFIK_CHAIN_SUFFIX", "blue")
	t.Setenv("FIREFIK_CLEANUP_OLD_SUFFIXES", "green, yellow")
	t.Setenv("FIREFIK_AUTOGEN_MODE", "SHADOW")

	c := Load()

	if c.ListenAddr != "unix:///tmp/custom.sock" {
		t.Errorf("ListenAddr = %q", c.ListenAddr)
	}
	if c.SocketMode != 0o600 {
		t.Errorf("SocketMode = %o", c.SocketMode)
	}
	if c.SocketGroup != "firefik" {
		t.Errorf("SocketGroup = %q", c.SocketGroup)
	}
	if c.LogLevel != "debug" {
		t.Errorf("LogLevel = %q", c.LogLevel)
	}
	if c.ChainName != "CHAIN1" {
		t.Errorf("ChainName = %q", c.ChainName)
	}
	if c.AutoAllowlist {
		t.Errorf("AutoAllowlist should be false")
	}
	if !c.EnableIPv6 {
		t.Errorf("EnableIPv6 should be true")
	}
	wantOrigins := []string{"https://a.com", "https://b.com", "https://c.com"}
	if !reflect.DeepEqual(c.AllowedOrigins, wantOrigins) {
		t.Errorf("AllowedOrigins = %v, want %v", c.AllowedOrigins, wantOrigins)
	}
	wantUIDs := []int{0, 1000, 2000, 3000}
	if !reflect.DeepEqual(c.AllowedUIDs, wantUIDs) {
		t.Errorf("AllowedUIDs = %v, want %v", c.AllowedUIDs, wantUIDs)
	}
	if c.MaxBodyBytes != 4096 {
		t.Errorf("MaxBodyBytes = %d", c.MaxBodyBytes)
	}
	if c.RateLimitRPS != 2.5 {
		t.Errorf("RateLimitRPS = %v", c.RateLimitRPS)
	}
	if c.RateLimitBurst != 50 {
		t.Errorf("RateLimitBurst = %d", c.RateLimitBurst)
	}
	if c.APIToken != "secret-token-123" {
		t.Errorf("APIToken = %q (expected trimmed file content)", c.APIToken)
	}
	if c.ChainSuffix != "blue" {
		t.Errorf("ChainSuffix = %q", c.ChainSuffix)
	}
	wantCleanup := []string{"green", "yellow"}
	if !reflect.DeepEqual(c.CleanupOldSuffixes, wantCleanup) {
		t.Errorf("CleanupOldSuffixes = %v", c.CleanupOldSuffixes)
	}
	if c.AutogenMode != "shadow" {
		t.Errorf("AutogenMode (should be lowercased) = %q", c.AutogenMode)
	}
}

func TestGetEnv(t *testing.T) {
	t.Setenv("FIREFIK_TESTKEY", "")
	if got := getEnv("FIREFIK_TESTKEY", "default"); got != "default" {
		t.Errorf("empty: got %q, want default", got)
	}
	t.Setenv("FIREFIK_TESTKEY", "hello")
	if got := getEnv("FIREFIK_TESTKEY", "default"); got != "hello" {
		t.Errorf("set: got %q, want hello", got)
	}
}

func TestGetEnvBool(t *testing.T) {
	cases := []struct {
		raw  string
		def  bool
		want bool
	}{
		{"true", false, true},
		{"1", false, true},
		{"yes", false, true},
		{"false", true, false},
		{"0", true, false},
		{"no", true, false},
		{"", true, true},
		{"", false, false},
		{"invalid", true, true},
		{"invalid", false, false},
		{"TRUE", false, false},
	}
	for _, tc := range cases {
		t.Run(tc.raw+"/"+boolStr(tc.def), func(t *testing.T) {
			t.Setenv("FIREFIK_BOOL_TESTKEY", tc.raw)
			if got := getEnvBool("FIREFIK_BOOL_TESTKEY", tc.def); got != tc.want {
				t.Errorf("raw=%q def=%v: got %v, want %v", tc.raw, tc.def, got, tc.want)
			}
		})
	}
}

func boolStr(b bool) string {
	if b {
		return "t"
	}
	return "f"
}

func TestGetEnvInt64(t *testing.T) {
	t.Setenv("FIREFIK_INT64_TESTKEY", "")
	if got := getEnvInt64("FIREFIK_INT64_TESTKEY", 42); got != 42 {
		t.Errorf("empty: got %d, want 42", got)
	}
	t.Setenv("FIREFIK_INT64_TESTKEY", "9001")
	if got := getEnvInt64("FIREFIK_INT64_TESTKEY", 42); got != 9001 {
		t.Errorf("valid: got %d, want 9001", got)
	}
	t.Setenv("FIREFIK_INT64_TESTKEY", "not-a-number")
	if got := getEnvInt64("FIREFIK_INT64_TESTKEY", 42); got != 42 {
		t.Errorf("malformed: got %d, want default 42", got)
	}
	t.Setenv("FIREFIK_INT64_TESTKEY", "-5")
	if got := getEnvInt64("FIREFIK_INT64_TESTKEY", 42); got != -5 {
		t.Errorf("negative: got %d, want -5", got)
	}
}

func TestGetEnvFloat(t *testing.T) {
	t.Setenv("FIREFIK_FLOAT_TESTKEY", "")
	if got := getEnvFloat("FIREFIK_FLOAT_TESTKEY", 1.5); got != 1.5 {
		t.Errorf("empty: got %v, want 1.5", got)
	}
	t.Setenv("FIREFIK_FLOAT_TESTKEY", "3.14")
	if got := getEnvFloat("FIREFIK_FLOAT_TESTKEY", 1.5); got != 3.14 {
		t.Errorf("valid: got %v", got)
	}
	t.Setenv("FIREFIK_FLOAT_TESTKEY", "nope")
	if got := getEnvFloat("FIREFIK_FLOAT_TESTKEY", 1.5); got != 1.5 {
		t.Errorf("malformed: got %v, want default", got)
	}
}

func TestGetEnvList(t *testing.T) {
	t.Setenv("FIREFIK_LIST_TESTKEY", "")
	if got := getEnvList("FIREFIK_LIST_TESTKEY"); got != nil {
		t.Errorf("empty: got %v, want nil", got)
	}

	t.Setenv("FIREFIK_LIST_TESTKEY", "one")
	if got := getEnvList("FIREFIK_LIST_TESTKEY"); !reflect.DeepEqual(got, []string{"one"}) {
		t.Errorf("single: got %v", got)
	}

	t.Setenv("FIREFIK_LIST_TESTKEY", " a , b ,  , c ")
	want := []string{"a", "b", "c"}
	if got := getEnvList("FIREFIK_LIST_TESTKEY"); !reflect.DeepEqual(got, want) {
		t.Errorf("multiple with ws: got %v, want %v", got, want)
	}

	t.Setenv("FIREFIK_LIST_TESTKEY", ",,,")
	if got := getEnvList("FIREFIK_LIST_TESTKEY"); len(got) != 0 {
		t.Errorf("only commas: got %v, want empty", got)
	}
}

func TestGetEnvListWithDefault(t *testing.T) {
	os.Unsetenv("FIREFIK_LIST_DEFAULTKEY")
	def := []string{"d1", "d2"}
	if got := getEnvListWithDefault("FIREFIK_LIST_DEFAULTKEY", def); !reflect.DeepEqual(got, def) {
		t.Errorf("unset: got %v, want %v", got, def)
	}

	t.Setenv("FIREFIK_LIST_DEFAULTKEY", "x,y")
	if got := getEnvListWithDefault("FIREFIK_LIST_DEFAULTKEY", def); !reflect.DeepEqual(got, []string{"x", "y"}) {
		t.Errorf("set: got %v", got)
	}

	t.Setenv("FIREFIK_LIST_DEFAULTKEY", "")
	if got := getEnvListWithDefault("FIREFIK_LIST_DEFAULTKEY", def); got != nil {
		t.Errorf("empty (explicit): got %v, want nil (env present but empty)", got)
	}
}

func TestGetEnvIntList(t *testing.T) {
	t.Setenv("FIREFIK_INTLIST_TESTKEY", "")
	if got := getEnvIntList("FIREFIK_INTLIST_TESTKEY"); got != nil {
		t.Errorf("empty: got %v, want nil", got)
	}

	t.Setenv("FIREFIK_INTLIST_TESTKEY", "1, 2 ,3")
	want := []int{1, 2, 3}
	if got := getEnvIntList("FIREFIK_INTLIST_TESTKEY"); !reflect.DeepEqual(got, want) {
		t.Errorf("valid: got %v, want %v", got, want)
	}

	t.Setenv("FIREFIK_INTLIST_TESTKEY", "1,foo,2,bar,3")
	want2 := []int{1, 2, 3}
	if got := getEnvIntList("FIREFIK_INTLIST_TESTKEY"); !reflect.DeepEqual(got, want2) {
		t.Errorf("with invalid: got %v, want %v", got, want2)
	}

	t.Setenv("FIREFIK_INTLIST_TESTKEY", "only-garbage")
	if got := getEnvIntList("FIREFIK_INTLIST_TESTKEY"); len(got) != 0 {
		t.Errorf("all invalid: got %v, want empty", got)
	}

	t.Setenv("FIREFIK_INTLIST_TESTKEY", "7")
	if got := getEnvIntList("FIREFIK_INTLIST_TESTKEY"); !reflect.DeepEqual(got, []int{7}) {
		t.Errorf("single: got %v", got)
	}
}

func TestGetEnvWithFile(t *testing.T) {
	const envKey = "FIREFIK_EWF_VAL"
	const fileKey = "FIREFIK_EWF_FILE"

	t.Setenv(envKey, "inline-value")
	t.Setenv(fileKey, "/nonexistent/path")
	if got := getEnvWithFile(envKey, fileKey, "default"); got != "inline-value" {
		t.Errorf("inline: got %q", got)
	}

	t.Setenv(envKey, "")
	t.Setenv(fileKey, "")
	if got := getEnvWithFile(envKey, fileKey, "default"); got != "default" {
		t.Errorf("no file, empty env: got %q", got)
	}

	t.Setenv(fileKey, filepath.Join(t.TempDir(), "does-not-exist"))
	if got := getEnvWithFile(envKey, fileKey, "default"); got != "default" {
		t.Errorf("missing file: got %q", got)
	}

	f := filepath.Join(t.TempDir(), "token.txt")
	if err := os.WriteFile(f, []byte("  \n  file-content  \n\n"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	t.Setenv(fileKey, f)
	if got := getEnvWithFile(envKey, fileKey, "default"); got != "file-content" {
		t.Errorf("file: got %q, want file-content", got)
	}

	t.Setenv(envKey, "wins")
	if got := getEnvWithFile(envKey, fileKey, "default"); got != "wins" {
		t.Errorf("inline priority: got %q", got)
	}
}
