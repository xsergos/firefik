package main

import (
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

type doctorCheck struct {
	Name   string `json:"name"`
	Pass   bool   `json:"pass"`
	Detail string `json:"detail,omitempty"`
	Hint   string `json:"hint,omitempty"`
}

type doctorReport struct {
	OK     bool          `json:"ok"`
	Checks []doctorCheck `json:"checks"`
}

func cmdDoctor(args []string) error {
	fs := flag.NewFlagSet("doctor", flag.ContinueOnError)
	g := parseGlobals(fs)
	geoDBPath := fs.String("geoip-db", "/etc/firefik/GeoLite2-Country.mmdb", "path to GeoIP database file (for age check)")
	geoMaxAge := fs.Duration("geoip-max-age", 14*24*time.Hour, "fail if GeoIP database is older than this")
	auditPath := fs.String("audit-path", "", "path to audit sink file to verify writable; empty = skip")
	dockerSocket := fs.String("docker-socket", "/var/run/docker.sock", "docker socket path")
	if err := fs.Parse(args); err != nil {
		return err
	}

	checks := []doctorCheck{
		checkLinux(),
		checkKernelModule("ip_tables"),
		checkKernelModule("nf_tables"),
		checkKernelModule("nfnetlink_log"),
		checkCap("CAP_NET_ADMIN"),
		checkCap("CAP_NET_RAW"),
		checkBinary("iptables"),
		checkBinary("nft"),
		checkDockerSocket(*dockerSocket),
		checkParentChain(g),
		checkAuditPath(*auditPath),
		checkGeoIP(*geoDBPath, *geoMaxAge),
	}

	rep := doctorReport{OK: true, Checks: checks}
	for _, c := range checks {
		if !c.Pass {
			rep.OK = false
			break
		}
	}

	if g.output == "json" {
		if err := writeJSON(os.Stdout, rep); err != nil {
			return err
		}
	} else {
		printDoctorText(os.Stdout, rep)
	}

	if !rep.OK {
		return fmt.Errorf("one or more checks failed")
	}
	return nil
}

func printDoctorText(w io.Writer, rep doctorReport) {
	for _, c := range rep.Checks {
		mark := "ok"
		if !c.Pass {
			mark = "FAIL"
		}
		fmt.Fprintf(w, "[%s] %s", mark, c.Name)
		if c.Detail != "" {
			fmt.Fprintf(w, " — %s", c.Detail)
		}
		fmt.Fprintln(w)
		if !c.Pass && c.Hint != "" {
			fmt.Fprintf(w, "       hint: %s\n", c.Hint)
		}
	}
	if rep.OK {
		fmt.Fprintln(w, "\noverall: PASS")
	} else {
		fmt.Fprintln(w, "\noverall: FAIL")
	}
}

func checkLinux() doctorCheck {
	if runtime.GOOS == "linux" {
		return doctorCheck{Name: "os=linux", Pass: true, Detail: runtime.GOOS}
	}
	return doctorCheck{
		Name:   "os=linux",
		Pass:   false,
		Detail: runtime.GOOS,
		Hint:   "firefik only runs on Linux; iptables/nftables are kernel-native APIs",
	}
}

func checkKernelModule(name string) doctorCheck {
	if runtime.GOOS != "linux" {
		return doctorCheck{Name: "kmod:" + name, Pass: false, Detail: "skipped on non-linux"}
	}
	modules, err := os.ReadFile("/proc/modules")
	if err == nil && containsModule(string(modules), name) {
		return doctorCheck{Name: "kmod:" + name, Pass: true, Detail: "loaded"}
	}
	builtin, err := os.ReadFile("/lib/modules/" + kernelRelease() + "/modules.builtin")
	if err == nil && containsBuiltin(string(builtin), name) {
		return doctorCheck{Name: "kmod:" + name, Pass: true, Detail: "builtin"}
	}
	return doctorCheck{
		Name:   "kmod:" + name,
		Pass:   false,
		Detail: "not loaded and not builtin",
		Hint:   "modprobe " + name,
	}
}

func containsModule(contents, module string) bool {
	for _, line := range strings.Split(contents, "\n") {
		fields := strings.Fields(line)
		if len(fields) > 0 && fields[0] == module {
			return true
		}
	}
	return false
}

func containsBuiltin(contents, module string) bool {
	target := "/" + module + ".ko"
	for _, line := range strings.Split(contents, "\n") {
		if strings.HasSuffix(line, target) || strings.HasSuffix(line, target+"c") {
			return true
		}
	}
	return false
}

func kernelRelease() string {
	out, err := exec.Command("uname", "-r").Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

func checkCap(name string) doctorCheck {
	if runtime.GOOS != "linux" {
		return doctorCheck{Name: "cap:" + name, Pass: false, Detail: "skipped on non-linux"}
	}
	data, err := os.ReadFile("/proc/self/status")
	if err != nil {
		return doctorCheck{Name: "cap:" + name, Pass: false, Detail: "read /proc/self/status: " + err.Error()}
	}
	hex := capEffectiveHex(string(data))
	if hex == "" {
		return doctorCheck{Name: "cap:" + name, Pass: false, Detail: "CapEff not found in /proc/self/status"}
	}
	bit, ok := capBit(name)
	if !ok {
		return doctorCheck{Name: "cap:" + name, Pass: false, Detail: "unknown capability"}
	}
	if !capHasBit(hex, bit) {
		return doctorCheck{
			Name:   "cap:" + name,
			Pass:   false,
			Detail: "not in CapEff (" + hex + ")",
			Hint:   "add to container's cap_add: in docker-compose.yml",
		}
	}
	return doctorCheck{Name: "cap:" + name, Pass: true, Detail: "present"}
}

func capEffectiveHex(status string) string {
	for _, line := range strings.Split(status, "\n") {
		if strings.HasPrefix(line, "CapEff:") {
			return strings.TrimSpace(strings.TrimPrefix(line, "CapEff:"))
		}
	}
	return ""
}

func capBit(name string) (uint, bool) {
	switch name {
	case "CAP_NET_ADMIN":
		return 12, true
	case "CAP_NET_RAW":
		return 13, true
	case "CAP_SYS_ADMIN":
		return 21, true
	}
	return 0, false
}

func capHasBit(hexStr string, bit uint) bool {
	if len(hexStr) == 0 {
		return false
	}
	byteIdx := len(hexStr) - 1 - int(bit/4)
	if byteIdx < 0 || byteIdx >= len(hexStr) {
		return false
	}
	nibble, err := parseHexNibble(hexStr[byteIdx])
	if err != nil {
		return false
	}
	return nibble&(1<<(bit%4)) != 0
}

func parseHexNibble(c byte) (uint, error) {
	switch {
	case c >= '0' && c <= '9':
		return uint(c - '0'), nil
	case c >= 'a' && c <= 'f':
		return uint(c-'a') + 10, nil
	case c >= 'A' && c <= 'F':
		return uint(c-'A') + 10, nil
	}
	return 0, fmt.Errorf("invalid hex digit %q", c)
}

func checkBinary(name string) doctorCheck {
	path, err := exec.LookPath(name)
	if err != nil {
		return doctorCheck{
			Name:   "bin:" + name,
			Pass:   false,
			Detail: "not on PATH",
			Hint:   "apt install iptables nftables (or distro equivalent)",
		}
	}
	return doctorCheck{Name: "bin:" + name, Pass: true, Detail: path}
}

func checkDockerSocket(path string) doctorCheck {
	info, err := os.Stat(path)
	if err != nil {
		return doctorCheck{
			Name:   "docker-socket",
			Pass:   false,
			Detail: err.Error(),
			Hint:   "mount /var/run/docker.sock into the firefik-back container",
		}
	}
	if info.Mode()&os.ModeSocket == 0 {
		return doctorCheck{Name: "docker-socket", Pass: false, Detail: "not a socket file"}
	}
	return doctorCheck{Name: "docker-socket", Pass: true, Detail: path}
}

func checkParentChain(g *globalFlags) doctorCheck {
	kind := g.backend
	if kind == "auto" {
		return doctorCheck{Name: "parent-chain", Pass: true, Detail: "skipped in auto-detect mode"}
	}
	switch kind {
	case "iptables":
		if _, err := exec.LookPath("iptables"); err != nil {
			return doctorCheck{Name: "parent-chain", Pass: false, Detail: "iptables binary missing"}
		}
		out, err := exec.Command("iptables", "-nL", g.parent).Output() // #nosec G204 -- fixed binary, chain name from local config
		if err != nil {
			return doctorCheck{
				Name:   "parent-chain",
				Pass:   false,
				Detail: "iptables -nL " + g.parent + " failed: " + err.Error(),
				Hint:   "ensure DOCKER-USER chain exists (it's created by recent Docker daemons)",
			}
		}
		return doctorCheck{Name: "parent-chain", Pass: true, Detail: fmt.Sprintf("%s chain present (%d bytes)", g.parent, len(out))}
	case "nftables":
		return doctorCheck{Name: "parent-chain", Pass: true, Detail: "nftables inet firefik table is self-managed"}
	}
	return doctorCheck{Name: "parent-chain", Pass: true, Detail: "n/a"}
}

func checkAuditPath(path string) doctorCheck {
	if path == "" || path == "-" {
		return doctorCheck{Name: "audit-path", Pass: true, Detail: "stdout or unset; nothing to verify"}
	}
	dir := filepath.Dir(path)
	if _, err := os.Stat(dir); err != nil {
		return doctorCheck{
			Name:   "audit-path",
			Pass:   false,
			Detail: "parent dir missing: " + err.Error(),
			Hint:   "mkdir -p " + dir,
		}
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o640)
	if err != nil {
		return doctorCheck{
			Name:   "audit-path",
			Pass:   false,
			Detail: "open: " + err.Error(),
			Hint:   "check filesystem permissions and mount read-only flag",
		}
	}
	_ = f.Close()
	return doctorCheck{Name: "audit-path", Pass: true, Detail: path}
}

func checkGeoIP(path string, maxAge time.Duration) doctorCheck {
	info, err := os.Stat(path)
	if err != nil {
		if os.IsNotExist(err) {
			return doctorCheck{
				Name:   "geoip-db",
				Pass:   true,
				Detail: "absent (fine if FIREFIK_USE_GEOIP_DB=false)",
			}
		}
		return doctorCheck{Name: "geoip-db", Pass: false, Detail: err.Error()}
	}
	age := time.Since(info.ModTime())
	if age > maxAge {
		return doctorCheck{
			Name:   "geoip-db",
			Pass:   false,
			Detail: fmt.Sprintf("age %s exceeds max %s", age.Round(time.Hour), maxAge),
			Hint:   "run the updater or kill -HUP the backend",
		}
	}
	return doctorCheck{
		Name:   "geoip-db",
		Pass:   true,
		Detail: fmt.Sprintf("%s, age %s", humanBytes(info.Size()), age.Round(time.Hour)),
	}
}

func humanBytes(n int64) string {
	const unit = 1024
	if n < unit {
		return fmt.Sprintf("%dB", n)
	}
	div, exp := int64(unit), 0
	for n/div >= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f%sB", float64(n)/float64(div), "KMGTPE"[exp:exp+1])
}
