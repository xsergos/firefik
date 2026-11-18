package config

import (
	"fmt"
	"os"
	"path"
	"regexp"
	"strconv"
	"strings"
)

func SafePath(p string) string {
	if p == "" {
		return ""
	}
	cleaned := path.Clean(p)
	if !strings.HasPrefix(cleaned, "/") {
		return ""
	}
	if strings.Contains(cleaned, "..") {
		return ""
	}
	return cleaned
}

type Config struct {
	ListenAddr          string
	SocketMode          os.FileMode
	SocketGroup         string
	LogLevel            string
	ChainName           string
	ParentChain         string
	DefaultPolicy       string
	AutoAllowlist       bool
	ConfigFile          string
	EnableIPv6          bool
	Backend             string
	UseGeoIPDB          bool
	GeoIPDBPath         string
	GeoIPAutoUpdate     bool
	GeoIPUpdateCron     string
	GeoIPLicenseKey     string
	GeoIPSource         string
	GeoIPDownloadURL    string
	Version             string
	APIToken            string
	MetricsToken        string
	AllowedOrigins      []string
	AllowedUIDs         []int
	ClientCAFile        string
	MaxBodyBytes        int64
	RateLimitRPS        float64
	RateLimitBurst      int
	RequestTimeoutMS    int
	AuditSinkType       string
	AuditSinkPath       string
	AuditSinkEndpoint   string
	AuditRotation       AuditRotationConfig
	WebhookURL          string
	WebhookEvents       []string
	WebhookSecret       string
	WebhookTimeoutMS    int
	ChainSuffix         string
	CleanupOldSuffixes  []string
	EffectiveChain      string
	DriftCheckInterval  int
	StatefulAccept      bool
	LogDefaultDrop      bool
	LogDefaultDropRate  int
	APITokenFile        string
	WSMaxSubscribers    int
	MetricsRateRPS      float64
	MetricsRateBurst    int
	MetricsListenAddr   string
	MetricsTLSCert      string
	MetricsTLSKey       string
	MetricsAllowPrivate bool
	TemplatesFile       string
	PoliciesDir         string
	PoliciesReadOnly    bool
	AutogenMode         string
	AutogenMinSamples   int
	AutogenDBPath       string
	ScheduleInterval    int

	ControlPlaneGRPC       string
	ControlPlaneHTTP       string
	ControlPlaneAdminHTTP  string
	ControlPlaneToken      string
	ControlPlaneInsecure   bool
	ControlPlaneCACert     string
	ControlPlaneClientCert string
	ControlPlaneClientKey  string
	ControlPlaneSnapshotS  int
	ControlPlaneHeartbeatS int
	CertRenewBeforeS       int
	CertRenewIntervalS     int
	CertRenewTTLS          int
	TemplateSyncIntervalS  int
	TemplateCacheDir       string
}

type AuditRotationConfig struct {
	MaxSizeMB  int
	MaxBackups int
	MaxAgeDays int
	Compress   bool
}

func Load() *Config {
	return &Config{
		ListenAddr:        getEnv("FIREFIK_LISTEN_ADDR", "unix:///run/firefik/api.sock"),
		SocketMode:        getEnvFileMode("FIREFIK_SOCKET_MODE", 0o660),
		SocketGroup:       getEnv("FIREFIK_SOCKET_GROUP", ""),
		LogLevel:          getEnv("FIREFIK_LOG_LEVEL", "info"),
		ChainName:         getEnv("FIREFIK_CHAIN", "FIREFIK"),
		ParentChain:       getEnv("FIREFIK_PARENT_CHAIN", "DOCKER-USER"),
		DefaultPolicy:     getEnv("FIREFIK_DEFAULT_POLICY", "RETURN"),
		AutoAllowlist:     getEnvBool("FIREFIK_AUTO_ALLOWLIST", true),
		ConfigFile:        SafePath(getEnv("FIREFIK_CONFIG", "/etc/firefik/rules.conf")),
		EnableIPv6:        getEnvBool("FIREFIK_ENABLE_IPV6", false),
		Backend:           getEnv("FIREFIK_BACKEND", "auto"),
		UseGeoIPDB:        getEnvBool("FIREFIK_USE_GEOIP_DB", false),
		GeoIPDBPath:       SafePath(getEnv("FIREFIK_GEOIP_DB_PATH", "/etc/firefik/GeoLite2-Country.mmdb")),
		GeoIPAutoUpdate:   getEnvBool("FIREFIK_GEOIP_DB_AUTOUPDATE", false),
		GeoIPUpdateCron:   getEnv("FIREFIK_GEOIP_DB_CRON", "0 3 * * 3"),
		GeoIPLicenseKey:   getEnvWithFile("FIREFIK_GEOIP_LICENSE_KEY", "FIREFIK_GEOIP_LICENSE_KEY_FILE", ""),
		GeoIPSource:       getEnv("FIREFIK_GEOIP_SOURCE", "p3terx"),
		GeoIPDownloadURL:  getEnv("FIREFIK_GEOIP_DOWNLOAD_URL", ""),
		APIToken:          getEnvWithFile("FIREFIK_API_TOKEN", "FIREFIK_API_TOKEN_FILE", ""),
		MetricsToken:      getEnvWithFile("FIREFIK_METRICS_TOKEN", "FIREFIK_METRICS_TOKEN_FILE", ""),
		AllowedOrigins:    getEnvList("FIREFIK_ALLOWED_ORIGINS"),
		AllowedUIDs:       getEnvIntList("FIREFIK_ALLOWED_UIDS"),
		ClientCAFile:      SafePath(getEnv("FIREFIK_CLIENT_CA_FILE", "")),
		MaxBodyBytes:      getEnvInt64("FIREFIK_MAX_BODY_BYTES", 1<<20),
		RateLimitRPS:      getEnvFloat("FIREFIK_RATE_LIMIT_RPS", 10),
		RateLimitBurst:    int(getEnvInt64("FIREFIK_RATE_LIMIT_BURST", 20)),
		RequestTimeoutMS:  int(getEnvInt64("FIREFIK_REQUEST_TIMEOUT_MS", 30000)),
		AuditSinkType:     getEnv("FIREFIK_AUDIT_SINK", ""),
		AuditSinkPath:     getEnv("FIREFIK_AUDIT_SINK_PATH", ""),
		AuditSinkEndpoint: getEnv("FIREFIK_AUDIT_SINK_ENDPOINT", ""),
		AuditRotation: AuditRotationConfig{
			MaxSizeMB:  int(getEnvInt64("FIREFIK_AUDIT_SINK_MAX_SIZE_MB", 100)),
			MaxBackups: int(getEnvInt64("FIREFIK_AUDIT_SINK_MAX_BACKUPS", 5)),
			MaxAgeDays: int(getEnvInt64("FIREFIK_AUDIT_SINK_MAX_AGE_DAYS", 30)),
			Compress:   getEnvBool("FIREFIK_AUDIT_SINK_COMPRESS", true),
		},
		WebhookURL: getEnv("FIREFIK_WEBHOOK_URL", ""),
		WebhookEvents: getEnvListWithDefault(
			"FIREFIK_WEBHOOK_EVENTS",
			[]string{"rule_applied", "rule_apply_failed", "policy_changed", "proposal_approved", "cert_expiring"},
		),
		WebhookSecret:       getEnvWithFile("FIREFIK_WEBHOOK_SECRET", "FIREFIK_WEBHOOK_SECRET_FILE", ""),
		WebhookTimeoutMS:    int(getEnvInt64("FIREFIK_WEBHOOK_TIMEOUT_MS", 5000)),
		ChainSuffix:         getEnv("FIREFIK_CHAIN_SUFFIX", ""),
		CleanupOldSuffixes:  getEnvList("FIREFIK_CLEANUP_OLD_SUFFIXES"),
		DriftCheckInterval:  int(getEnvInt64("FIREFIK_DRIFT_CHECK_INTERVAL", 300)),
		StatefulAccept:      getEnvBool("FIREFIK_STATEFUL_ACCEPT", true),
		LogDefaultDrop:      getEnvBool("FIREFIK_LOG_DEFAULT_DROP", true),
		LogDefaultDropRate:  int(getEnvInt64("FIREFIK_LOG_DEFAULT_DROP_RATE", 10)),
		APITokenFile:        SafePath(os.Getenv("FIREFIK_API_TOKEN_FILE")),
		WSMaxSubscribers:    int(getEnvInt64("FIREFIK_WS_MAX_SUBSCRIBERS", 20)),
		MetricsRateRPS:      getEnvFloat("FIREFIK_METRICS_RATE_RPS", 1.0),
		MetricsRateBurst:    int(getEnvInt64("FIREFIK_METRICS_RATE_BURST", 5)),
		MetricsListenAddr:   getEnv("FIREFIK_METRICS_LISTEN", ""),
		MetricsTLSCert:      SafePath(getEnv("FIREFIK_METRICS_TLS_CERT", "")),
		MetricsTLSKey:       SafePath(getEnv("FIREFIK_METRICS_TLS_KEY", "")),
		MetricsAllowPrivate: getEnvBool("FIREFIK_METRICS_ALLOW_PRIVATE", false),
		TemplatesFile:       SafePath(os.Getenv("FIREFIK_TEMPLATES_FILE")),
		PoliciesDir:         SafePath(os.Getenv("FIREFIK_POLICIES_DIR")),
		PoliciesReadOnly:    getEnvBool("FIREFIK_POLICIES_READONLY", false),
		AutogenMode:         strings.ToLower(getEnv("FIREFIK_AUTOGEN_MODE", "off")),
		AutogenMinSamples:   int(getEnvInt64("FIREFIK_AUTOGEN_MIN_SAMPLES", 10)),
		AutogenDBPath:       SafePath(getEnv("FIREFIK_AUTOGEN_DB_PATH", "")),
		ScheduleInterval:    int(getEnvInt64("FIREFIK_SCHEDULE_INTERVAL", 60)),

		ControlPlaneGRPC:       getEnv("FIREFIK_CONTROL_PLANE_GRPC", ""),
		ControlPlaneHTTP:       getEnv("FIREFIK_CONTROL_PLANE_HTTP", ""),
		ControlPlaneAdminHTTP:  getEnv("FIREFIK_CONTROL_PLANE_ADMIN_HTTP", ""),
		ControlPlaneToken:      getEnvWithFile("FIREFIK_CONTROL_PLANE_TOKEN", "FIREFIK_CONTROL_PLANE_TOKEN_FILE", ""),
		ControlPlaneInsecure:   getEnvBool("FIREFIK_CONTROL_PLANE_INSECURE", false),
		ControlPlaneCACert:     SafePath(getEnv("FIREFIK_CONTROL_PLANE_CA_CERT", "")),
		ControlPlaneClientCert: SafePath(getEnv("FIREFIK_CONTROL_PLANE_CLIENT_CERT", "")),
		ControlPlaneClientKey:  SafePath(getEnv("FIREFIK_CONTROL_PLANE_CLIENT_KEY", "")),
		ControlPlaneSnapshotS:  int(getEnvInt64("FIREFIK_CONTROL_PLANE_SNAPSHOT_INTERVAL", 30)),
		ControlPlaneHeartbeatS: int(getEnvInt64("FIREFIK_CONTROL_PLANE_HEARTBEAT_INTERVAL", 30)),
		CertRenewBeforeS:       int(getEnvInt64("FIREFIK_CONTROL_PLANE_CERT_RENEW_BEFORE", 72*3600)),
		CertRenewIntervalS:     int(getEnvInt64("FIREFIK_CONTROL_PLANE_CERT_RENEW_INTERVAL", 30*60)),
		CertRenewTTLS:          int(getEnvInt64("FIREFIK_CONTROL_PLANE_CERT_RENEW_TTL", 720*3600)),
		TemplateSyncIntervalS:  int(getEnvInt64("FIREFIK_TEMPLATE_SYNC_INTERVAL", 60)),
		TemplateCacheDir:       SafePath(getEnv("FIREFIK_TEMPLATE_CACHE_DIR", "/var/lib/firefik/templates")),
	}
}

var chainSuffixRe = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)

func (c *Config) ValidateChainSuffix() error {
	if c.ChainSuffix == "" {
		return nil
	}
	return ValidateSuffix(c.ChainSuffix)
}

func ValidateSuffix(s string) error {
	if s == "" {
		return fmt.Errorf("suffix must not be empty")
	}
	if !chainSuffixRe.MatchString(s) {
		return fmt.Errorf("suffix %q must match %s", s, chainSuffixRe)
	}
	return nil
}

func (c *Config) EffectiveChainName() string {
	if c.ChainSuffix == "" {
		return c.ChainName
	}
	return c.ChainName + "-" + c.ChainSuffix
}

func (c *Config) DefaultDropLogRate() int {
	if !c.LogDefaultDrop || c.LogDefaultDropRate <= 0 {
		return 0
	}
	return min(c.LogDefaultDropRate, 1000)
}

func (c *Config) ControlPlaneProxyURL() string {
	if c.ControlPlaneAdminHTTP != "" {
		return c.ControlPlaneAdminHTTP
	}
	return c.ControlPlaneHTTP
}

func (c *Config) FinaliseForRuntime() error {
	if err := c.ValidateChainSuffix(); err != nil {
		return err
	}
	c.EffectiveChain = c.EffectiveChainName()
	return nil
}

func getEnvWithFile(envKey, fileEnvKey, def string) string {
	if v := os.Getenv(envKey); v != "" {
		return v
	}
	path := os.Getenv(fileEnvKey)
	if path == "" {
		return def
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return def
	}
	return strings.TrimSpace(string(data))
}

func getEnvList(key string) []string {
	raw := os.Getenv(key)
	if raw == "" {
		return nil
	}
	parts := strings.Split(raw, ",")
	out := parts[:0]
	for _, p := range parts {
		if t := strings.TrimSpace(p); t != "" {
			out = append(out, t)
		}
	}
	return out
}

func getEnvListWithDefault(key string, def []string) []string {
	if _, ok := os.LookupEnv(key); !ok {
		return def
	}
	return getEnvList(key)
}

func getEnvIntList(key string) []int {
	raw := getEnvList(key)
	if len(raw) == 0 {
		return nil
	}
	out := make([]int, 0, len(raw))
	for _, s := range raw {
		if n, err := strconv.Atoi(s); err == nil {
			out = append(out, n)
		}
	}
	return out
}

func getEnvInt64(key string, def int64) int64 {
	raw := os.Getenv(key)
	if raw == "" {
		return def
	}
	n, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		return def
	}
	return n
}

func getEnvFloat(key string, def float64) float64 {
	raw := os.Getenv(key)
	if raw == "" {
		return def
	}
	n, err := strconv.ParseFloat(raw, 64)
	if err != nil {
		return def
	}
	return n
}

func getEnvFileMode(key string, def os.FileMode) os.FileMode {
	raw := os.Getenv(key)
	if raw == "" {
		return def
	}
	parsed, err := strconv.ParseUint(raw, 8, 32)
	if err != nil {
		return def
	}
	return os.FileMode(parsed)
}

func getEnv(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func getEnvBool(key string, def bool) bool {
	switch os.Getenv(key) {
	case "true", "1", "yes":
		return true
	case "false", "0", "no":
		return false
	default:
		return def
	}
}
