
**Paper**: *A Comparative Analysis of Third-Party Script Behaviour in Consent-Based and Implicit Web Tracking* (CODASPY 2026)

## Overview

This repository implements an automated browser-based measurement pipeline to compare how third-party scripts behave across two tracking paradigms:

- **Consent-Based Tracking (CBT)**: Sites with explicit consent interfaces (cookie banners)
- **Implicit Tracking**: Sites that load tracking scripts by default without user consent

The pipeline instruments Chromium to collect network traces, script dependencies, and execution events during controlled visits, enabling systematic comparison of script loading patterns, timing, dependency structure, and runtime behavior.

## Pipeline Architecture
```
Input: Tranco domains
         ↓
[1] DNS filtering & HTTP reachability check
         ↓
[2] Banner detection & paradigm classification  
         ↓
[3] Instrumented visits (Accept/Reject/Baseline scenarios)
         ↓
[4] Metric computation (S/T/D/E metrics)
         ↓
[5] Aggregate by paradigm & window
         ↓
[6] Statistical analysis & visualization
```

## Requirements

- **Node.js** >= 18.0
- **Python** >= 3.9 (for analysis)
- **RAM**: 16GB+ recommended
- **Disk**: 50GB+ for traces

### Dependencies
```bash
# Node.js
npm install puppeteer axios

# Python  
pip install pandas numpy scipy matplotlib seaborn
```

## Quick Start

### 1. Filter Reachable Sites
```bash
node 01_dns_filter.js \
  --input=tranco_top100k.csv \
  --limit=10000 \
  --httpConcurrency=25
```

**Output**: `output/valid_sites.csv`

### 2. Detect Consent Banners
```bash
node 02_detect_banner.js \
  --input=./output/valid_sites.csv \
  --concurrency=12
```

**Output**: `output/simple_results.csv` (CBT vs. implicit labels)

### 3. Measure Script Behavior
```bash
node 03_track_behavior_production.js \
  --input=./output/valid_sites.csv \
  --concurrency=8 \
  --preWindow=5000 \
  --postWindow=30000
```

**Output**: `traces/*.json` (per-site trace files)

### 4. Compute Metrics
```bash
node 04_reaggregate.js \
  --tracesDir=./traces
```

**Metrics**: S (scale), T (timing), D (dependency), E (execution)

### 5. Aggregate & Analyze
```bash
node 05_analysis.js \
  --inputCBTPre=./output/reaggregated/cbt_pre_aggregated.json \
  --inputCBTReject=./output/reaggregated/cbt_reject_aggregated.json \
  --inputIT=./output/reaggregated/it_aggregated.json \
  --output=./output/analysis_results

node 06_export_figures_enhanced_fixed_v2.js \
  --input=./output/aggregated_metrics.csv
```

## Key Features

**Robust Filtering**
- DNS resolution with automatic `www` fallback
- HTTP reachability checks (HTTPS/HTTP + HEAD/GET fallback chain)
- Retry mechanism for timeout sites

**Multilingual Banner Detection**
- Keyword matching across 5 languages (EN/ZH/DE/FR/ES)
- TCF API detection
- CMP selector matching (OneTrust, Cookiebot, etc.)

**Controlled Measurement**
- Three scenarios: CBT-Accept, CBT-Reject, Implicit-Baseline
- Fixed time windows: pre-interaction (0-5s), post-interaction (30s)
- Lightweight preflight to optimize navigation

**Comprehensive Instrumentation**
- Network: script requests, initiators, response codes
- Execution: dynamic code generation (`eval`), runtime errors
- Dependency: script-to-script loading relationships

## Configuration

### Common Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `--concurrency` | 8-25 | Concurrent browser/HTTP sessions |
| `--preWindow` | 5000 | Pre-interaction window (ms) |
| `--postWindow` | 30000 | Post-interaction window (ms) |
| `--navTimeout` | 15000 | Navigation timeout (ms) |
| `--headless` | `new` | Headless mode |

See individual script headers for complete parameter lists.

## Data Structure

### Trace File Format
```json
{
  "startTime": 1234567890000,
  "preWindowEnd": 1234567895000,
  "interactionTime": 1234567895000,
  "postWindowEnd": 1234567925000,
  "detection": {
    "hasConsent": true,
    "hasTCF": false,
    "contextHit": true,
    "hasAccept": true,
    "hasReject": true
  },
  "network": [...],
  "execution": [...],
  "errors": [...]
}
```

### Computed Metrics

- **S1-S3**: Script count, domain count, total size
- **T1-T3**: Time to first script, time to first tracker, pre/post change
- **D1-D3**: Max depth, avg out-degree, cross-domain ratio
- **E1-E3**: Dynamic execution, deferred execution, error rate


## Reproducibility

Complete pipeline execution:
```bash
# Full pipeline
node 01_dns_filter.js --input=tranco_top100k.csv --limit=10000
node 02_detect_banner.js --input=./output/valid_sites.csv
node 03_track_behavior_production.js --input=./output/valid_sites.csv
node 04_reaggregate.js --tracesDir=./traces
node 05_analysis.js
node 06_export_figures_enhanced_fixed_v2.js
```

### Known Limitations

- **Geographic coverage**: UK-based vantage point; banner visibility varies by jurisdiction
- **Temporal validity**: Snapshot measurement; implementations evolve over time
- **Interaction model**: Idle browsing without scrolling; differs from real user behavior
- **Detection accuracy**: Keyword-based approach may miss or misclassify some banners

## Acknowledgments

Built with Tranco rankings, Puppeteer, and public DNS resolvers.
