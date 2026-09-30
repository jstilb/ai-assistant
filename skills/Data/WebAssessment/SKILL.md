---
name: WebAssessment
description: Web application security testing, vulnerability assessment, and threat modeling. USE WHEN web assessment, pentest, security testing, vulnerability scan, OSINT recon, bug bounty, threat model, nuclei scan, security audit.
---
# WebAssessment Skill

Security assessment infrastructure integrating reconnaissance, threat modeling, and vulnerability testing.

## Workflow Routing

| Trigger | Workflow |
|---------|----------|
| "understand application", "what does this app do", "map the application" | UnderstandApplication |
| "threat model", "attack scenarios", "how would I attack" | CreateThreatModel |
| "pentest", "security assessment", "test for vulnerabilities" | pentest/MasterMethodology |
| "fuzz with ffuf", "directory fuzzing", "content discovery" | ffuf/FfufGuide |
| "OSINT", "reconnaissance", "open source intelligence" | osint/MasterGuide |
| "test web app", "Playwright", "browser automation" | webapp/TestingGuide |
| "bug bounty", "bounty programs" | bug-bounty/Programs |
| "vulnerability analysis with AI", "Gemini analysis" | VulnerabilityAnalysisGemini3 |

## Skill Integration

WebAssessment coordinates with specialized skills:

<!-- Note: The Recon skill is not yet implemented. Use manual alternatives listed below. -->

| Phase | Skill | Purpose |
|-------|-------|---------|
| Scope Definition | **Recon** *(not yet built)* | Corporate structure, domain enumeration |
| Target Discovery | **Recon** *(not yet built)* | Subdomains, endpoints, ports |
| Understanding | **WebAssessment** | App narrative, user flows, sensitive data |
| Threat Modeling | **WebAssessment** | Attack scenarios, test prioritization |
| Injection Testing | **PromptInjection** | LLM-specific attacks |
| Intelligence | **OSINT** | People, companies, social media |

## Assessment Workflow

```
1. Corporate Structure (manual — see Recon Alternatives) → Define scope
2. Subdomain Enumeration (manual — see Recon Alternatives) → Find all domains
3. Endpoint Discovery (manual — see Recon Alternatives) → Extract JS endpoints
4. Understand Application → Build app narrative
5. Create Threat Model → Prioritize attack scenarios
6. Execute Testing → Test against identified threats
7. Report Findings → Document with PoCs
```

## Recon Alternatives

<!-- Known Gap: skills/Recon/ does not exist yet. Use these alternatives. -->

Use these manual commands for reconnaissance until the Recon skill is implemented:

```bash
# Corporate structure for scope — WHOIS + certificate transparency
whois target.com
curl -s "https://crt.sh/?q=%25.target.com&output=json" | jq '.[].name_value' | sort -u

# Subdomain enumeration
subfinder -d target.com -o subdomains.txt
amass enum -d target.com -o amass.txt

# Endpoint discovery from JavaScript
python3 linkfinder.py -i https://target.com -d -o endpoints.txt

# Port scanning
nmap -sV -p 80,443,8080,8443 target.com

# Path discovery
ffuf -u https://target.com/FUZZ -w /usr/share/wordlists/dirb/common.txt
```

## UnderstandApplication Output

Produces structured narrative including:
- **Summary**: Purpose, industry, user base, critical functions
- **User Roles**: Access levels and capabilities
- **User Flows**: Step-by-step processes with sensitive data
- **Technology Stack**: Frontend, backend, auth, third-party
- **Attack Surface**: Entry points, inputs, file uploads, websockets

## CreateThreatModel Output

Generates prioritized attack plan:
- **Threats**: OWASP/CWE mapped with risk scores
- **Attack Paths**: Multi-step attack scenarios
- **Test Plan**: Prioritized with tool suggestions
- **Effort Estimates**: Quick/medium/extensive per threat

## Threat Categories

| Category | Triggers On |
|----------|-------------|
| Authentication | Auth mechanisms detected |
| Access Control | Multiple user roles |
| Injection | All web apps |
| Data Exposure | Sensitive data identified |
| File Upload | Upload functionality |
| API Security | API endpoints |
| WebSocket | WebSocket detected |
| Business Logic | All web apps |
| Payment Security | Payment flows |

## 6-Phase Pentest Methodology

**Phase 0**: Scoping & Preparation
**Phase 1**: Reconnaissance (manual tools — see Recon Alternatives; Recon skill not yet implemented)
**Phase 2**: Mapping (content discovery)
**Phase 3**: Vulnerability Analysis
**Phase 4**: Exploitation
**Phase 5**: Reporting

## Key Principles

1. **Authorization first** - Never test without explicit permission
2. **Understand before testing** - Build app narrative first
3. **Threat model guides testing** - Don't test blindly
4. **Breadth then depth** - Wide recon, focused exploitation
5. **Document everything** - Notes, screenshots, commands

## Workflow Index

**Core Assessment:**
- `Workflows/UnderstandApplication.md` - Application reconnaissance
- `Workflows/CreateThreatModel.md` - Attack scenario generation

**Penetration Testing:**
- `Workflows/pentest/MasterMethodology.md` - 6-phase methodology
- `Workflows/pentest/ToolInventory.md` - Security tools reference
- `Workflows/pentest/Reconnaissance.md` - Asset discovery
- `Workflows/pentest/Exploitation.md` - Vulnerability testing

**Web Fuzzing:**
- `Workflows/ffuf/FfufGuide.md` - FFUF fuzzing guide
- `Workflows/ffuf/FfufHelper.md` - Automated fuzzing helper

**Bug Bounty:**
- `Workflows/bug-bounty/Programs.md` - Program tracking

**Web App Testing:**
- `Workflows/webapp/TestingGuide.md` - Playwright testing
- `Workflows/webapp/Examples.md` - Testing patterns

**OSINT:**
- `Workflows/osint/MasterGuide.md` - OSINT methodology
- `Workflows/osint/Reconnaissance.md` - Domain recon
- `Workflows/osint/SocialMediaIntel.md` - SOCMINT
- `Workflows/osint/Automation.md` - SpiderFoot/Maltego
- `Workflows/osint/MetadataAnalysis.md` - ExifTool analysis

**AI-Powered:**
- `Workflows/VulnerabilityAnalysisGemini3.md` - Gemini deep analysis

## Examples

**Example 1: Full assessment workflow**
```
User: "Security assessment on app.example.com"
→ Run UnderstandApplication to build narrative
→ Run CreateThreatModel to prioritize testing
→ Follow MasterMethodology with threat model guidance
→ Report findings with OWASP/CWE references
```

**Example 2: Quick threat model**
```
User: "How would I attack this app?"
→ Run CreateThreatModel on target
→ Get prioritized attack paths
→ Get test plan with tool suggestions
```

**Example 3: Integrate with Recon (manual until Recon skill exists)**
```
User: "Assessment on target.com including all subdomains"
→ whois + crt.sh (manual) → Find parent/child companies
→ subfinder/amass (manual) → Find all subdomains
→ LinkFinder (manual) → Extract JS endpoints
→ UnderstandApplication → Build app narrative
→ CreateThreatModel → Generate attack plan
```

## Known Gaps

1. **Recon skill not implemented** — Multiple workflows reference `skills/Recon/Tools/*` (CorporateStructure.ts, SubdomainEnum.ts, EndpointDiscovery.ts, PortScan.ts, PathDiscovery.ts). These scripts do not exist. Use the manual alternatives documented in the **Recon Alternatives** section above until the Recon skill is built.

2. **External tool availability** — Workflows reference `nuclei`, `ffuf`, `nmap`, `subfinder`, and `amass`. Run `bun ~/.claude/skills/Data/WebAssessment/Tools/PreflightCheck.ts` to verify tool availability before starting an assessment.
