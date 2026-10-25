package api

import (
	"bytes"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

type ControlPlaneProxy struct {
	BaseURL string
	Token   string
	Client  *http.Client
}

func NewControlPlaneProxy(baseURL, token, caFile string, insecure bool) (*ControlPlaneProxy, error) {
	if baseURL == "" {
		return nil, errors.New("control-plane HTTP base URL not set")
	}
	tlsCfg := &tls.Config{InsecureSkipVerify: insecure} // #nosec G402 -- explicit operator opt-in flag
	if caFile != "" {
		pem, err := os.ReadFile(caFile)
		if err != nil {
			return nil, fmt.Errorf("read CA: %w", err)
		}
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM(pem) {
			return nil, errors.New("invalid control-plane CA bundle")
		}
		tlsCfg.RootCAs = pool
	}
	return &ControlPlaneProxy{
		BaseURL: strings.TrimRight(baseURL, "/"),
		Token:   token,
		Client: &http.Client{
			Timeout:   10 * time.Second,
			Transport: &http.Transport{TLSClientConfig: tlsCfg},
		},
	}, nil
}

func (p *ControlPlaneProxy) Forward(c *gin.Context, method, path string, body io.Reader) {
	url := p.BaseURL + path
	if c.Request.URL.RawQuery != "" {
		url += "?" + c.Request.URL.RawQuery
	}
	req, err := http.NewRequestWithContext(c.Request.Context(), method, url, body)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	req.Header.Set("Content-Type", "application/json")
	if p.Token != "" {
		req.Header.Set("Authorization", "Bearer "+p.Token)
	}
	resp, err := p.Client.Do(req)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(resp.Body)
	c.Data(resp.StatusCode, resp.Header.Get("Content-Type"), respBody)
}

// @Summary List control-plane templates
// @Description Proxies GET /v1/templates on the configured control-plane.
// @Tags templates
// @Produce json
// @Security BearerAuth
// @Success 200 {array} object
// @Failure 502 {object} APIError
// @Router /api/templates [get]
func (p *ControlPlaneProxy) handleTemplatesList(c *gin.Context) {
	p.Forward(c, http.MethodGet, "/v1/templates", nil)
}

// @Summary Publish a control-plane template
// @Description Proxies POST /v1/templates on the configured control-plane.
// @Tags templates
// @Accept json
// @Produce json
// @Security BearerAuth
// @Param body body object true "template payload"
// @Success 200 {object} object
// @Failure 502 {object} APIError
// @Router /api/templates [post]
func (p *ControlPlaneProxy) handleTemplatePublish(c *gin.Context) {
	body, _ := io.ReadAll(c.Request.Body)
	p.Forward(c, http.MethodPost, "/v1/templates", bytes.NewReader(body))
}

// @Summary Get a control-plane template
// @Description Proxies GET /v1/templates/{name} on the configured control-plane.
// @Tags templates
// @Produce json
// @Security BearerAuth
// @Param name path string true "template name"
// @Success 200 {object} object
// @Failure 502 {object} APIError
// @Router /api/templates/{name} [get]
func (p *ControlPlaneProxy) handleTemplateGet(c *gin.Context) {
	p.Forward(c, http.MethodGet, "/v1/templates/"+c.Param("name"), nil)
}

// @Summary List approvals
// @Description Proxies GET /v1/approvals on the configured control-plane.
// @Tags approvals
// @Produce json
// @Security BearerAuth
// @Success 200 {array} object
// @Failure 502 {object} APIError
// @Router /api/approvals [get]
func (p *ControlPlaneProxy) handleApprovalsList(c *gin.Context) {
	p.Forward(c, http.MethodGet, "/v1/approvals", nil)
}

// @Summary Create an approval request
// @Description Proxies POST /v1/approvals on the configured control-plane.
// @Tags approvals
// @Accept json
// @Produce json
// @Security BearerAuth
// @Param body body object true "approval payload"
// @Success 200 {object} object
// @Failure 502 {object} APIError
// @Router /api/approvals [post]
func (p *ControlPlaneProxy) handleApprovalCreate(c *gin.Context) {
	body, _ := io.ReadAll(c.Request.Body)
	p.Forward(c, http.MethodPost, "/v1/approvals", bytes.NewReader(body))
}

// @Summary Get an approval
// @Description Proxies GET /v1/approvals/{id} on the configured control-plane.
// @Tags approvals
// @Produce json
// @Security BearerAuth
// @Param id path string true "approval ID"
// @Success 200 {object} object
// @Failure 502 {object} APIError
// @Router /api/approvals/{id} [get]
func (p *ControlPlaneProxy) handleApprovalGet(c *gin.Context) {
	p.Forward(c, http.MethodGet, "/v1/approvals/"+c.Param("id"), nil)
}

// @Summary Approve an approval request
// @Description Proxies POST /v1/approvals/{id}/approve on the configured control-plane.
// @Tags approvals
// @Accept json
// @Produce json
// @Security BearerAuth
// @Param id path string true "approval ID"
// @Param body body object false "approval decision payload"
// @Success 200 {object} object
// @Failure 502 {object} APIError
// @Router /api/approvals/{id}/approve [post]
func (p *ControlPlaneProxy) handleApprovalApprove(c *gin.Context) {
	body, _ := io.ReadAll(c.Request.Body)
	p.Forward(c, http.MethodPost, "/v1/approvals/"+c.Param("id")+"/approve", bytes.NewReader(body))
}

// @Summary Reject an approval request
// @Description Proxies POST /v1/approvals/{id}/reject on the configured control-plane.
// @Tags approvals
// @Accept json
// @Produce json
// @Security BearerAuth
// @Param id path string true "approval ID"
// @Param body body object false "rejection payload"
// @Success 200 {object} object
// @Failure 502 {object} APIError
// @Router /api/approvals/{id}/reject [post]
func (p *ControlPlaneProxy) handleApprovalReject(c *gin.Context) {
	body, _ := io.ReadAll(c.Request.Body)
	p.Forward(c, http.MethodPost, "/v1/approvals/"+c.Param("id")+"/reject", bytes.NewReader(body))
}

// @Summary List fleet agents
// @Description Proxies GET /v1/agents on the configured control-plane.
// @Tags fleet
// @Produce json
// @Security BearerAuth
// @Success 200 {array} object
// @Failure 502 {object} APIError
// @Router /api/agents [get]
func (p *ControlPlaneProxy) handleAgentsList(c *gin.Context) {
	p.Forward(c, http.MethodGet, "/v1/agents", nil)
}

// @Summary Get agent detail
// @Description Proxies GET /v1/agents/{id} on the configured control-plane.
// @Tags fleet
// @Produce json
// @Security BearerAuth
// @Param id path string true "agent instance id"
// @Success 200 {object} object
// @Failure 502 {object} APIError
// @Router /api/agents/{id} [get]
func (p *ControlPlaneProxy) handleAgentGet(c *gin.Context) {
	p.Forward(c, http.MethodGet, "/v1/agents/"+c.Param("id"), nil)
}

// @Summary Get agent latest snapshot
// @Description Proxies GET /v1/agents/{id}/snapshot on the configured control-plane.
// @Tags fleet
// @Produce json
// @Security BearerAuth
// @Param id path string true "agent instance id"
// @Success 200 {object} object
// @Failure 502 {object} APIError
// @Router /api/agents/{id}/snapshot [get]
func (p *ControlPlaneProxy) handleAgentSnapshot(c *gin.Context) {
	p.Forward(c, http.MethodGet, "/v1/agents/"+c.Param("id")+"/snapshot", nil)
}

// @Summary Send command to an agent
// @Description Proxies POST /v1/agents/{id}/commands on the configured control-plane.
// @Tags fleet
// @Accept json
// @Produce json
// @Security BearerAuth
// @Param id path string true "agent instance id"
// @Param body body object true "command payload"
// @Success 202 {object} object
// @Failure 502 {object} APIError
// @Router /api/agents/{id}/commands [post]
func (p *ControlPlaneProxy) handleAgentCommand(c *gin.Context) {
	body, _ := io.ReadAll(c.Request.Body)
	p.Forward(c, http.MethodPost, "/v1/agents/"+c.Param("id")+"/commands", bytes.NewReader(body))
}

// @Summary List enrollment tokens
// @Description Proxies GET /v1/enrollment-tokens on the configured control-plane.
// @Tags fleet
// @Produce json
// @Security BearerAuth
// @Success 200 {array} object
// @Failure 502 {object} APIError
// @Router /api/enrollment-tokens [get]
func (p *ControlPlaneProxy) handleEnrollmentTokensList(c *gin.Context) {
	p.Forward(c, http.MethodGet, "/v1/enrollment-tokens", nil)
}

// @Summary Create enrollment token
// @Description Proxies POST /v1/enrollment-tokens on the configured control-plane.
// @Tags fleet
// @Accept json
// @Produce json
// @Security BearerAuth
// @Param body body object true "agent_id and ttl_seconds"
// @Success 201 {object} object
// @Failure 502 {object} APIError
// @Router /api/enrollment-tokens [post]
func (p *ControlPlaneProxy) handleEnrollmentTokenCreate(c *gin.Context) {
	body, _ := io.ReadAll(c.Request.Body)
	p.Forward(c, http.MethodPost, "/v1/enrollment-tokens", bytes.NewReader(body))
}
