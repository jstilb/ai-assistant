# AddObservability Workflow

**Add comprehensive observability (logging, tracing, metrics, LLM monitoring) to AI agent projects.**

---

## Voice Notification

```bash
curl -s -X POST http://localhost:8888/notify \
  -H "Content-Type: application/json" \
  -d '{"message": "Running the AddObservability workflow from the AgentProjectSetup skill"}' \
  > /dev/null 2>&1 &
```

---

## Prerequisites

Confirm with user:

1. **Project path** - Location of existing agent project
2. **Observability stack**:
   - LangSmith (default for LLM tracing)
   - OpenTelemetry (general distributed tracing)
   - Prometheus + Grafana (metrics)
   - Custom logging
3. **Integration depth**:
   - Basic (logging + LangSmith)
   - Standard (+ metrics + alerting)
   - Full (+ distributed tracing + dashboards)
4. **Alert destinations**:
   - Slack
   - PagerDuty
   - Email
   - Discord

---

## Step 1: Install Observability Dependencies

### Python

Add to `pyproject.toml`:

```toml
[project.optional-dependencies]
observability = [
    "langsmith>=0.1.0",
    "opentelemetry-api>=1.22.0",
    "opentelemetry-sdk>=1.22.0",
    "opentelemetry-exporter-otlp>=1.22.0",
    "opentelemetry-instrumentation-httpx>=0.43b0",
    "prometheus-client>=0.19.0",
    "structlog>=24.1.0",
]
```

Install:

```bash
pip install -e ".[observability]"
```

### TypeScript

```bash
bun add langsmith @opentelemetry/api @opentelemetry/sdk-node \
    @opentelemetry/exporter-trace-otlp-http prom-client pino
```

---

## Step 2: Configure Structured Logging

### Python: `src/utils/logging.py`

```python
"""Structured logging configuration for AI agents."""
import sys
from typing import Any

import structlog
from structlog.types import Processor

def add_agent_context(
    logger: Any, method_name: str, event_dict: dict[str, Any]
) -> dict[str, Any]:
    """Add agent-specific context to all logs."""
    # Add run ID if available
    from contextvars import ContextVar
    run_id: ContextVar[str | None] = ContextVar("run_id", default=None)

    if run_id.get():
        event_dict["run_id"] = run_id.get()

    return event_dict


def configure_logging(
    log_level: str = "INFO",
    log_format: str = "pretty",
    environment: str = "development",
) -> None:
    """Configure structured logging for the application."""

    # Common processors
    common_processors: list[Processor] = [
        structlog.contextvars.merge_contextvars,
        structlog.processors.add_log_level,
        structlog.processors.TimeStamper(fmt="iso"),
        add_agent_context,
        structlog.processors.StackInfoRenderer(),
        structlog.processors.UnicodeDecoder(),
    ]

    if log_format == "json" or environment == "production":
        # JSON format for production
        processors = common_processors + [
            structlog.processors.format_exc_info,
            structlog.processors.JSONRenderer(),
        ]
    else:
        # Pretty format for development
        processors = common_processors + [
            structlog.dev.ConsoleRenderer(colors=True),
        ]

    structlog.configure(
        processors=processors,
        wrapper_class=structlog.make_filtering_bound_logger(
            getattr(structlog, log_level.upper(), structlog.INFO)
        ),
        context_class=dict,
        logger_factory=structlog.PrintLoggerFactory(file=sys.stdout),
        cache_logger_on_first_use=True,
    )


def get_logger(name: str) -> structlog.BoundLogger:
    """Get a logger instance with the given name."""
    return structlog.get_logger(name)


# Usage example
# logger = get_logger(__name__)
# logger.info("Processing message", user_id="123", intent="search")
```

### TypeScript: `src/utils/logging.ts`

```typescript
import pino from "pino";

interface LogContext {
  runId?: string;
  userId?: string;
  intent?: string;
  [key: string]: unknown;
}

const createLogger = (
  name: string,
  options: {
    level?: string;
    format?: "pretty" | "json";
    environment?: string;
  } = {}
) => {
  const { level = "info", format = "pretty", environment = "development" } = options;

  const transport =
    format === "pretty" && environment !== "production"
      ? {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "SYS:standard",
            ignore: "pid,hostname",
          },
        }
      : undefined;

  return pino({
    name,
    level,
    transport,
    formatters: {
      level: (label) => ({ level: label }),
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
};

// Singleton logger instance
let logger: pino.Logger | null = null;

export const getLogger = (name: string): pino.Logger => {
  if (!logger) {
    logger = createLogger(name, {
      level: process.env.LOG_LEVEL ?? "info",
      format: (process.env.LOG_FORMAT as "pretty" | "json") ?? "pretty",
      environment: process.env.ENVIRONMENT ?? "development",
    });
  }
  return logger.child({ module: name });
};

export const logWithContext = (
  logger: pino.Logger,
  context: LogContext
): pino.Logger => {
  return logger.child(context);
};
```

---

## Step 3: Configure LangSmith Integration

### Python: `src/utils/langsmith_config.py`

```python
"""LangSmith configuration for LLM observability."""
import os
from contextlib import contextmanager
from typing import Any, Generator

from langsmith import Client
from langsmith.run_helpers import traceable


def configure_langsmith() -> Client | None:
    """Configure LangSmith client if enabled."""
    if not os.getenv("LANGCHAIN_TRACING_V2", "").lower() == "true":
        return None

    api_key = os.getenv("LANGCHAIN_API_KEY")
    if not api_key:
        return None

    return Client(api_key=api_key)


@contextmanager
def langsmith_trace(
    name: str,
    run_type: str = "chain",
    metadata: dict[str, Any] | None = None,
    tags: list[str] | None = None,
) -> Generator[None, None, None]:
    """Context manager for LangSmith tracing."""
    # This is a simplified wrapper - in practice, use @traceable decorator
    yield


# Decorator for tracing functions
def trace_agent_call(
    name: str | None = None,
    run_type: str = "chain",
    metadata: dict[str, Any] | None = None,
):
    """Decorator to trace agent calls with LangSmith."""
    def decorator(func):
        return traceable(
            name=name or func.__name__,
            run_type=run_type,
            metadata=metadata or {},
        )(func)
    return decorator


# Example usage:
# @trace_agent_call(name="process_user_message", run_type="chain")
# async def process_message(state: AgentState) -> dict:
#     ...
```

### LangGraph Integration

```python
"""LangSmith tracing for LangGraph agents."""
from langgraph.graph import StateGraph
from langsmith import traceable


def create_traced_graph(graph: StateGraph, project_name: str):
    """Compile graph with LangSmith tracing enabled."""
    import os

    # Enable tracing
    os.environ["LANGCHAIN_TRACING_V2"] = "true"
    os.environ["LANGCHAIN_PROJECT"] = project_name

    # Compile with checkpointer for state persistence
    return graph.compile()


# Node-level tracing
@traceable(run_type="tool")
async def traced_tool_call(tool_name: str, tool_input: dict) -> dict:
    """Execute a tool call with tracing."""
    # Tool execution logic
    pass
```

---

## Step 4: Add Prometheus Metrics

### Python: `src/utils/metrics.py`

```python
"""Prometheus metrics for AI agent monitoring."""
from prometheus_client import (
    Counter,
    Histogram,
    Gauge,
    Info,
    CollectorRegistry,
    generate_latest,
    CONTENT_TYPE_LATEST,
)

# Create a custom registry
REGISTRY = CollectorRegistry()

# ==========================================
# REQUEST METRICS
# ==========================================

REQUESTS_TOTAL = Counter(
    "agent_requests_total",
    "Total number of agent requests",
    ["status", "intent", "model"],
    registry=REGISTRY,
)

REQUEST_LATENCY = Histogram(
    "agent_request_latency_seconds",
    "Request latency in seconds",
    ["intent", "model"],
    buckets=[0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0, 60.0],
    registry=REGISTRY,
)

ACTIVE_REQUESTS = Gauge(
    "agent_active_requests",
    "Number of currently active requests",
    registry=REGISTRY,
)

# ==========================================
# TOKEN METRICS
# ==========================================

TOKENS_USED = Counter(
    "agent_tokens_total",
    "Total tokens used",
    ["type", "model"],  # type: input/output
    registry=REGISTRY,
)

TOKEN_COST_USD = Counter(
    "agent_token_cost_usd_total",
    "Estimated token cost in USD",
    ["model"],
    registry=REGISTRY,
)

# ==========================================
# TOOL METRICS
# ==========================================

TOOL_CALLS_TOTAL = Counter(
    "agent_tool_calls_total",
    "Total tool calls",
    ["tool_name", "status"],  # status: success/failure
    registry=REGISTRY,
)

TOOL_LATENCY = Histogram(
    "agent_tool_latency_seconds",
    "Tool execution latency",
    ["tool_name"],
    buckets=[0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0],
    registry=REGISTRY,
)

# ==========================================
# ERROR METRICS
# ==========================================

ERRORS_TOTAL = Counter(
    "agent_errors_total",
    "Total errors",
    ["error_type", "recoverable"],
    registry=REGISTRY,
)

# ==========================================
# QUALITY METRICS
# ==========================================

QUALITY_SCORE = Gauge(
    "agent_quality_score",
    "Latest quality evaluation score",
    ["metric"],  # metric: accuracy/relevance/safety
    registry=REGISTRY,
)

# ==========================================
# SYSTEM INFO
# ==========================================

AGENT_INFO = Info(
    "agent",
    "Agent information",
    registry=REGISTRY,
)


def set_agent_info(version: str, model: str, environment: str) -> None:
    """Set agent information metrics."""
    AGENT_INFO.info({
        "version": version,
        "model": model,
        "environment": environment,
    })


def get_metrics() -> tuple[bytes, str]:
    """Get metrics in Prometheus format."""
    return generate_latest(REGISTRY), CONTENT_TYPE_LATEST


# ==========================================
# HELPER DECORATORS
# ==========================================

import functools
import time
from typing import Callable, TypeVar, ParamSpec

P = ParamSpec("P")
R = TypeVar("R")


def track_request(intent: str, model: str) -> Callable[[Callable[P, R]], Callable[P, R]]:
    """Decorator to track request metrics."""
    def decorator(func: Callable[P, R]) -> Callable[P, R]:
        @functools.wraps(func)
        async def wrapper(*args: P.args, **kwargs: P.kwargs) -> R:
            ACTIVE_REQUESTS.inc()
            start_time = time.time()
            status = "success"

            try:
                result = await func(*args, **kwargs)
                return result
            except Exception as e:
                status = "error"
                ERRORS_TOTAL.labels(
                    error_type=type(e).__name__,
                    recoverable="true"
                ).inc()
                raise
            finally:
                ACTIVE_REQUESTS.dec()
                duration = time.time() - start_time
                REQUEST_LATENCY.labels(intent=intent, model=model).observe(duration)
                REQUESTS_TOTAL.labels(status=status, intent=intent, model=model).inc()

        return wrapper
    return decorator
```

---

## Step 5: Create Metrics Endpoint

### Python: Add to `src/main.py`

```python
"""FastAPI application with metrics endpoint."""
from fastapi import FastAPI, Response
from src.utils.metrics import get_metrics, set_agent_info
from src.config.settings import get_settings

app = FastAPI()
settings = get_settings()

# Set agent info on startup
@app.on_event("startup")
async def startup():
    set_agent_info(
        version="1.0.0",
        model="claude-sonnet-4-20250514",
        environment=settings.environment,
    )


@app.get("/metrics")
async def metrics():
    """Prometheus metrics endpoint."""
    content, content_type = get_metrics()
    return Response(content=content, media_type=content_type)


@app.get("/health")
async def health():
    """Health check endpoint."""
    return {
        "status": "healthy",
        "environment": settings.environment,
    }
```

---

## Step 6: Create OpenTelemetry Tracing

### Python: `src/utils/tracing.py`

```python
"""OpenTelemetry distributed tracing configuration."""
import os
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.resources import Resource, SERVICE_NAME
from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentation


def configure_tracing(
    service_name: str,
    environment: str,
    otlp_endpoint: str | None = None,
) -> None:
    """Configure OpenTelemetry tracing."""

    # Create resource with service info
    resource = Resource.create({
        SERVICE_NAME: service_name,
        "deployment.environment": environment,
    })

    # Create tracer provider
    provider = TracerProvider(resource=resource)

    # Add OTLP exporter if endpoint provided
    if otlp_endpoint:
        exporter = OTLPSpanExporter(endpoint=otlp_endpoint)
        provider.add_span_processor(BatchSpanProcessor(exporter))

    # Set global tracer provider
    trace.set_tracer_provider(provider)

    # Instrument HTTP clients
    HTTPXClientInstrumentation().instrument()


def get_tracer(name: str) -> trace.Tracer:
    """Get a tracer instance."""
    return trace.get_tracer(name)


# Context manager for spans
from contextlib import contextmanager
from typing import Generator, Any


@contextmanager
def trace_span(
    name: str,
    attributes: dict[str, Any] | None = None,
) -> Generator[trace.Span, None, None]:
    """Create a traced span."""
    tracer = get_tracer(__name__)
    with tracer.start_as_current_span(name, attributes=attributes or {}) as span:
        yield span


# Usage:
# with trace_span("process_message", {"user_id": "123"}) as span:
#     span.set_attribute("intent", "search")
#     result = await process()
```

---

## Step 7: Create Grafana Dashboard

Create `observability/grafana/dashboards/agent-dashboard.json`:

```json
{
  "dashboard": {
    "title": "AI Agent Dashboard",
    "uid": "agent-main",
    "panels": [
      {
        "title": "Request Rate",
        "type": "timeseries",
        "gridPos": {"x": 0, "y": 0, "w": 12, "h": 8},
        "targets": [
          {
            "expr": "rate(agent_requests_total[5m])",
            "legendFormat": "{{status}} - {{intent}}"
          }
        ]
      },
      {
        "title": "Request Latency (P95)",
        "type": "timeseries",
        "gridPos": {"x": 12, "y": 0, "w": 12, "h": 8},
        "targets": [
          {
            "expr": "histogram_quantile(0.95, rate(agent_request_latency_seconds_bucket[5m]))",
            "legendFormat": "P95 Latency"
          }
        ]
      },
      {
        "title": "Token Usage",
        "type": "stat",
        "gridPos": {"x": 0, "y": 8, "w": 6, "h": 4},
        "targets": [
          {
            "expr": "sum(increase(agent_tokens_total[24h]))",
            "legendFormat": "24h Tokens"
          }
        ]
      },
      {
        "title": "Estimated Cost (24h)",
        "type": "stat",
        "gridPos": {"x": 6, "y": 8, "w": 6, "h": 4},
        "targets": [
          {
            "expr": "sum(increase(agent_token_cost_usd_total[24h]))",
            "legendFormat": "24h Cost"
          }
        ]
      },
      {
        "title": "Error Rate",
        "type": "timeseries",
        "gridPos": {"x": 12, "y": 8, "w": 12, "h": 4},
        "targets": [
          {
            "expr": "rate(agent_errors_total[5m])",
            "legendFormat": "{{error_type}}"
          }
        ]
      },
      {
        "title": "Tool Call Success Rate",
        "type": "gauge",
        "gridPos": {"x": 0, "y": 12, "w": 8, "h": 6},
        "targets": [
          {
            "expr": "sum(rate(agent_tool_calls_total{status=\"success\"}[5m])) / sum(rate(agent_tool_calls_total[5m])) * 100",
            "legendFormat": "Success %"
          }
        ]
      },
      {
        "title": "Quality Scores",
        "type": "gauge",
        "gridPos": {"x": 8, "y": 12, "w": 8, "h": 6},
        "targets": [
          {
            "expr": "agent_quality_score",
            "legendFormat": "{{metric}}"
          }
        ]
      }
    ]
  }
}
```

---

## Step 8: Create Alert Rules

Create `observability/prometheus/alerts.yml`:

```yaml
groups:
  - name: agent-alerts
    rules:
      # High Error Rate
      - alert: AgentHighErrorRate
        expr: |
          (
            sum(rate(agent_errors_total[5m]))
            /
            sum(rate(agent_requests_total[5m]))
          ) > 0.05
        for: 2m
        labels:
          severity: warning
        annotations:
          summary: "Agent error rate above 5%"
          description: "Error rate is {{ $value | humanizePercentage }} over the last 5 minutes"

      # High Latency
      - alert: AgentHighLatency
        expr: |
          histogram_quantile(0.95, rate(agent_request_latency_seconds_bucket[5m])) > 10
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Agent P95 latency above 10 seconds"
          description: "P95 latency is {{ $value | humanizeDuration }}"

      # Quality Degradation
      - alert: AgentQualityDegradation
        expr: agent_quality_score{metric="accuracy"} < 0.8
        for: 1h
        labels:
          severity: critical
        annotations:
          summary: "Agent accuracy dropped below 80%"
          description: "Accuracy score is {{ $value }}"

      # High Token Usage
      - alert: AgentHighTokenUsage
        expr: |
          sum(increase(agent_token_cost_usd_total[1h])) > 10
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Agent token cost exceeding $10/hour"
          description: "Hourly cost is ${{ $value | humanize }}"

      # Tool Failures
      - alert: AgentToolFailures
        expr: |
          (
            sum(rate(agent_tool_calls_total{status="failure"}[5m]))
            /
            sum(rate(agent_tool_calls_total[5m]))
          ) > 0.1
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Tool failure rate above 10%"
          description: "Tool failure rate is {{ $value | humanizePercentage }}"
```

---

## Step 9: Create Docker Compose for Observability Stack

Create `observability/docker-compose.yml`:

```yaml
version: '3.8'

services:
  prometheus:
    image: prom/prometheus:v2.48.0
    volumes:
      - ./prometheus/prometheus.yml:/etc/prometheus/prometheus.yml
      - ./prometheus/alerts.yml:/etc/prometheus/alerts.yml
      - prometheus-data:/prometheus
    command:
      - '--config.file=/etc/prometheus/prometheus.yml'
      - '--storage.tsdb.path=/prometheus'
      - '--web.enable-lifecycle'
    ports:
      - "9090:9090"
    networks:
      - observability

  grafana:
    image: grafana/grafana:10.2.0
    volumes:
      - ./grafana/provisioning:/etc/grafana/provisioning
      - ./grafana/dashboards:/var/lib/grafana/dashboards
      - grafana-data:/var/lib/grafana
    environment:
      - GF_SECURITY_ADMIN_PASSWORD=${GRAFANA_PASSWORD:-admin}
      - GF_USERS_ALLOW_SIGN_UP=false
    ports:
      - "3000:3000"
    networks:
      - observability

  jaeger:
    image: jaegertracing/all-in-one:1.52
    environment:
      - COLLECTOR_OTLP_ENABLED=true
    ports:
      - "16686:16686"  # Jaeger UI
      - "4318:4318"    # OTLP HTTP
    networks:
      - observability

volumes:
  prometheus-data:
  grafana-data:

networks:
  observability:
    driver: bridge
```

---

## Step 10: Commit Observability Configuration

```bash
git add src/utils/ observability/
git commit -m "Add comprehensive observability stack

- Structured logging with structlog/pino
- LangSmith integration for LLM tracing
- Prometheus metrics (requests, tokens, tools, errors)
- OpenTelemetry distributed tracing
- Grafana dashboards
- Alert rules for errors, latency, quality
- Docker Compose for observability stack

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"

git push
```

---

## Output

After completion, provide user with:

1. **Observability endpoints**:
   ```
   /metrics    - Prometheus metrics
   /health     - Health check
   ```

2. **Dashboard URLs** (local):
   ```
   Grafana:     http://localhost:3000
   Prometheus:  http://localhost:9090
   Jaeger:      http://localhost:16686
   LangSmith:   https://smith.langchain.com
   ```

3. **Quick start**:
   ```bash
   # Start observability stack
   cd observability && docker compose up -d

   # View logs with tracing
   LANGCHAIN_TRACING_V2=true make dev
   ```

4. **Next steps**:
   - Configure LangSmith API key
   - Set up Slack/PagerDuty alerts
   - Create custom dashboards for your use case
   - Set quality score thresholds based on evals

