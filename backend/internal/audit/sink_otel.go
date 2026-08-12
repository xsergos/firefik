package audit

import (
	"context"
	"encoding/json"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/log"
	"go.opentelemetry.io/otel/log/global"
)

const otelLoggerScope = "firefik/audit"

type OTelSink struct {
	logger log.Logger
}

func NewOTelSink() Sink {
	return &OTelSink{logger: global.GetLoggerProvider().Logger(otelLoggerScope)}
}

func (s *OTelSink) Write(ev Event) error {
	if s.logger == nil {
		return nil
	}
	rec := log.Record{}
	ts := ev.Timestamp
	if ts.IsZero() {
		ts = time.Now().UTC()
	}
	rec.SetTimestamp(ts)
	rec.SetObservedTimestamp(time.Now().UTC())
	rec.SetSeverity(severityForAction(ev.Action))
	rec.SetSeverityText(severityTextForAction(ev.Action))
	body, err := json.Marshal(ev)
	if err != nil {
		return err
	}
	rec.SetBody(attribute.StringValue(string(body)))
	rec.AddAttributes(
		attribute.String("audit.action", ev.Action),
		attribute.String("audit.source", string(ev.Source)),
		attribute.String("audit.container_id", ev.ContainerID),
		attribute.String("audit.container_name", ev.ContainerName),
	)
	if ev.DefaultPolicy != "" {
		rec.AddAttributes(attribute.String("audit.default_policy", ev.DefaultPolicy))
	}
	if ev.RuleSets > 0 {
		rec.AddAttributes(attribute.Int64("audit.rule_sets", int64(ev.RuleSets)))
	}
	for k, v := range ev.Metadata {
		rec.AddAttributes(attribute.String("audit.metadata."+k, v))
	}
	s.logger.Emit(context.Background(), rec)
	return nil
}

func (s *OTelSink) Close() error { return nil }

func severityForAction(action string) log.Severity {
	switch action {
	case "rule_apply_failed":
		return log.SeverityError
	case "rule_drift_detected", "policy_approval_rejected":
		return log.SeverityWarn
	default:
		return log.SeverityInfo
	}
}

func severityTextForAction(action string) string {
	switch action {
	case "rule_apply_failed":
		return "ERROR"
	case "rule_drift_detected", "policy_approval_rejected":
		return "WARN"
	default:
		return "INFO"
	}
}
