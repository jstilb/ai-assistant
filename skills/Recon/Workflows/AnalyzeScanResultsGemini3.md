# Analyze Scan Results with Gemini 3 Pro

**Deep multi-step reasoning analysis of large-scale security scan results**

## Purpose

Analyze complex security scan outputs (nmap, masscan, httpx, naabu) using Gemini 3 Pro's advanced reasoning capabilities to:
- Identify high-value targets and attack paths
- Detect unusual patterns and anomalies across massive datasets
- Correlate findings across multiple scan types
- Prioritize vulnerabilities by exploitability and impact
- Generate actionable penetration testing recommendations

**Why Gemini 3 Pro:**
- **Deep Reasoning:** Multi-step logical inference connects patterns across scan data
- **1M Context Window:** Process massive nmap/masscan outputs without truncation
- **Mathematical Analysis:** Statistical anomaly detection and correlation
- **Pattern Recognition:** Identifies clusters, outliers, and relationships in complex datasets

## When to Use

**Ideal scenarios:**
- Analyzing scans of 100+ hosts (massive output)
- Correlating multiple scan tool outputs (nmap + masscan + httpx + naabu)
- Complex enterprise network mapping
- Large-scale attack surface analysis
- Continuous security monitoring trend analysis
- Pre-pentest planning and target prioritization

**Input types:**
- nmap XML/text output (single or multiple scans)
- masscan JSON/list output
- httpx results (web service enumeration)
- naabu port scan results
- Combined multi-tool scan archives
- Historical scan comparisons

## Gemini 3 Pro Advantages

### Deep Multi-Step Reasoning
```
Traditional analysis: "Port 445 open on host X"
Gemini 3 deep reasoning:
  1. Port 445 (SMB) open across 47 hosts in 10.0.0.0/16
  2. 12 hosts running SMBv1 (vulnerable to EternalBlue)
  3. Those 12 hosts also have port 135 (RPC) exposed
  4. 8 of those hosts are domain controllers (via port 389/636)
  5. Pattern suggests unpatched Windows infrastructure
  6. High-priority target cluster for lateral movement
```

### Pattern Detection Across Large Datasets
- Identify service version clusters (outdated vs current)
- Detect network segmentation issues
- Find misconfigurations at scale
- Correlate open ports with service banners
- Map trust relationships and attack paths

### Statistical Anomaly Detection
- Unusual port combinations
- Services on non-standard ports
- Hosts with significantly different fingerprints
- Outlier detection in response patterns

## Authorization Disclaimer

**⚠️ CRITICAL: AUTHORIZED USE ONLY**

This workflow analyzes scan results from authorized security testing:
- Penetration testing engagements (written SOW/contract)
- Bug bounty programs (in-scope targets only)
- Owned infrastructure and assets
- Security research lab environments

**DO NOT use for:**
- Unauthorized scanning or reconnaissance
- Malicious hacking or exploitation
- Analyzing scans of systems without permission
- Criminal activities

The analysis provided is for DEFENSIVE security improvement and AUTHORIZED offensive testing only.

## Workflow Steps

### Step 1: Scan Data Ingestion

**Collect scan outputs:**
```bash
# Get current work directory
WORK_DIR=$(jq -r '.work_dir' ~/.claude/MEMORY/STATE/current-work.json)

# Example: Recent nmap scan
SCAN_FILE=~/.claude/MEMORY/WORK/${WORK_DIR}/scratch/$(date +%Y-%m-%d)_nmap-scan.txt

# Or masscan results
MASSCAN_FILE=~/.claude/MEMORY/WORK/${WORK_DIR}/scratch/$(date +%Y-%m-%d)_masscan.json

# Or combined multi-tool archive from history
SCAN_DIR=~/.claude/History/security/scans/2025-11-target-recon/
```

**Load scan data:**
```bash
# Read scan output (will be passed to Gemini 3)
cat $SCAN_FILE
```

### Step 2: Data Normalization

**Parse into structured format:**
```typescript
// For nmap XML - parse manually or use a library
// nmap XML can be parsed with standard XML parsing (DOMParser or xml2js)
const nmapXml = await Bun.file(scanFile).text();

// For masscan JSON
const masscanData = JSON.parse(await Bun.file(masscanFile).text());

// Normalize to common format
interface ScanResult {
  host: string;
  ports: Array<{
    port: number;
    protocol: 'tcp' | 'udp';
    state: 'open' | 'closed' | 'filtered';
    service: string;
    version: string;
    banner?: string;
  }>;
  os?: string;
  hostname?: string;
}
```

**Example normalization script:**
```typescript
// tools/normalize-scan.ts
export function normalizeScans(nmapData: any, masscanData: any): ScanResult[] {
  const hosts = new Map<string, ScanResult>();

  // Merge nmap results
  for (const host of nmapData.hosts) {
    hosts.set(host.ip, {
      host: host.ip,
      ports: host.ports || [],
      os: host.os,
      hostname: host.hostname
    });
  }

  // Merge masscan results
  for (const result of masscanData) {
    const existing = hosts.get(result.ip) || { host: result.ip, ports: [] };
    existing.ports.push({
      port: result.ports[0].port,
      protocol: result.ports[0].proto,
      state: 'open',
      service: result.ports[0].service || 'unknown',
      version: ''
    });
    hosts.set(result.ip, existing);
  }

  return Array.from(hosts.values());
}
```

### Step 3: Gemini 3 Pro Deep Analysis

**Primary analysis prompt:**
```bash
llm -m gemini-3-pro-preview "You are an expert penetration tester analyzing security scan results.

Apply deep multi-step reasoning to analyze these scan results and provide:

1. **High-Value Targets** - Rank hosts by attack surface and exploitability
   - Identify critical services (RDP, SSH, SMB, database ports)
   - Detect outdated/vulnerable service versions
   - Assess exposure level and accessibility

2. **Pattern Analysis** - Identify clusters and relationships
   - Service version consistency/inconsistency
   - Network segmentation patterns
   - Trust relationship indicators
   - Technology stack groupings

3. **Anomaly Detection** - Find unusual or suspicious patterns
   - Services on non-standard ports
   - Unexpected service combinations
   - Outlier hosts with unique configurations
   - Potential honeypots or deception systems

4. **Vulnerability Assessment** - Prioritize by exploitability
   - Known CVEs for detected service versions
   - Default credentials likelihood
   - Misconfigurations and security weaknesses
   - Authentication bypass opportunities

5. **Attack Path Mapping** - Recommended penetration testing strategy
   - Initial access vectors (external-facing services)
   - Lateral movement opportunities (internal services)
   - Privilege escalation candidates
   - Domain compromise pathways
   - Recommended exploitation sequence

6. **Risk Prioritization** - Severity scoring and remediation priority
   - Critical findings (immediate attention)
   - High-risk findings (short-term fixes)
   - Medium-risk findings (planned remediation)
   - Low-risk findings (informational)

Use your deep reasoning capability to connect patterns across the entire dataset. Think step-by-step through the logical implications of each finding.

## Scan Results

\`\`\`
$(cat $SCAN_FILE)
\`\`\`

Provide a comprehensive analysis report in markdown format."
```

**For correlation across multiple scan types:**
```bash
llm -m gemini-3-pro-preview "Analyze and correlate these multiple security scan results:

## Nmap Scan Results
\`\`\`
$(cat nmap-scan.txt)
\`\`\`

## Masscan Results
\`\`\`
$(cat masscan.json)
\`\`\`

## HTTPx Web Service Enumeration
\`\`\`
$(cat httpx-results.txt)
\`\`\`

## Naabu Port Scan
\`\`\`
$(cat naabu-ports.txt)
\`\`\`

Correlate findings across all scans:
1. Identify discrepancies between scan tools
2. Build comprehensive service inventory
3. Detect scan evasion or filtering
4. Map complete attack surface
5. Prioritize web applications for assessment

Provide deep multi-step reasoning analysis with actionable recommendations."
```

### Step 4: Pattern Detection Enhancement

**Service clustering analysis:**
```bash
llm -m gemini-3-pro-preview "Perform statistical analysis on these scan results:

1. **Service Version Clustering**
   - Group hosts by service versions
   - Identify outdated/vulnerable version clusters
   - Detect patch management patterns

2. **Port Pattern Analysis**
   - Find unusual port combinations
   - Detect firewall rule patterns
   - Identify service migration indicators

3. **Geographic/Subnet Clustering**
   - Analyze patterns by IP range
   - Detect segmentation boundaries
   - Map network architecture

4. **Temporal Analysis** (if multiple scans)
   - Track service changes over time
   - Detect new services/hosts
   - Identify infrastructure changes

## Data
$(cat scan-results.json)

Provide statistical insights with supporting evidence."
```

### Step 5: Risk Prioritization

**Severity scoring prompt:**
```bash
llm -m gemini-3-pro-preview "Prioritize findings from this scan analysis by risk:

## Scoring Criteria
- **CRITICAL:** Remote code execution, default credentials on critical services
- **HIGH:** Authentication bypass, known exploits, sensitive data exposure
- **MEDIUM:** Information disclosure, misconfigurations
- **LOW:** Informational findings, hardening recommendations

## Analysis
$(cat gemini-analysis.md)

Provide:
1. Prioritized findings list with severity scores
2. CVSS scores where applicable
3. Exploitability assessment (trivial/easy/moderate/hard)
4. Business impact analysis
5. Recommended remediation order

Format as markdown table with risk matrix."
```

### Step 6: Recommendation Generation

**Actionable pentesting plan:**
```bash
llm -m gemini-3-pro-preview "Generate a penetration testing execution plan based on this analysis:

## Scan Analysis
$(cat gemini-analysis.md)

Provide:
1. **Phase 1: Initial Access** - Best entry point vectors
2. **Phase 2: Discovery** - Post-compromise enumeration targets
3. **Phase 3: Lateral Movement** - Pivoting opportunities
4. **Phase 4: Privilege Escalation** - Elevation pathways
5. **Phase 5: Domain Compromise** - Critical infrastructure targets

For each phase:
- Specific targets (IPs, services, ports)
- Recommended tools and techniques
- Expected outcomes
- Success criteria

Format as actionable penetration testing playbook."
```

## Output Report Structure

The Gemini 3 Pro analysis should produce a report with these sections:

```markdown
# Gemini 3 Pro Scan Analysis Report

**Date:** YYYY-MM-DD
**Scan Type:** [nmap | masscan | httpx | combined]
**Hosts Analyzed:** N
**Authorization:** [SOW reference or bug bounty program]

## Executive Summary
- Critical/High/Medium/Low finding counts
- Top risk identified
- Recommended immediate action

## 1. High-Value Target Analysis
- Critical target clusters ranked by risk score
- Pattern analysis per cluster (service versions, exposed ports)
- Exploitability and business impact assessment
- Recommended attack paths per cluster

## 2. Vulnerability Assessment
- CVE table: Host | Service | Version | CVE | Severity | Exploitability
- Default credential candidates
- Misconfigurations detected

## 3. Attack Path Mapping (5 Phases)
- Phase 1: Initial Access (external entry points)
- Phase 2: Post-Compromise Enumeration
- Phase 3: Lateral Movement
- Phase 4: Privilege Escalation
- Phase 5: Domain/Infrastructure Compromise

## 4. Network Architecture Insights
- Subnet segmentation analysis
- Trust relationship mapping
- Segmentation flaws identified

## 5. Anomaly Detection
- Statistical outlier hosts
- Service version inconsistencies
- Suspicious port profiles

## 6. Risk Prioritization Matrix
- Critical | High | Medium | Low tables with CVSS scores

## 7. Remediation Recommendations
- Priority 1: Immediate (Week 1)
- Priority 2: Short-term (Week 2-3)
- Priority 3: Architecture (Month 2-3)
```

## Integration with Existing Workflows

```bash
# Step 1: Run reconnaissance (domain, netblock, or IP)
# Uses existing recon workflows

# Step 2: Generate comprehensive scan with nmap
nmap -sS -sV -O -A -p- target-range -oN nmap-full.txt

# Step 3: Analyze with Gemini 3 Pro
llm -m gemini-3-pro-preview "Analyze these scan results with deep reasoning:
$(cat nmap-full.txt)"
```

## Success Criteria

**Minimum viable analysis:**
- Scan data successfully loaded (no truncation)
- Gemini 3 Pro deep reasoning applied
- High-value targets identified
- Attack path recommendations provided
- Report generated in markdown format

**Comprehensive analysis:**
- Multi-step logical reasoning evident
- Pattern detection across entire dataset
- Statistical anomaly detection performed
- Vulnerability correlation with CVEs
- Risk prioritization matrix created
- Actionable penetration testing plan
- Remediation recommendations by priority

## Troubleshooting

**Gemini 3 Pro not available:**
```bash
llm models list | grep gemini
# Fallback: llm -m claude-sonnet-4.5 --think "Analyze these scan results..."
```

**Scan output too large:**
```bash
# Summarize first, then deep-analyze
llm -m gemini-3-pro-preview "Summarize key findings: $(cat huge-scan.txt)" > summary.txt
llm -m gemini-3-pro-preview "Deep analysis: $(cat summary.txt)"
```

## Related Workflows

- `PassiveRecon.md` - Initial passive reconnaissance
- `DomainRecon.md` - Domain infrastructure mapping
- `IpRecon.md` - IP address investigation
- `NetblockRecon.md` - Network range scanning

**Typical Flow:**
1. passive-recon -> identify targets
2. domain/ip/netblock-recon -> active scanning
3. **analyze-scan-results-gemini-3** -> deep analysis and attack planning

---

**Remember:** This workflow is for AUTHORIZED security testing only.
