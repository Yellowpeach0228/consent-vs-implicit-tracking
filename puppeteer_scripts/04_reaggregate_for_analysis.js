/**
 * =============================================================================
 * 04_reaggregate_for_analysis.js 
 */

const fs = require('fs');
const path = require('path');

// ============================================================================
// Command Line Argument Parsing
// ============================================================================
function parseArgv() {
  const args = process.argv.slice(2);
  const out = {};
  for (const a of args) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  
  const str = (k, d) => (k in out ? String(out[k]) : d);
  
  return {
    inputDir: str('inputDir', './output/behavior_data'),
    outputDir: str('outputDir', './output/reaggregated'),
    outputCBTPre: str('outputCBTPre', './output/reaggregated/cbt_pre_aggregated.json'),
    outputCBTReject: str('outputCBTReject', './output/reaggregated/cbt_reject_aggregated.json'),
    outputIT: str('outputIT', './output/reaggregated/it_aggregated.json')
  };
}

const argv = parseArgv();

// ============================================================================
// Utility Functions
// ============================================================================

function getAdAnalyticsCount(phaseData) {
  if (!phaseData?.requests?.domainsByCategory) return 0;
  return [
    ...(phaseData.requests.domainsByCategory.advertising ?? []),
    ...(phaseData.requests.domainsByCategory.analytics ?? [])
  ].length;
}

function computeT3Metrics(preData, postData) {
  if (!preData || !postData) return null;
  
  const preScripts = preData.requests?.thirdParty ?? 0;
  const postScripts = postData.requests?.thirdParty ?? 0;
  const preDomains = preData.requests?.uniqueDomains ?? 0;
  const postDomains = postData.requests?.uniqueDomains ?? 0;
  const preSize = preData.requests?.totalSize ?? 0;
  const postSize = postData.requests?.totalSize ?? 0;
  
  return {
    scripts_absolute: postScripts - preScripts,
    scripts_relative: preScripts > 0 ? (postScripts - preScripts) / preScripts : 0,
    
    domains_absolute: postDomains - preDomains,
    domains_relative: preDomains > 0 ? (postDomains - preDomains) / preDomains : 0,
    
    size_absolute: postSize - preSize,
    size_relative: preSize > 0 ? (postSize - preSize) / preSize : 0
  };
}

// ============================================================================
// Aggregation Function: CBT-Pre
// ============================================================================
function aggregateCBTPre(siteData) {
  const preData = siteData.phases?.pre_interaction;
  
  // Require pre_interaction to exist
  if (!preData) {
    console.warn(`CBT-Pre missing: ${siteData.url}`);
    return null;
  }
  
  return {
    url: siteData.url,
    final_url: siteData.final_url,
    model: 'consent-based',
    phase: 'pre_interaction',
    timestamp: siteData.timestamp,
    
    // RQ1: Dynamic inclusion metrics
    rq1_dynamic_inclusion: {
      scripts: preData.requests?.thirdParty ?? 0,
      domains: preData.requests?.uniqueDomains ?? 0,
      size: preData.requests?.totalSize ?? 0,
      ad_analytics_count: getAdAnalyticsCount(preData),
      
      T1: preData.timing?.T1 ?? null,
      T2: preData.timing?.T2 ?? null,
      
      domains_by_category: preData.requests?.domainsByCategory ?? {}
    },
    
    // RQ2: Dependency and execution metrics
    rq2_dependency_execution: {
      D1_max_inclusion_depth: preData.dependency?.D1_max_inclusion_depth ?? 0,
      D2_average_out_degree: preData.dependency?.D2_average_out_degree ?? 0,
      D3_cross_origin_edge_ratio: preData.dependency?.D3_cross_origin_edge_ratio ?? 0,
      dynamic_scripts_count: preData.dependency?.dynamic_scripts_count ?? 0,
      
      E1_dynamic_code_execution: preData.execution?.E1_dynamic_code_execution ?? 0,
      E2_deferred_execution: preData.execution?.E2_deferred_execution ?? 0,
      E3_error_rate: preData.execution?.E3_error_rate ?? 0
    },
    
    storage: preData.storage ?? {},
    fingerprinting: preData.fingerprinting ?? {},
    
    data_quality: {
      valid: preData.meta?.valid ?? false
    }
  };
}

// ============================================================================
// Aggregation Function: CBT-Reject
// ============================================================================
function aggregateCBTReject(siteData) {
  const preData = siteData.phases?.pre_interaction;
  const rejectData = siteData.phases?.post_reject;
  
  // Require both pre and reject to exist
  if (!preData || !rejectData) {
    console.warn(`CBT-Reject data incomplete: ${siteData.url}`);
    return null;
  }
  
  // T3 metrics: pre -> reject (windowed)
  const t3Metrics = computeT3Metrics(preData, rejectData);
  
  return {
    url: siteData.url,
    final_url: siteData.final_url,
    model: 'consent-based',
    phase: 'post_reject',
    timestamp: siteData.timestamp,
    
    // RQ1: Dynamic inclusion metrics
    rq1_dynamic_inclusion: {
      // Pre phase baseline
      pre_scripts: preData.requests?.thirdParty ?? 0,
      pre_domains: preData.requests?.uniqueDomains ?? 0,
      pre_size: preData.requests?.totalSize ?? 0,
      
      // Reject phase data
      scripts: rejectData.requests?.thirdParty ?? 0,
      domains: rejectData.requests?.uniqueDomains ?? 0,
      size: rejectData.requests?.totalSize ?? 0,
      ad_analytics_count: getAdAnalyticsCount(rejectData),
      
      T1: rejectData.timing?.T1 ?? null,
      T2: rejectData.timing?.T2 ?? null,
      
      // T3 growth metrics (windowed)
      T3: t3Metrics,
      
      domains_by_category: rejectData.requests?.domainsByCategory ?? {},
      clicked: rejectData.meta?.clicked ?? false
    },
    
    // RQ2: Use Reject phase data
    rq2_dependency_execution: {
      D1_max_inclusion_depth: rejectData.dependency?.D1_max_inclusion_depth ?? 0,
      D2_average_out_degree: rejectData.dependency?.D2_average_out_degree ?? 0,
      D3_cross_origin_edge_ratio: rejectData.dependency?.D3_cross_origin_edge_ratio ?? 0,
      dynamic_scripts_count: rejectData.dependency?.dynamic_scripts_count ?? 0,
      
      E1_dynamic_code_execution: rejectData.execution?.E1_dynamic_code_execution ?? 0,
      E2_deferred_execution: rejectData.execution?.E2_deferred_execution ?? 0,
      E3_error_rate: rejectData.execution?.E3_error_rate ?? 0
    },
    
    storage: rejectData.storage ?? {},
    fingerprinting: rejectData.fingerprinting ?? {},
    
    interface_behavior_divergence: siteData.interface_behavior_divergence ?? null,
    
    data_quality: {
      valid: rejectData.meta?.valid ?? false,
      pre_valid: preData.meta?.valid ?? false
    }
  };
}

// ============================================================================
// Aggregation Function: IT (Force Windowed)
// ============================================================================
function aggregateIT(siteData) {
  const preData = siteData.phases?.pre_interaction;
  const postData = siteData.phases?.post_interaction;
  
  // Core fix: Force use of windowed data, skip if missing
  if (!postData) {
    console.warn(`IT site missing post_interaction window: ${siteData.url}`);
    return null;
  }
  
  // T3 metrics: only calculate when pre+post exist
  const t3Metrics = (preData && postData) ? computeT3Metrics(preData, postData) : null;
  
  return {
    url: siteData.url,
    final_url: siteData.final_url,
    model: 'implicit',
    phase: 'post_interaction',
    timestamp: siteData.timestamp,
    
    // RQ1: Dynamic inclusion metrics
    rq1_dynamic_inclusion: {
      // Pre window data (optional)
      pre_scripts: preData?.requests?.thirdParty ?? null,
      pre_domains: preData?.requests?.uniqueDomains ?? null,
      pre_size: preData?.requests?.totalSize ?? null,
      pre_T1: preData?.timing?.T1 ?? null,
      pre_T2: preData?.timing?.T2 ?? null,
      
      // Post window data (required)
      scripts: postData.requests?.thirdParty ?? 0,
      domains: postData.requests?.uniqueDomains ?? 0,
      size: postData.requests?.totalSize ?? 0,
      ad_analytics_count: getAdAnalyticsCount(postData),
      
      T1: postData.timing?.T1 ?? null,
      T2: postData.timing?.T2 ?? null,
      
      // T3 metrics (only when windowed data available)
      T3: t3Metrics,
      
      domains_by_category: postData.requests?.domainsByCategory ?? {},
      
      // Mark data source
      data_source: 'windowed'
    },
    
    // RQ2: Use Post window data
    rq2_dependency_execution: {
      D1_max_inclusion_depth: postData.dependency?.D1_max_inclusion_depth ?? 0,
      D2_average_out_degree: postData.dependency?.D2_average_out_degree ?? 0,
      D3_cross_origin_edge_ratio: postData.dependency?.D3_cross_origin_edge_ratio ?? 0,
      dynamic_scripts_count: postData.dependency?.dynamic_scripts_count ?? 0,
      
      E1_dynamic_code_execution: postData.execution?.E1_dynamic_code_execution ?? 0,
      E2_deferred_execution: postData.execution?.E2_deferred_execution ?? 0,
      E3_error_rate: postData.execution?.E3_error_rate ?? 0
    },
    
    storage: postData.storage ?? {},
    fingerprinting: postData.fingerprinting ?? {},
    
    data_quality: {
      valid: postData.meta?.valid ?? false,
      pre_valid: preData?.meta?.valid ?? null
    }
  };
}



function loadAllSites(inputDir) {
  if (!fs.existsSync(inputDir)) {
    console.error(`Input directory does not exist: ${inputDir}`);
    process.exit(1);
  }
  
  const files = fs.readdirSync(inputDir).filter(f => f.endsWith('.json'));
  console.log(`Found ${files.length} JSON files\n`);
  
  const sites = [];
  let errorCount = 0;
  
  for (const file of files) {
    try {
      const filepath = path.join(inputDir, file);
      const content = fs.readFileSync(filepath, 'utf-8');
      const siteData = JSON.parse(content);
      
      if (siteData.error) {
        errorCount++;
        continue;
      }
      
      sites.push(siteData);
    } catch (e) {
      console.warn(`Read failed: ${file} - ${e.message}`);
      errorCount++;
    }
  }
  
  console.log(`Successfully loaded ${sites.length} sites`);
  console.log(`Skipped ${errorCount} error sites\n`);
  
  return sites;
}

function processSites(sites) {
  const cbtPreData = [];
  const cbtRejectData = [];
  const itData = [];
  
  let cbtPreSkipped = 0;
  let cbtRejectSkipped = 0;
  let itSkipped = 0;
  
  for (const site of sites) {
    const model = (site.model || '').toLowerCase();
    
    if (model === 'consent-based') {
      const preAgg = aggregateCBTPre(site);
      if (preAgg) {
        cbtPreData.push(preAgg);
      } else {
        cbtPreSkipped++;
      }
      
      const rejectAgg = aggregateCBTReject(site);
      if (rejectAgg) {
        cbtRejectData.push(rejectAgg);
      } else {
        cbtRejectSkipped++;
      }
      
    } else if (model === 'implicit') {
      const itAgg = aggregateIT(site);
      if (itAgg) {
        itData.push(itAgg);
      } else {
        itSkipped++;
      }
    }
  }
  
  console.log('===================================================================');
  console.log('Data Aggregation Statistics');
  console.log('===================================================================\n');
  
  console.log(`CBT-Pre:    ${cbtPreData.length} records (skipped ${cbtPreSkipped})`);
  console.log(`CBT-Reject: ${cbtRejectData.length} records (skipped ${cbtRejectSkipped})`);
  console.log(`IT:         ${itData.length} records (skipped ${itSkipped})`);
  console.log(`   Note: IT skipped due to missing post_interaction windowed data\n`);
  
  const cbtPreValid = cbtPreData.filter(d => d.data_quality.valid).length;
  const cbtRejectValid = cbtRejectData.filter(d => d.data_quality.valid).length;
  const itValid = itData.filter(d => d.data_quality.valid).length;
  
  console.log('Data Quality:');
  console.log(`  CBT-Pre:    ${cbtPreValid}/${cbtPreData.length} (${(cbtPreValid/cbtPreData.length*100).toFixed(1)}%) valid`);
  console.log(`  CBT-Reject: ${cbtRejectValid}/${cbtRejectData.length} (${(cbtRejectValid/cbtRejectData.length*100).toFixed(1)}%) valid`);
  console.log(`  IT:         ${itValid}/${itData.length} (${(itValid/itData.length*100).toFixed(1)}%) valid\n`);
  
  return { cbtPreData, cbtRejectData, itData };
}

function saveDatasets(datasets) {
  const { cbtPreData, cbtRejectData, itData } = datasets;
  
  if (!fs.existsSync(argv.outputDir)) {
    fs.mkdirSync(argv.outputDir, { recursive: true });
  }
  
  fs.writeFileSync(argv.outputCBTPre, JSON.stringify(cbtPreData, null, 2), 'utf-8');
  fs.writeFileSync(argv.outputCBTReject, JSON.stringify(cbtRejectData, null, 2), 'utf-8');
  fs.writeFileSync(argv.outputIT, JSON.stringify(itData, null, 2), 'utf-8');
  
  console.log('===================================================================');
  console.log('File Save Complete');
  console.log('===================================================================\n');
  
  console.log(`CBT-Pre:    ${path.resolve(argv.outputCBTPre)}`);
  console.log(`CBT-Reject: ${path.resolve(argv.outputCBTReject)}`);
  console.log(`IT:         ${path.resolve(argv.outputIT)}\n`);
  
  const readme = generateReadme(datasets);
  const readmePath = path.join(argv.outputDir, 'README.md');
  fs.writeFileSync(readmePath, readme, 'utf-8');
  console.log(`Usage guide: ${path.resolve(readmePath)}\n`);
}

function generateReadme(datasets) {
  const { cbtPreData, cbtRejectData, itData } = datasets;
  
  let md = '# Window Aligned Re-aggregated Dataset\n\n';
  md += `Generated: ${new Date().toISOString()}\n\n`;
  
  md += '## Core Fixes\n\n';
  md += '1. **IT sites force use of windowed data**: post_interaction must exist, skip if missing\n';
  md += '2. **T3 metrics only for windowed data**: pre(5s) -> post(30s), time windows fully aligned\n';
  md += '3. **Unified time windows**: Both CBT and IT post windows are 30 seconds\n';
  md += '4. **Robust field access**: Using `??` to handle null/undefined\n\n';
  
  md += '## Dataset Description\n\n';
  
  md += '### 1. CBT-Pre (`cbt_pre_aggregated.json`)\n\n';
  md += `- Record count: ${cbtPreData.length}\n`;
  md += '- Time window: 0-5 seconds (after navigation start)\n';
  md += '- Purpose: Initial load phase of CBT sites\n\n';
  
  md += '### 2. CBT-Reject (`cbt_reject_aggregated.json`) [*]\n\n';
  md += `- Record count: ${cbtRejectData.length}\n`;
  md += '- Time window: 30 seconds after clicking reject\n';
  md += '- Purpose: Core analysis data for "reject consent" state\n';
  md += '- **RQ2 analysis uses this dataset**\n\n';
  
  md += '### 3. IT (`it_aggregated.json`)\n\n';
  md += `- Record count: ${itData.length}\n`;
  md += '- Time window: post_interaction (5-35s, i.e., 30s window)\n';
  md += '- Purpose: Comparison baseline for "no consent" state\n';
  md += '- Note: Only includes sites with complete windowed data\n\n';
  
  md += '## Time Window Alignment\n\n';
  md += '| Phase | CBT | IT | Duration |\n';
  md += '|-------|-----|-------|----------|\n';
  md += '| Pre   | 0-5s | 0-5s | 5s |\n';
  md += '| Post  | 5-35s after click | 5-35s after nav | 30s |\n\n';
  
  md += '## RQ1/RQ2 Analysis Comparison\n\n';
  md += '### RQ1: Dynamic Inclusion (Scale and Timing)\n\n';
  md += '**Main comparison**: CBT-Reject vs IT (both 30s post window)\n\n';
  md += '```python\n';
  md += 'cbt_reject_scripts = [d["rq1_dynamic_inclusion"]["scripts"] for d in cbt_reject]\n';
  md += 'it_scripts = [d["rq1_dynamic_inclusion"]["scripts"] for d in it]\n';
  md += 'mannwhitneyu(cbt_reject_scripts, it_scripts)\n';
  md += '```\n\n';
  
  md += '### RQ2: Dependency and Execution\n\n';
  md += '**Main comparison**: CBT-Reject vs IT (both use post window data)\n\n';
  md += '```python\n';
  md += 'cbt_d1 = [d["rq2_dependency_execution"]["D1_max_inclusion_depth"] for d in cbt_reject]\n';
  md += 'it_d1 = [d["rq2_dependency_execution"]["D1_max_inclusion_depth"] for d in it]\n';
  md += 'mannwhitneyu(cbt_d1, it_d1)\n';
  md += '```\n\n';
  
  md += '## Data Quality\n\n';
  const cbtPreValid = cbtPreData.filter(d => d.data_quality.valid).length;
  const cbtRejectValid = cbtRejectData.filter(d => d.data_quality.valid).length;
  const itValid = itData.filter(d => d.data_quality.valid).length;
  
  md += `| Dataset | Total | Valid | Valid Rate |\n`;
  md += `|---------|-------|-------|------------|\n`;
  md += `| CBT-Pre | ${cbtPreData.length} | ${cbtPreValid} | ${(cbtPreValid/cbtPreData.length*100).toFixed(1)}% |\n`;
  md += `| CBT-Reject | ${cbtRejectData.length} | ${cbtRejectValid} | ${(cbtRejectValid/cbtRejectData.length*100).toFixed(1)}% |\n`;
  md += `| IT | ${itData.length} | ${itValid} | ${(itValid/itData.length*100).toFixed(1)}% |\n\n`;
  
  return md;
}

// ============================================================================
// Main Process
// ============================================================================

(async () => {
  console.log(`
===========================================================================
                  Window Aligned Data Re-aggregation
          Fix: Force Windowed + T3 Aligned + Robust Field Access
===========================================================================
Input dir:    ${argv.inputDir}
Output dir:   ${argv.outputDir}
===========================================================================
  `);
  
  const sites = loadAllSites(argv.inputDir);
  const datasets = processSites(sites);
  saveDatasets(datasets);
  
  console.log('Aggregation complete!\n');
  console.log('Key improvements:');
  console.log('   - IT sites force use of post_interaction window');
  console.log('   - T3 metrics only calculated between windowed data');
  console.log('   - CBT and IT post windows fully aligned (30s)\n');
  
})().catch(e => {
  console.error('Fatal:', e && e.message ? e.message : e);
  process.exit(1);
});
