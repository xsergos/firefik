package main

import (
	"bufio"
	"crypto/tls"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"sort"
	"strings"
	"time"
)

func cmdMetricsAudit(args []string) error {
	fs := flag.NewFlagSet("metrics-audit", flag.ContinueOnError)
	g := parseGlobals(fs)
	source := fs.String("source", "", "URL or file path to read /metrics output (empty = stdin)")
	token := fs.String("token", "", "bearer token for HTTP source")
	threshold := fs.Int("threshold", 100, "report metrics whose cardinality exceeds this value as exceeding")
	insecure := fs.Bool("insecure", false, "skip TLS verification when source is HTTPS")
	timeout := fs.Duration("timeout", 5*time.Second, "HTTP timeout for source")
	if err := fs.Parse(args); err != nil {
		return err
	}

	reader, closer, err := openMetricsSource(*source, *token, *insecure, *timeout)
	if err != nil {
		return err
	}
	if closer != nil {
		defer closer.Close()
	}

	report, err := analyseMetrics(reader, *threshold)
	if err != nil {
		return err
	}

	switch g.output {
	case "json":
		return writeJSON(os.Stdout, report)
	default:
		printMetricsAudit(os.Stdout, report)
	}

	if report.Exceeded > 0 {
		os.Exit(2)
	}
	return nil
}

type metricCardinality struct {
	Name        string   `json:"name"`
	Cardinality int      `json:"cardinality"`
	LabelKeys   []string `json:"label_keys"`
	Exceeds     bool     `json:"exceeds"`
}

type metricsAuditReport struct {
	Threshold int                 `json:"threshold"`
	Total     int                 `json:"total_metrics"`
	Exceeded  int                 `json:"exceeded_metrics"`
	Metrics   []metricCardinality `json:"metrics"`
}

func openMetricsSource(source, token string, insecure bool, timeout time.Duration) (io.Reader, io.Closer, error) {
	if source == "" {
		return os.Stdin, nil, nil
	}
	if strings.HasPrefix(source, "http://") || strings.HasPrefix(source, "https://") {
		client := &http.Client{Timeout: timeout}
		if insecure {
			client.Transport = &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}} // #nosec G402 -- explicit operator opt-in flag
		}
		req, err := http.NewRequest(http.MethodGet, source, nil)
		if err != nil {
			return nil, nil, err
		}
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		resp, err := client.Do(req)
		if err != nil {
			return nil, nil, fmt.Errorf("fetch %s: %w", source, err)
		}
		if resp.StatusCode != 200 {
			resp.Body.Close()
			return nil, nil, fmt.Errorf("fetch %s: status %d", source, resp.StatusCode)
		}
		return resp.Body, resp.Body, nil
	}
	f, err := os.Open(source)
	if err != nil {
		return nil, nil, err
	}
	return f, f, nil
}

func analyseMetrics(r io.Reader, threshold int) (*metricsAuditReport, error) {
	type bucket struct {
		series    map[string]struct{}
		labelKeys map[string]struct{}
	}
	buckets := map[string]*bucket{}

	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		name, labels := parseMetricLine(line)
		if name == "" {
			continue
		}
		base := baseName(name)
		b, ok := buckets[base]
		if !ok {
			b = &bucket{series: map[string]struct{}{}, labelKeys: map[string]struct{}{}}
			buckets[base] = b
		}
		key := name
		if labels != "" {
			key = name + "{" + labels + "}"
		}
		b.series[key] = struct{}{}
		for _, lk := range labelKeyList(labels) {
			b.labelKeys[lk] = struct{}{}
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}

	report := &metricsAuditReport{Threshold: threshold}
	for name, b := range buckets {
		keys := make([]string, 0, len(b.labelKeys))
		for k := range b.labelKeys {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		mc := metricCardinality{
			Name:        name,
			Cardinality: len(b.series),
			LabelKeys:   keys,
			Exceeds:     len(b.series) > threshold,
		}
		if mc.Exceeds {
			report.Exceeded++
		}
		report.Metrics = append(report.Metrics, mc)
	}
	report.Total = len(report.Metrics)
	sort.Slice(report.Metrics, func(i, j int) bool {
		return report.Metrics[i].Cardinality > report.Metrics[j].Cardinality
	})
	return report, nil
}

func parseMetricLine(line string) (name, labels string) {
	open := strings.IndexByte(line, '{')
	close := strings.LastIndexByte(line, '}')
	if open < 0 {
		space := strings.IndexByte(line, ' ')
		if space < 0 {
			return line, ""
		}
		return line[:space], ""
	}
	if close <= open {
		return "", ""
	}
	return line[:open], line[open+1 : close]
}

func baseName(metric string) string {
	for _, suffix := range []string{"_bucket", "_count", "_sum", "_total"} {
		if strings.HasSuffix(metric, suffix) {
			return strings.TrimSuffix(metric, suffix)
		}
	}
	return metric
}

func labelKeyList(labels string) []string {
	if labels == "" {
		return nil
	}
	out := make([]string, 0, 4)
	depth := 0
	start := 0
	for i := 0; i <= len(labels); i++ {
		if i == len(labels) || (labels[i] == ',' && depth == 0) {
			pair := strings.TrimSpace(labels[start:i])
			start = i + 1
			eq := strings.IndexByte(pair, '=')
			if eq <= 0 {
				continue
			}
			out = append(out, pair[:eq])
			continue
		}
		if labels[i] == '"' {
			if depth == 0 {
				depth = 1
			} else {
				depth = 0
			}
		}
	}
	return out
}

func printMetricsAudit(w io.Writer, report *metricsAuditReport) {
	fmt.Fprintf(w, "Metrics analysed: %d\n", report.Total)
	fmt.Fprintf(w, "Threshold: %d\n", report.Threshold)
	fmt.Fprintf(w, "Exceeding threshold: %d\n\n", report.Exceeded)
	fmt.Fprintf(w, "%-60s %12s  %s\n", "metric", "cardinality", "label keys")
	for _, m := range report.Metrics {
		mark := " "
		if m.Exceeds {
			mark = "!"
		}
		labels := strings.Join(m.LabelKeys, ",")
		if labels == "" {
			labels = "-"
		}
		fmt.Fprintf(w, "%s %-58s %12d  %s\n", mark, m.Name, m.Cardinality, labels)
	}
}
