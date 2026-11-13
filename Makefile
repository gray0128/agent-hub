export PATH := /opt/homebrew/bin:$(HOME)/.local/bin:$(HOME)/.bun/bin:$(PATH)

VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
LDFLAGS := -s -w -X main.version=$(VERSION)

.PHONY: build-go build-fakeagent build-cross build-web test-unit eval-schema eval-fast eval-ui eval-agent

build-go:
	mkdir -p bin
	CGO_ENABLED=0 go build -trimpath -ldflags="$(LDFLAGS)" -o bin/ahub ./cmd/ahub

build-fakeagent:
	mkdir -p bin
	CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o bin/ahub-fakeagent ./evals/substrate/fakeagent

build-cross:
	mkdir -p bin/dist
	GOOS=darwin  GOARCH=arm64 CGO_ENABLED=0 go build -trimpath -ldflags="$(LDFLAGS)" -o bin/dist/ahub-darwin-arm64 ./cmd/ahub
	GOOS=darwin  GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags="$(LDFLAGS)" -o bin/dist/ahub-darwin-amd64 ./cmd/ahub
	GOOS=linux   GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags="$(LDFLAGS)" -o bin/dist/ahub-linux-amd64 ./cmd/ahub
	GOOS=linux   GOARCH=arm64 CGO_ENABLED=0 go build -trimpath -ldflags="$(LDFLAGS)" -o bin/dist/ahub-linux-arm64 ./cmd/ahub
	GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags="$(LDFLAGS)" -o bin/dist/ahub-windows-amd64.exe ./cmd/ahub

build-web:
	pnpm --filter @ahub/web build

test-unit:
	go test -v ./internal/... ./evals/formal/...
	pnpm --filter @ahub/hub-worker test

eval-schema:
	node evals/substrate/validate-schemas.mjs

eval-fast: eval-schema build-go build-fakeagent
	mkdir -p apps/web/dist
	go test -v ./internal/... ./evals/formal/...
	go test -v -count=1 ./evals/substrate -run TestInvariant
	node evals/web/lint-hygiene.mjs

eval-ui: eval-fast build-web
	node evals/web/cdp-runtime-eval.mjs

eval-agent: build-go build-fakeagent
	python3 evals/agent-cli/harness.py --driver contract --repeat 3
