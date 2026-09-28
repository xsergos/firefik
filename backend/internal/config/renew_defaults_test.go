package config_test

import (
	"testing"
	"time"

	"firefik/internal/config"
	"firefik/internal/controlplane"
)

func TestCertRenewBeforeDefaultWithinControlPlaneWindow(t *testing.T) {
	t.Setenv("FIREFIK_CONTROL_PLANE_CERT_RENEW_BEFORE", "")
	got := time.Duration(config.Load().CertRenewBeforeS) * time.Second
	if got != controlplane.DefaultCertRenewBefore {
		t.Fatalf("config default renew-before %s differs from controlplane.DefaultCertRenewBefore %s", got, controlplane.DefaultCertRenewBefore)
	}
	if got > controlplane.DefaultRenewWindow {
		t.Fatalf("agent default renew-before %s exceeds CP default renew window %s", got, controlplane.DefaultRenewWindow)
	}
}
