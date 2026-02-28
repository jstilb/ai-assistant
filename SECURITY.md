# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| latest (main branch) | Yes |
| older commits | No — please update to main |

## Reporting a Vulnerability

**This is a personal open-source project.** If you discover a security vulnerability in Kaya / ai-assistant, please follow responsible disclosure:

### How to Report

**Preferred method: GitHub Security Advisories**

Use GitHub's private vulnerability reporting to disclose security issues confidentially:

1. Go to [https://github.com/jstilb/ai-assistant/security/advisories/new](https://github.com/jstilb/ai-assistant/security/advisories/new)
2. Fill in the advisory form with details of the vulnerability
3. Submit — this creates a private advisory visible only to the maintainer

**Alternative method: Email**

If you prefer email contact, send details to the address listed in the GitHub profile: [https://github.com/jstilb](https://github.com/jstilb)

### What to Include

A useful vulnerability report includes:

- **Description**: What the vulnerability is and what it could allow an attacker to do
- **Steps to reproduce**: Minimal steps to demonstrate the issue
- **Impact assessment**: What data or systems are at risk, and under what conditions
- **Suggested fix** (optional): If you have a proposed mitigation

### Response Timeline

This is a personal project maintained by one person. Response times:

| Severity | Expected Initial Response | Expected Fix Timeline |
|----------|--------------------------|----------------------|
| Critical | Within 48 hours | Within 7 days |
| High | Within 7 days | Within 30 days |
| Medium/Low | Within 14 days | Best effort |

### What Happens After You Report

1. The maintainer acknowledges receipt and assesses severity
2. A private advisory is created (or already exists from your submission)
3. A fix is developed and tested
4. The fix is merged to main
5. A public advisory is published after the fix is deployed
6. Credit is given to the reporter in the advisory (unless anonymity is requested)

## Scope

**In scope for vulnerability reports:**

- Prompt injection vulnerabilities in the hook pipeline (PromptInjectionDefender, SecurityValidator)
- Secret exposure via logging, error messages, or unintended file access
- Permission model bypass — operations that should be blocked but aren't
- Security configuration issues that weaken the defense posture
- Vulnerabilities in skill code that could be exploited via the hook system

**Out of scope:**

- Vulnerabilities in Claude Code itself (report to Anthropic)
- Vulnerabilities in Bun runtime (report to Bun team)
- Social engineering attacks against the user
- Issues that require physical access to the machine
- The fact that this is a personal AI system with broad system access (this is by design)

## Security Architecture

For a complete description of the security architecture, threat model, and defense layers, see:

- [`docs/SECURITY.md`](docs/SECURITY.md) — Full security architecture documentation
- [`docs/HOOK-PIPELINE.md`](docs/HOOK-PIPELINE.md) — Hook pipeline internals including PromptInjectionDefender design

## Acknowledgments

Responsible disclosure is appreciated. Contributors who discover and responsibly report security vulnerabilities will be acknowledged in the advisory and in the project's release notes.
