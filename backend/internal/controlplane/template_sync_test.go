package controlplane

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"

	pb "firefik/internal/controlplane/gen/controlplanev1"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/test/bufconn"
)

func TestTemplateSyncer_saveToDisk_RemovesStaleAndPartialFiles(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "stale.json"), []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "leftover.part"), []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "other.txt"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	ts := &TemplateSyncer{cfg: TemplateSyncerConfig{CacheDir: dir}}
	ts.saveToDisk(map[string]PolicyTemplate{
		"kept": {Name: "kept", Body: "default: allow"},
	})

	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	names := map[string]struct{}{}
	for _, e := range entries {
		names[e.Name()] = struct{}{}
	}
	if _, ok := names["kept.json"]; !ok {
		t.Errorf("kept.json missing: %+v", names)
	}
	if _, ok := names["stale.json"]; ok {
		t.Errorf("stale.json should be removed")
	}
	if _, ok := names["leftover.part"]; ok {
		t.Errorf(".part should be removed")
	}
	if _, ok := names["other.txt"]; !ok {
		t.Errorf("non-json/.part files should be untouched")
	}
}

func TestTemplateSyncer_saveToDisk_NoCacheDir(t *testing.T) {
	ts := &TemplateSyncer{cfg: TemplateSyncerConfig{CacheDir: "/this/path/should/not/exist/xyz123"}}
	ts.saveToDisk(map[string]PolicyTemplate{"x": {Name: "x"}})
}

func TestTemplateSyncer_warn(t *testing.T) {
	ts := &TemplateSyncer{cfg: TemplateSyncerConfig{}}
	ts.warn("nil-logger", io.EOF)

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	ts2 := &TemplateSyncer{cfg: TemplateSyncerConfig{Logger: logger, Endpoint: "p"}}
	ts2.warn("real", io.EOF)
	ts2.warn("canceled-ignored", context.Canceled)
}

func newTestSyncerServer(t *testing.T, store Store) (*grpc.Server, string) {
	t.Helper()
	lis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	srv := grpc.NewServer()
	pb.RegisterControlPlaneServer(srv, &GRPCServer{
		Registry: NewRegistryWithStore(slog.New(slog.NewTextHandler(io.Discard, nil)), store),
	})
	go func() { _ = srv.Serve(lis) }()
	t.Cleanup(srv.Stop)
	return srv, lis.Addr().String()
}

func TestTemplateSyncer_PullsAndCachesToDisk(t *testing.T) {
	store := NewMemoryStore()
	if _, err := store.PublishTemplate(context.Background(), PolicyTemplate{
		Name: "deny-egress",
		Body: "default: deny",
	}); err != nil {
		t.Fatal(err)
	}
	_, addr := newTestSyncerServer(t, store)
	dir := t.TempDir()
	syncer := NewTemplateSyncer(TemplateSyncerConfig{
		Endpoint: addr,
		Interval: 10 * time.Millisecond,
		CacheDir: dir,
		Logger:   slog.New(slog.NewTextHandler(io.Discard, nil)),
	})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	go func() { _ = syncer.Run(ctx) }()

	deadline := time.Now().Add(2 * time.Second)
	var files []os.DirEntry
	for time.Now().Before(deadline) {
		files, _ = os.ReadDir(dir)
		if len(syncer.Snapshot()) == 1 && len(files) == 1 && files[0].Name() == "deny-egress.json" {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}

	got := syncer.Snapshot()
	if len(got) != 1 || got[0].Name != "deny-egress" {
		t.Fatalf("snapshot: %+v", got)
	}
	if _, ok := syncer.Get("deny-egress"); !ok {
		t.Error("Get failed")
	}
	if len(files) != 1 || files[0].Name() != "deny-egress.json" {
		t.Errorf("cache dir: %v", files)
	}
}

func TestTemplateSyncer_LoadFromDiskOnStart(t *testing.T) {
	dir := t.TempDir()
	tmpl := PolicyTemplate{Name: "from-disk", Body: "x", Version: 5}
	body, _ := json.Marshal(tmpl)
	if err := os.WriteFile(filepath.Join(dir, "from-disk.json"), body, 0o600); err != nil {
		t.Fatal(err)
	}
	syncer := NewTemplateSyncer(TemplateSyncerConfig{
		Endpoint: "",
		CacheDir: dir,
	})
	syncer.loadFromDisk()
	got, ok := syncer.Get("from-disk")
	if !ok {
		t.Fatal("expected loaded from disk")
	}
	if got.Version != 5 {
		t.Errorf("version = %d", got.Version)
	}
}

func TestTemplateSyncer_IgnoresBadJSON(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "bad.json"), []byte("not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	syncer := NewTemplateSyncer(TemplateSyncerConfig{CacheDir: dir})
	syncer.loadFromDisk()
	if got := syncer.Snapshot(); len(got) != 0 {
		t.Errorf("expected empty, got %+v", got)
	}
}

func TestTemplateSyncer_NoEndpointReturnsImmediately(t *testing.T) {
	syncer := NewTemplateSyncer(TemplateSyncerConfig{})
	if err := syncer.Run(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestSanitiseTemplateName(t *testing.T) {
	cases := map[string]string{
		"deny":          "deny",
		"deny-egress":   "deny-egress",
		"a/b":           "a_b",
		"name with sp.": "name_with_sp_",
		"":              "_",
	}
	for in, want := range cases {
		if got := sanitiseTemplateName(in); got != want {
			t.Errorf("sanitise(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestTemplateSyncer_WarnSkipsCanceled(t *testing.T) {
	syncer := NewTemplateSyncer(TemplateSyncerConfig{
		Endpoint: "1.2.3.4:5555",
		Logger:   slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	syncer.warn("stage", context.Canceled)
}

func TestTemplateSyncer_BufconnIntegration(t *testing.T) {
	lis := bufconn.Listen(64 * 1024)
	srv := grpc.NewServer()
	store := NewMemoryStore()
	if _, err := store.PublishTemplate(context.Background(), PolicyTemplate{Name: "x", Body: "y"}); err != nil {
		t.Fatal(err)
	}
	pb.RegisterControlPlaneServer(srv, &GRPCServer{
		Registry: NewRegistryWithStore(slog.New(slog.NewTextHandler(io.Discard, nil)), store),
	})
	go func() { _ = srv.Serve(lis) }()
	t.Cleanup(srv.Stop)

	conn, err := grpc.DialContext(context.Background(), "bufconn",
		grpc.WithContextDialer(func(_ context.Context, _ string) (net.Conn, error) { return lis.Dial() }),
		grpc.WithTransportCredentials(insecure.NewCredentials()),
		grpc.WithBlock(),
	)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	cli := pb.NewControlPlaneClient(conn)
	resp, err := cli.ListTemplates(context.Background(), &pb.ListTemplatesRequest{})
	if err != nil {
		t.Fatal(err)
	}
	if len(resp.Templates) != 1 || resp.Templates[0].Name != "x" {
		t.Errorf("unexpected: %+v", resp.Templates)
	}
}
