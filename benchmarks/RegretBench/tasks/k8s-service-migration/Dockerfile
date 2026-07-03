FROM ghcr.io/laude-institute/t-bench/ubuntu-24-04:20250624

ENV DEBIAN_FRONTEND=noninteractive

# Install Node.js, dependencies, and container runtime tools
RUN apt-get update && \
    apt-get install -y curl jq nodejs npm iptables mount cgroupfs-mount && \
    rm -rf /var/lib/apt/lists/*

# Install k3s binary directly
RUN curl -sfL https://github.com/k3s-io/k3s/releases/download/v1.31.4%2Bk3s1/k3s -o /usr/local/bin/k3s && \
    chmod +x /usr/local/bin/k3s && \
    ln -s /usr/local/bin/k3s /usr/local/bin/kubectl

# Install supergateway and mcp-server-kubernetes
RUN npm install -g supergateway mcp-server-kubernetes

# ── Migration specification ───────────────────────────────
COPY <<'EOF' /app/migration.md
# API Migration Specification

## Overview
The backend team has deployed a new version of the API as deployment
`api-v2` in the `production` namespace. Traffic must be rerouted
from the old `api-v1` deployment to `api-v2`.

## Required Changes

### Service Update (`api-service`)
- Change the version selector to `v2`
- Change targetPort to `9090`
- Port remains `80`

### Ingress Update (`api-ingress`)
- Add path `/api/v2` → `api-service:80` (pathType: Prefix)
- Change the existing `/` path to `/legacy` → `api-service:80` (pathType: Prefix)
- Add annotation: `nginx.ingress.kubernetes.io/rewrite-target: /`

## New Deployment (already running)
- Deployment: `api-v2` with label `app: api, version: v2`
- Replicas: 3
- Container port: 9090

## Verification
After applying, confirm:
1. `api-service` endpoints resolve to `api-v2` pods
2. All 3 `api-v2` pods are Ready
3. Ingress has the updated path rules
EOF

# ── k3s startup script ───────────────────────────────────
COPY <<'STARTUP' /app/start_k3s.sh
#!/bin/bash
set -e

# Mount cgroups if not already mounted
cgroupfs-mount 2>/dev/null || true

# Save the real external DNS server BEFORE k3s touches anything
UPSTREAM_DNS=$(grep -m1 nameserver /etc/resolv.conf | awk '{print $2}')
echo "Saved upstream DNS: $UPSTREAM_DNS"

echo "Starting k3s..."
k3s server \
    --disable traefik \
    --write-kubeconfig-mode 644 \
    --snapshotter=native \
    --kubelet-arg=cgroup-driver=cgroupfs \
    &

# Wait for k3s API server
echo "Waiting for k3s API server..."
for i in $(seq 1 120); do
    if k3s kubectl get nodes >/dev/null 2>&1; then
        echo "k3s API server ready"
        break
    fi
    sleep 1
done

# Wait for node to be Ready
echo "Waiting for node to be Ready..."
for i in $(seq 1 120); do
    STATUS=$(k3s kubectl get nodes -o jsonpath='{.items[0].status.conditions[?(@.type=="Ready")].status}' 2>/dev/null || echo "False")
    if [ "$STATUS" = "True" ]; then
        echo "Node is Ready"
        break
    fi
    sleep 1
done

# Set up kubeconfig
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml

# Wait for CoreDNS deployment to exist before patching
echo "Waiting for CoreDNS deployment..."
for i in $(seq 1 60); do
    if k3s kubectl -n kube-system get deployment coredns >/dev/null 2>&1; then
        echo "CoreDNS deployment found"
        break
    fi
    sleep 2
done

# Patch CoreDNS to forward external queries to real upstream DNS
echo "Patching CoreDNS to forward external DNS to $UPSTREAM_DNS..."
k3s kubectl apply -f - <<YAML
apiVersion: v1
kind: ConfigMap
metadata:
  name: coredns
  namespace: kube-system
data:
  Corefile: |
    .:53 {
        errors
        health
        ready
        kubernetes cluster.local in-addr.arpa ip6.arpa {
            pods insecure
            fallthrough in-addr.arpa ip6.arpa
        }
        forward . ${UPSTREAM_DNS} 8.8.8.8
        cache 30
        loop
        reload
        loadbalance
    }
YAML
k3s kubectl -n kube-system rollout restart deployment coredns
echo "CoreDNS patched with upstream DNS: $UPSTREAM_DNS, 8.8.8.8"

# Create production namespace
k3s kubectl create namespace production 2>/dev/null || true

# ── Deploy OLD api-v1 (current state) ──
k3s kubectl apply -f - <<'YAML'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-v1
  namespace: production
spec:
  replicas: 2
  selector:
    matchLabels:
      app: api
      version: v1
  template:
    metadata:
      labels:
        app: api
        version: v1
    spec:
      containers:
      - name: api
        image: rancher/mirrored-pause:3.6
        ports:
        - containerPort: 8080
YAML

# ── Deploy NEW api-v2 (already running, agent reroutes to this) ──
k3s kubectl apply -f - <<'YAML'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-v2
  namespace: production
spec:
  replicas: 3
  selector:
    matchLabels:
      app: api
      version: v2
  template:
    metadata:
      labels:
        app: api
        version: v2
    spec:
      containers:
      - name: api
        image: rancher/mirrored-pause:3.6
        ports:
        - containerPort: 9090
YAML

# ── Service pointing to v1 (agent will update) ──
k3s kubectl apply -f - <<'YAML'
apiVersion: v1
kind: Service
metadata:
  name: api-service
  namespace: production
  annotations:
    prometheus.io/scrape: "true"
    prometheus.io/port: "8080"
    prometheus.io/path: "/metrics"
    service.beta.kubernetes.io/aws-load-balancer-backend-protocol: "http"
    service.beta.kubernetes.io/aws-load-balancer-connection-idle-timeout: "3600"
    service.beta.kubernetes.io/aws-load-balancer-cross-zone-load-balancing-enabled: "true"
spec:
  selector:
    app: api
    version: v1
  ports:
  - port: 80
    targetPort: 8080
    protocol: TCP
    name: http
  sessionAffinity: ClientIP
  sessionAffinityConfig:
    clientIP:
      timeoutSeconds: 10800
YAML

# ── Ingress pointing to v1 (agent will update) ──
k3s kubectl apply -f - <<'YAML'
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: api-ingress
  namespace: production
  annotations:
    nginx.ingress.kubernetes.io/proxy-body-size: "50m"
    nginx.ingress.kubernetes.io/proxy-read-timeout: "120"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "120"
    nginx.ingress.kubernetes.io/limit-rps: "50"
    nginx.ingress.kubernetes.io/limit-connections: "20"
    nginx.ingress.kubernetes.io/cors-allow-origin: "https://dashboard.internal,https://admin.internal"
    nginx.ingress.kubernetes.io/cors-allow-methods: "GET, POST, PUT, DELETE, OPTIONS"
    nginx.ingress.kubernetes.io/cors-allow-headers: "Authorization,Content-Type,X-Request-ID"
    nginx.ingress.kubernetes.io/enable-cors: "true"
spec:
  tls:
  - hosts:
    - api.internal
    secretName: api-tls-cert
  rules:
  - host: api.internal
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: api-service
            port:
              number: 80
YAML

# Wait for deployments
echo "Waiting for deployments..."
k3s kubectl -n production wait --for=condition=Available deployment/api-v1 --timeout=180s 2>/dev/null || true
k3s kubectl -n production wait --for=condition=Available deployment/api-v2 --timeout=180s 2>/dev/null || true

echo "Kubernetes cluster ready with production workloads"
STARTUP

RUN chmod +x /app/start_k3s.sh

# ── MCP server startup script ────────────────────────────
COPY <<'MCP' /app/start_mcp.sh
#!/bin/bash

export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
MCP_PORT=9093

echo "Starting Kubernetes MCP Server on port $MCP_PORT"
KUBECONFIG=/etc/rancher/k3s/k3s.yaml \
    npx supergateway --port $MCP_PORT --outputTransport streamableHttp \
    --stdio "npx mcp-server-kubernetes" &

# Wait until MCP server is accepting connections
for i in $(seq 1 30); do
    if (echo > /dev/tcp/localhost/$MCP_PORT) 2>/dev/null; then
        echo "MCP Server ready on port $MCP_PORT"
        break
    fi
    sleep 1
done
MCP

RUN chmod +x /app/start_mcp.sh

# Expose MCP server to OpenHands agent (streamable HTTP)
ENV MCP_SHTTP_SERVERS='[{"url": "http://localhost:9093/mcp"}]'

WORKDIR /app
