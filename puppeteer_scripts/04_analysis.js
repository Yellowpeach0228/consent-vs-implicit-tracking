/**
 * =============================================================================
 * 04_analysis.js
 * =============================================================================
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
    inputCBTPre: str('inputCBTPre', './output/reaggregated/cbt_pre_aggregated.json'),
    inputCBTReject: str('inputCBTReject', './output/reaggregated/cbt_reject_aggregated.json'),
    inputIT: str('inputIT', './output/reaggregated/it_aggregated.json'),
    output: str('output', './output/analysis_results'),
    alpha: parseFloat(str('alpha', '0.05'))
  };
}

const argv = parseArgv();

// ============================================================================
// Basic Statistical Functions
// ============================================================================

function mean(arr) {
  if (!arr || arr.length === 0) return NaN;
  return arr.reduce((sum, x) => sum + x, 0) / arr.length;
}

function median(arr) {
  if (!arr || arr.length === 0) return NaN;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 
    ? (sorted[mid - 1] + sorted[mid]) / 2 
    : sorted[mid];
}

function variance(arr, isSample = true) {
  if (!arr || arr.length === 0) return NaN;
  const m = mean(arr);
  const sumSq = arr.reduce((sum, x) => sum + (x - m) ** 2, 0);
  return sumSq / (arr.length - (isSample ? 1 : 0));
}

function std(arr, isSample = true) {
  return Math.sqrt(variance(arr, isSample));
}

function percentile(arr, p) {
  if (!arr || arr.length === 0) return NaN;
  const sorted = [...arr].sort((a, b) => a - b);
  const index = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const weight = index - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function iqr(arr) {
  return percentile(arr, 75) - percentile(arr, 25);
}

// ============================================================================
// Statistical Tests
// ============================================================================

function mannWhitneyU(x, y) {
  const nx = x.length;
  const ny = y.length;
  
  const combined = [
    ...x.map(v => ({ value: v, group: 0 })),
    ...y.map(v => ({ value: v, group: 1 }))
  ];
  
  combined.sort((a, b) => a.value - b.value);
  
  const ranks = [];
  let i = 0;
  while (i < combined.length) {
    let j = i;
    while (j < combined.length && combined[j].value === combined[i].value) {
      j++;
    }
    const avgRank = (i + 1 + j) / 2;
    for (let k = i; k < j; k++) {
      ranks.push(avgRank);
    }
    i = j;
  }
  
  let R1 = 0;
  for (let i = 0; i < combined.length; i++) {
    if (combined[i].group === 0) {
      R1 += ranks[i];
    }
  }
  
  const U1 = R1 - (nx * (nx + 1)) / 2;
  const U2 = nx * ny - U1;
  const U = Math.min(U1, U2);
  
  const meanU = (nx * ny) / 2;
  const stdU = Math.sqrt((nx * ny * (nx + ny + 1)) / 12);
  const z = (U - meanU) / stdU;
  
  const p = 2 * (1 - normalCDF(Math.abs(z)));
  
  return {
    U: U,
    z: z,
    p: p,
    meanX: mean(x),
    meanY: mean(y),
    medianX: median(x),
    medianY: median(y)
  };
}

function wilcoxonSignedRank(x, y) {
  if (x.length !== y.length) {
    throw new Error('Paired samples must have equal length');
  }
  
  const diffs = x.map((xi, i) => xi - y[i]);
  const nonZeroDiffs = diffs.filter(d => d !== 0);
  const n = nonZeroDiffs.length;
  
  if (n === 0) {
    return { W: 0, z: 0, p: 1, meanDiff: 0, medianDiff: 0, n: 0 };
  }
  
  const absDiffs = nonZeroDiffs.map(d => Math.abs(d));
  const indices = Array.from({ length: n }, (_, i) => i);
  indices.sort((a, b) => absDiffs[a] - absDiffs[b]);
  
  const ranks = new Array(n);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j < n && absDiffs[indices[j]] === absDiffs[indices[i]]) {
      j++;
    }
    const avgRank = (i + 1 + j) / 2;
    for (let k = i; k < j; k++) {
      ranks[indices[k]] = avgRank;
    }
    i = j;
  }
  
  let Wplus = 0;
  for (let i = 0; i < n; i++) {
    if (nonZeroDiffs[i] > 0) {
      Wplus += ranks[i];
    }
  }
  
  const meanW = (n * (n + 1)) / 4;
  const stdW = Math.sqrt((n * (n + 1) * (2 * n + 1)) / 24);
  const z = (Wplus - meanW) / stdW;
  
  const p = 2 * (1 - normalCDF(Math.abs(z)));
  
  return {
    W: Wplus,
    z: z,
    p: p,
    meanDiff: mean(diffs),
    medianDiff: median(diffs),
    n: n
  };
}

function normalCDF(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp(-x * x / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}

function cohensD(x, y) {
  const meanX = mean(x);
  const meanY = mean(y);
  const varX = variance(x);
  const varY = variance(y);
  const nx = x.length;
  const ny = y.length;
  
  const pooledStd = Math.sqrt(((nx - 1) * varX + (ny - 1) * varY) / (nx + ny - 2));
  
  return (meanX - meanY) / pooledStd;
}

function cohensDPaired(x, y) {
  const diffs = x.map((xi, i) => xi - y[i]);
  const meanDiff = mean(diffs);
  const stdDiff = std(diffs);
  
  return meanDiff / stdDiff;
}

function rankBiserialCorrelation(U, nx, ny) {
  return 1 - (2 * U) / (nx * ny);
}

// ============================================================================
// Data Loading
// ============================================================================

function loadDatasets() {
  console.log('Loading datasets...\n');
  
  if (!fs.existsSync(argv.inputCBTPre)) {
    console.error(`CBT-Pre file does not exist: ${argv.inputCBTPre}`);
    process.exit(1);
  }
  const cbtPre = JSON.parse(fs.readFileSync(argv.inputCBTPre, 'utf-8'))
    .filter(d => d.data_quality?.valid !== false);
  
  if (!fs.existsSync(argv.inputCBTReject)) {
    console.error(`CBT-Reject file does not exist: ${argv.inputCBTReject}`);
    process.exit(1);
  }
  const cbtReject = JSON.parse(fs.readFileSync(argv.inputCBTReject, 'utf-8'))
    .filter(d => d.data_quality?.valid !== false);
  
  if (!fs.existsSync(argv.inputIT)) {
    console.error(`IT file does not exist: ${argv.inputIT}`);
    process.exit(1);
  }
  const it = JSON.parse(fs.readFileSync(argv.inputIT, 'utf-8'))
    .filter(d => d.data_quality?.valid !== false);
  
  console.log(`Data loading complete:`);
  console.log(`   - CBT-Pre:    ${cbtPre.length} valid records`);
  console.log(`   - CBT-Reject: ${cbtReject.length} valid records`);
  console.log(`   - IT:         ${it.length} valid records`);
  console.log(`   - Total:      ${cbtPre.length + cbtReject.length + it.length}\n`);
  
  return { cbtPre, cbtReject, it };
}

// ============================================================================
// RQ1: Dynamic Inclusion Analysis
// ============================================================================

function analyzeRQ1(cbtPre, cbtReject, it) {
  console.log('===================================================================');
  console.log('RQ1: Dynamic Inclusion - Scale and Timing Differences');
  console.log('===================================================================\n');
  
  const results = {
    scale_metrics: {},
    timing_metrics: {},
    growth_metrics: {},
    divergence_analysis: {}
  };
  
  // ========================================================================
  // Scale Metrics Analysis (S1: Third-party Script Count)
  // ========================================================================
  
  console.log('[1] Scale Metrics (S1: Third-party Script Count)');
  console.log('-------------------------------------------------------------------\n');
  
  // Extract data
  const cbtPreScripts = cbtPre
    .filter(d => d.rq1_dynamic_inclusion?.scripts !== undefined)
    .map(d => d.rq1_dynamic_inclusion.scripts);
  
  const cbtRejectScripts = cbtReject
    .filter(d => d.rq1_dynamic_inclusion?.scripts !== undefined)
    .map(d => d.rq1_dynamic_inclusion.scripts);
  
  const itPreScripts = it
    .filter(d => d.rq1_dynamic_inclusion?.pre_scripts !== null && d.rq1_dynamic_inclusion?.pre_scripts !== undefined)
    .map(d => d.rq1_dynamic_inclusion.pre_scripts);
  
  const itScripts = it
    .filter(d => d.rq1_dynamic_inclusion?.scripts !== undefined)
    .map(d => d.rq1_dynamic_inclusion.scripts);
  
  // (1) CBT-Pre vs IT-Pre (Initial Load Comparison)
  if (cbtPreScripts.length > 0 && itPreScripts.length > 0) {
    console.log('[Initial Load Phase] CBT-Pre vs IT-Pre:');
    const preComparison = mannWhitneyU(cbtPreScripts, itPreScripts);
    const preEffectSize = rankBiserialCorrelation(preComparison.U, cbtPreScripts.length, itPreScripts.length);
    
    console.log(`  CBT-Pre: n=${cbtPreScripts.length}, Mean=${preComparison.meanX.toFixed(2)}, Median=${preComparison.medianX.toFixed(2)}, SD=${std(cbtPreScripts).toFixed(2)}`);
    console.log(`  IT-Pre:  n=${itPreScripts.length}, Mean=${preComparison.meanY.toFixed(2)}, Median=${preComparison.medianY.toFixed(2)}, SD=${std(itPreScripts).toFixed(2)}`);
    console.log(`  Mann-Whitney U: U=${preComparison.U.toFixed(2)}, z=${preComparison.z.toFixed(3)}, p=${preComparison.p.toFixed(4)}`);
    console.log(`  Effect size (r): ${preEffectSize.toFixed(3)}`);
    console.log(`  ${preComparison.p < argv.alpha ? '[OK] Significant difference' : '[X] No significant difference'}\n`);
    
    results.scale_metrics.s1_pre_comparison = {
      cbt_pre: descriptiveStats(cbtPreScripts),
      it_pre: descriptiveStats(itPreScripts),
      test: preComparison,
      effect_size: preEffectSize,
      significant: preComparison.p < argv.alpha
    };
  }
  
  // (2) CBT-Reject vs IT (Core Comparison - "No Consent" State)
  if (cbtRejectScripts.length > 0 && itScripts.length > 0) {
    console.log('[* Core Comparison] CBT-Reject vs IT ("No Consent" State):');
    const rejectComparison = mannWhitneyU(cbtRejectScripts, itScripts);
    const rejectEffectSize = rankBiserialCorrelation(
      rejectComparison.U, 
      cbtRejectScripts.length, 
      itScripts.length
    );
    
    console.log(`  CBT-Reject: n=${cbtRejectScripts.length}, Mean=${rejectComparison.meanX.toFixed(2)}, Median=${rejectComparison.medianX.toFixed(2)}, SD=${std(cbtRejectScripts).toFixed(2)}`);
    console.log(`  IT:         n=${itScripts.length}, Mean=${rejectComparison.meanY.toFixed(2)}, Median=${rejectComparison.medianY.toFixed(2)}, SD=${std(itScripts).toFixed(2)}`);
    console.log(`  Mann-Whitney U: U=${rejectComparison.U.toFixed(2)}, z=${rejectComparison.z.toFixed(3)}, p=${rejectComparison.p.toFixed(4)}`);
    console.log(`  Effect size (r): ${rejectEffectSize.toFixed(3)}`);
    console.log(`  ${rejectComparison.p < argv.alpha ? '[OK] Significant difference - Violation behavior detected' : '[X] No significant difference - As expected'}`);
    console.log(`  Note: Theoretically should be similar (both are "no consent" state), difference indicates violation\n`);
    
    results.scale_metrics.s1_reject_vs_it = {
      cbt_reject: descriptiveStats(cbtRejectScripts),
      it: descriptiveStats(itScripts),
      test: rejectComparison,
      effect_size: rejectEffectSize,
      significant: rejectComparison.p < argv.alpha
    };
  }
  
  // CBT Internal Comparison: Pre vs Reject (Paired Test)
  const pairedData = [];
  for (const rejectRecord of cbtReject) {
    const preRecord = cbtPre.find(p => p.url === rejectRecord.url || p.final_url === rejectRecord.final_url);
    if (preRecord && 
        preRecord.rq1_dynamic_inclusion?.scripts !== undefined && 
        rejectRecord.rq1_dynamic_inclusion?.scripts !== undefined) {
      pairedData.push({
        url: rejectRecord.url,
        pre: preRecord.rq1_dynamic_inclusion.scripts,
        reject: rejectRecord.rq1_dynamic_inclusion.scripts
      });
    }
  }
  
  if (pairedData.length > 0) {
    const preValues = pairedData.map(d => d.pre);
    const rejectValues = pairedData.map(d => d.reject);
    
    console.log('[CBT Internal Validation] Pre vs Reject (Paired):');
    const cbtInternalTest = wilcoxonSignedRank(preValues, rejectValues);
    const cbtInternalEffect = cohensDPaired(preValues, rejectValues);
    
    console.log(`  Paired sites: n=${pairedData.length}`);
    console.log(`  Pre:    Mean=${mean(preValues).toFixed(2)}, Median=${median(preValues).toFixed(2)}, SD=${std(preValues).toFixed(2)}`);
    console.log(`  Reject: Mean=${mean(rejectValues).toFixed(2)}, Median=${median(rejectValues).toFixed(2)}, SD=${std(rejectValues).toFixed(2)}`);
    console.log(`  Diff:   Mean=${cbtInternalTest.meanDiff.toFixed(2)}, Median=${cbtInternalTest.medianDiff.toFixed(2)}`);
    console.log(`  Wilcoxon: W=${cbtInternalTest.W.toFixed(2)}, z=${cbtInternalTest.z.toFixed(3)}, p=${cbtInternalTest.p.toFixed(4)}`);
    console.log(`  Cohen's d: ${cbtInternalEffect.toFixed(3)}`);
    console.log(`  ${cbtInternalTest.p < argv.alpha ? '[OK] Reject significantly increased - Consent mechanism failed' : '[X] No significant increase - Consent mechanism effective'}\n`);
    
    results.scale_metrics.s1_cbt_internal = {
      n: pairedData.length,
      pre: descriptiveStats(preValues),
      reject: descriptiveStats(rejectValues),
      test: cbtInternalTest,
      effect_size: cbtInternalEffect,
      significant: cbtInternalTest.p < argv.alpha
    };
  }
  
  // ========================================================================
  // 2. Timing Metrics Analysis (T1, T2)
  // ========================================================================
  
  console.log('\n[2] Timing Metrics (T1: First Third-party Script, T2: First Ad/Analytics Script)');
  console.log('-------------------------------------------------------------------\n');
  
  // T1 Analysis
  const cbtPreT1 = cbtPre
    .filter(d => d.rq1_dynamic_inclusion?.T1 !== null && d.rq1_dynamic_inclusion?.T1 !== undefined)
    .map(d => d.rq1_dynamic_inclusion.T1);
  
  const itPreT1 = it
    .filter(d => d.rq1_dynamic_inclusion?.pre_T1 !== null && d.rq1_dynamic_inclusion?.pre_T1 !== undefined)
    .map(d => d.rq1_dynamic_inclusion.pre_T1);
  
  if (cbtPreT1.length > 0 && itPreT1.length > 0) {
    console.log('T1: First Third-party Script Load Time (ms)\n');
    
    const t1Comparison = mannWhitneyU(cbtPreT1, itPreT1);
    const t1EffectSize = rankBiserialCorrelation(t1Comparison.U, cbtPreT1.length, itPreT1.length);
    
    console.log(`  CBT-Pre: n=${cbtPreT1.length}, Mean=${t1Comparison.meanX.toFixed(2)}, Median=${t1Comparison.medianX.toFixed(2)}, SD=${std(cbtPreT1).toFixed(2)}`);
    console.log(`  IT-Pre:  n=${itPreT1.length}, Mean=${t1Comparison.meanY.toFixed(2)}, Median=${t1Comparison.medianY.toFixed(2)}, SD=${std(itPreT1).toFixed(2)}`);
    console.log(`  Mann-Whitney U: U=${t1Comparison.U.toFixed(2)}, z=${t1Comparison.z.toFixed(3)}, p=${t1Comparison.p.toFixed(4)}`);
    console.log(`  Effect size (r): ${t1EffectSize.toFixed(3)}`);
    console.log(`  ${t1Comparison.p < argv.alpha ? '[OK] Significant difference' : '[X] No significant difference'}\n`);
    
    results.timing_metrics.t1_comparison = {
      cbt_pre: descriptiveStats(cbtPreT1),
      it_pre: descriptiveStats(itPreT1),
      test: t1Comparison,
      effect_size: t1EffectSize,
      significant: t1Comparison.p < argv.alpha
    };
  }
  
  // T2 Analysis
  const cbtPreT2 = cbtPre
    .filter(d => d.rq1_dynamic_inclusion?.T2 !== null && d.rq1_dynamic_inclusion?.T2 !== undefined)
    .map(d => d.rq1_dynamic_inclusion.T2);
  
  const itPreT2 = it
    .filter(d => d.rq1_dynamic_inclusion?.pre_T2 !== null && d.rq1_dynamic_inclusion?.pre_T2 !== undefined)
    .map(d => d.rq1_dynamic_inclusion.pre_T2);
  
  if (cbtPreT2.length > 0 && itPreT2.length > 0) {
    console.log('T2: First Ad/Analytics Script Load Time (ms)\n');
    
    const t2Comparison = mannWhitneyU(cbtPreT2, itPreT2);
    const t2EffectSize = rankBiserialCorrelation(t2Comparison.U, cbtPreT2.length, itPreT2.length);
    
    console.log(`  CBT-Pre: n=${cbtPreT2.length}, Mean=${t2Comparison.meanX.toFixed(2)}, Median=${t2Comparison.medianX.toFixed(2)}, SD=${std(cbtPreT2).toFixed(2)}`);
    console.log(`  IT-Pre:  n=${itPreT2.length}, Mean=${t2Comparison.meanY.toFixed(2)}, Median=${t2Comparison.medianY.toFixed(2)}, SD=${std(itPreT2).toFixed(2)}`);
    console.log(`  Mann-Whitney U: U=${t2Comparison.U.toFixed(2)}, z=${t2Comparison.z.toFixed(3)}, p=${t2Comparison.p.toFixed(4)}`);
    console.log(`  Effect size (r): ${t2EffectSize.toFixed(3)}`);
    console.log(`  ${t2Comparison.p < argv.alpha ? '[OK] Significant difference' : '[X] No significant difference'}\n`);
    
    results.timing_metrics.t2_comparison = {
      cbt_pre: descriptiveStats(cbtPreT2),
      it_pre: descriptiveStats(itPreT2),
      test: t2Comparison,
      effect_size: t2EffectSize,
      significant: t2Comparison.p < argv.alpha
    };
  }
  
  // ========================================================================
  // 3. T3 Growth Metrics Analysis
  // ========================================================================
  
  console.log('\n[3] T3 Growth Metrics (Reject vs Pre)');
  console.log('-------------------------------------------------------------------\n');
  
  const cbtT3Scripts = cbtReject
    .filter(d => d.rq1_dynamic_inclusion?.T3?.scripts_absolute !== undefined)
    .map(d => d.rq1_dynamic_inclusion.T3.scripts_absolute);
  
  if (cbtT3Scripts.length > 0) {
    console.log('T3: Script Growth (Reject - Pre)\n');
    console.log(`  Sample size: n=${cbtT3Scripts.length}`);
    console.log(`  Mean=${mean(cbtT3Scripts).toFixed(2)}, Median=${median(cbtT3Scripts).toFixed(2)}, SD=${std(cbtT3Scripts).toFixed(2)}`);
    console.log(`  Min=${Math.min(...cbtT3Scripts).toFixed(2)}, Max=${Math.max(...cbtT3Scripts).toFixed(2)}`);
    
    const positiveGrowth = cbtT3Scripts.filter(v => v > 0).length;
    console.log(`  Positive growth sites: ${positiveGrowth}/${cbtT3Scripts.length} (${(positiveGrowth/cbtT3Scripts.length*100).toFixed(1)}%)`);
    console.log(`  Note: Positive growth indicates new scripts loaded after rejection\n`);
    
    results.growth_metrics.t3_scripts = {
      stats: descriptiveStats(cbtT3Scripts),
      positive_growth_count: positiveGrowth,
      positive_growth_rate: positiveGrowth / cbtT3Scripts.length
    };
  }
  
  return results;
}

// ============================================================================
// RQ2: Dependency Structure and Execution Behavior Differences (CBT-Reject vs IT)
// ============================================================================

function analyzeRQ2(cbtReject, it) {
  console.log('\n===================================================================');
  console.log('RQ2: Dependency Structure and Execution Behavior (Focus on Reject State)');
  console.log('===================================================================\n');
  
  const results = {
    dependency_metrics: {},
    execution_metrics: {}
  };
  
  console.log(`Sample size: CBT-Reject=${cbtReject.length}, IT=${it.length}\n`);
  
  // ========================================================================
  // 1. Dependency Graph Metrics (D1, D2, D3)
  // ========================================================================
  
  console.log('[1] Dependency Graph Structure Metrics');
  console.log('-------------------------------------------------------------------\n');
  
  // D1: Maximum inclusion depth
  const cbtD1 = cbtReject
    .filter(d => d.rq2_dependency_execution?.D1_max_inclusion_depth !== undefined)
    .map(d => d.rq2_dependency_execution.D1_max_inclusion_depth);
  
  const itD1 = it
    .filter(d => d.rq2_dependency_execution?.D1_max_inclusion_depth !== undefined)
    .map(d => d.rq2_dependency_execution.D1_max_inclusion_depth);
  
  if (cbtD1.length > 0 && itD1.length > 0) {
    console.log('D1: Maximum Inclusion Depth\n');
    console.log('Note: Measures tracker nesting level (higher value = more complex dependency chain)\n');
    
    const d1Comparison = mannWhitneyU(cbtD1, itD1);
    const d1EffectSize = rankBiserialCorrelation(d1Comparison.U, cbtD1.length, itD1.length);
    
    console.log(`  CBT-Reject: n=${cbtD1.length}, Mean=${d1Comparison.meanX.toFixed(2)}, Median=${d1Comparison.medianX.toFixed(2)}, SD=${std(cbtD1).toFixed(2)}`);
    console.log(`  IT:         n=${itD1.length}, Mean=${d1Comparison.meanY.toFixed(2)}, Median=${d1Comparison.medianY.toFixed(2)}, SD=${std(itD1).toFixed(2)}`);
    console.log(`  Mann-Whitney U: U=${d1Comparison.U.toFixed(2)}, z=${d1Comparison.z.toFixed(3)}, p=${d1Comparison.p.toFixed(4)}`);
    console.log(`  Effect size (r): ${d1EffectSize.toFixed(3)}`);
    console.log(`  ${d1Comparison.p < argv.alpha ? '[OK] Significant difference - Different dependency structure' : '[X] No significant difference - Similar dependency structure'}\n`);
    
    results.dependency_metrics.d1_comparison = {
      cbt_reject: descriptiveStats(cbtD1),
      it: descriptiveStats(itD1),
      test: d1Comparison,
      effect_size: d1EffectSize,
      significant: d1Comparison.p < argv.alpha
    };
  }
  
  // D2: Average out-degree
  const cbtD2 = cbtReject
    .filter(d => d.rq2_dependency_execution?.D2_average_out_degree !== undefined)
    .map(d => d.rq2_dependency_execution.D2_average_out_degree);
  
  const itD2 = it
    .filter(d => d.rq2_dependency_execution?.D2_average_out_degree !== undefined)
    .map(d => d.rq2_dependency_execution.D2_average_out_degree);
  
  if (cbtD2.length > 0 && itD2.length > 0) {
    console.log('D2: Average Out-Degree\n');
    console.log('Note: Measures tracker distribution capability (higher value = more sub-resource calls from central node)\n');
    
    const d2Comparison = mannWhitneyU(cbtD2, itD2);
    const d2EffectSize = rankBiserialCorrelation(d2Comparison.U, cbtD2.length, itD2.length);
    
    console.log(`  CBT-Reject: n=${cbtD2.length}, Mean=${d2Comparison.meanX.toFixed(3)}, Median=${d2Comparison.medianX.toFixed(3)}, SD=${std(cbtD2).toFixed(3)}`);
    console.log(`  IT:         n=${itD2.length}, Mean=${d2Comparison.meanY.toFixed(3)}, Median=${d2Comparison.medianY.toFixed(3)}, SD=${std(itD2).toFixed(3)}`);
    console.log(`  Mann-Whitney U: U=${d2Comparison.U.toFixed(2)}, z=${d2Comparison.z.toFixed(3)}, p=${d2Comparison.p.toFixed(4)}`);
    console.log(`  Effect size (r): ${d2EffectSize.toFixed(3)}`);
    console.log(`  ${d2Comparison.p < argv.alpha ? '[OK] Significant difference - Different distribution pattern' : '[X] No significant difference - Similar distribution pattern'}\n`);
    
    results.dependency_metrics.d2_comparison = {
      cbt_reject: descriptiveStats(cbtD2),
      it: descriptiveStats(itD2),
      test: d2Comparison,
      effect_size: d2EffectSize,
      significant: d2Comparison.p < argv.alpha
    };
  }
  
  // D3: Cross-origin edge ratio
  const cbtD3 = cbtReject
    .filter(d => d.rq2_dependency_execution?.D3_cross_origin_edge_ratio !== undefined)
    .map(d => d.rq2_dependency_execution.D3_cross_origin_edge_ratio);
  
  const itD3 = it
    .filter(d => d.rq2_dependency_execution?.D3_cross_origin_edge_ratio !== undefined)
    .map(d => d.rq2_dependency_execution.D3_cross_origin_edge_ratio);
  
  if (cbtD3.length > 0 && itD3.length > 0) {
    console.log('D3: Cross-Origin Edge Ratio\n');
    console.log('Note: Measures tracking ecosystem interconnection (higher value = tighter cross-domain collaboration)\n');
    
    const d3Comparison = mannWhitneyU(cbtD3, itD3);
    const d3EffectSize = rankBiserialCorrelation(d3Comparison.U, cbtD3.length, itD3.length);
    
    console.log(`  CBT-Reject: n=${cbtD3.length}, Mean=${d3Comparison.meanX.toFixed(3)}, Median=${d3Comparison.medianX.toFixed(3)}, SD=${std(cbtD3).toFixed(3)}`);
    console.log(`  IT:         n=${itD3.length}, Mean=${d3Comparison.meanY.toFixed(3)}, Median=${d3Comparison.medianY.toFixed(3)}, SD=${std(itD3).toFixed(3)}`);
    console.log(`  Mann-Whitney U: U=${d3Comparison.U.toFixed(2)}, z=${d3Comparison.z.toFixed(3)}, p=${d3Comparison.p.toFixed(4)}`);
    console.log(`  Effect size (r): ${d3EffectSize.toFixed(3)}`);
    console.log(`  ${d3Comparison.p < argv.alpha ? '[OK] Significant difference - Different ecosystem structure' : '[X] No significant difference - Similar ecosystem structure'}\n`);
    
    results.dependency_metrics.d3_comparison = {
      cbt_reject: descriptiveStats(cbtD3),
      it: descriptiveStats(itD3),
      test: d3Comparison,
      effect_size: d3EffectSize,
      significant: d3Comparison.p < argv.alpha
    };
  }
  
  // ========================================================================
  // 2. Execution Behavior Metrics (E1, E2, E3)
  // ========================================================================
  
  console.log('\n[2] Execution Behavior Metrics');
  console.log('-------------------------------------------------------------------\n');
  
  // E1: Dynamic code execution
  const cbtE1 = cbtReject
    .filter(d => d.rq2_dependency_execution?.E1_dynamic_code_execution !== undefined)
    .map(d => d.rq2_dependency_execution.E1_dynamic_code_execution);
  
  const itE1 = it
    .filter(d => d.rq2_dependency_execution?.E1_dynamic_code_execution !== undefined)
    .map(d => d.rq2_dependency_execution.E1_dynamic_code_execution);
  
  if (cbtE1.length > 0 && itE1.length > 0) {
    console.log('E1: Dynamic Code Execution\n');
    console.log('Note: Measures usage frequency of dangerous APIs like eval and Function constructor\n');
    
    const e1Comparison = mannWhitneyU(cbtE1, itE1);
    const e1EffectSize = rankBiserialCorrelation(e1Comparison.U, cbtE1.length, itE1.length);
    
    console.log(`  CBT-Reject: n=${cbtE1.length}, Mean=${e1Comparison.meanX.toFixed(2)}, Median=${e1Comparison.medianX.toFixed(2)}, SD=${std(cbtE1).toFixed(2)}`);
    console.log(`  IT:         n=${itE1.length}, Mean=${e1Comparison.meanY.toFixed(2)}, Median=${e1Comparison.medianY.toFixed(2)}, SD=${std(itE1).toFixed(2)}`);
    console.log(`  Mann-Whitney U: U=${e1Comparison.U.toFixed(2)}, z=${e1Comparison.z.toFixed(3)}, p=${e1Comparison.p.toFixed(4)}`);
    console.log(`  Effect size (r): ${e1EffectSize.toFixed(3)}`);
    console.log(`  ${e1Comparison.p < argv.alpha ? '[OK] Significant difference - Different code execution pattern' : '[X] No significant difference - Similar code execution pattern'}\n`);
    
    results.execution_metrics.e1_comparison = {
      cbt_reject: descriptiveStats(cbtE1),
      it: descriptiveStats(itE1),
      test: e1Comparison,
      effect_size: e1EffectSize,
      significant: e1Comparison.p < argv.alpha
    };
  }
  
  // E2: Deferred execution
  const cbtE2 = cbtReject
    .filter(d => d.rq2_dependency_execution?.E2_deferred_execution !== undefined)
    .map(d => d.rq2_dependency_execution.E2_deferred_execution);
  
  const itE2 = it
    .filter(d => d.rq2_dependency_execution?.E2_deferred_execution !== undefined)
    .map(d => d.rq2_dependency_execution.E2_deferred_execution);
  
  if (cbtE2.length > 0 && itE2.length > 0) {
    console.log('E2: Deferred Execution\n');
    console.log('Note: Measures usage of deferred strategies like setTimeout(>1s), requestIdleCallback\n');
    
    const e2Comparison = mannWhitneyU(cbtE2, itE2);
    const e2EffectSize = rankBiserialCorrelation(e2Comparison.U, cbtE2.length, itE2.length);
    
    console.log(`  CBT-Reject: n=${cbtE2.length}, Mean=${e2Comparison.meanX.toFixed(2)}, Median=${e2Comparison.medianX.toFixed(2)}, SD=${std(cbtE2).toFixed(2)}`);
    console.log(`  IT:         n=${itE2.length}, Mean=${e2Comparison.meanY.toFixed(2)}, Median=${e2Comparison.medianY.toFixed(2)}, SD=${std(itE2).toFixed(2)}`);
    console.log(`  Mann-Whitney U: U=${e2Comparison.U.toFixed(2)}, z=${e2Comparison.z.toFixed(3)}, p=${e2Comparison.p.toFixed(4)}`);
    console.log(`  Effect size (r): ${e2EffectSize.toFixed(3)}`);
    console.log(`  ${e2Comparison.p < argv.alpha ? '[OK] Significant difference - Different deferred strategy' : '[X] No significant difference - Similar deferred strategy'}\n`);
    
    results.execution_metrics.e2_comparison = {
      cbt_reject: descriptiveStats(cbtE2),
      it: descriptiveStats(itE2),
      test: e2Comparison,
      effect_size: e2EffectSize,
      significant: e2Comparison.p < argv.alpha
    };
  }
  
  // E3: Error rate
  const cbtE3 = cbtReject
    .filter(d => d.rq2_dependency_execution?.E3_error_rate !== undefined)
    .map(d => d.rq2_dependency_execution.E3_error_rate);
  
  const itE3 = it
    .filter(d => d.rq2_dependency_execution?.E3_error_rate !== undefined)
    .map(d => d.rq2_dependency_execution.E3_error_rate);
  
  if (cbtE3.length > 0 && itE3.length > 0) {
    console.log('E3: Error Rate\n');
    console.log('Note: Measures code quality and stability (indirectly reflects implementation complexity)\n');
    
    const e3Comparison = mannWhitneyU(cbtE3, itE3);
    const e3EffectSize = rankBiserialCorrelation(e3Comparison.U, cbtE3.length, itE3.length);
    
    console.log(`  CBT-Reject: n=${cbtE3.length}, Mean=${e3Comparison.meanX.toFixed(4)}, Median=${e3Comparison.medianX.toFixed(4)}, SD=${std(cbtE3).toFixed(4)}`);
    console.log(`  IT:         n=${itE3.length}, Mean=${e3Comparison.meanY.toFixed(4)}, Median=${e3Comparison.medianY.toFixed(4)}, SD=${std(itE3).toFixed(4)}`);
    console.log(`  Mann-Whitney U: U=${e3Comparison.U.toFixed(2)}, z=${e3Comparison.z.toFixed(3)}, p=${e3Comparison.p.toFixed(4)}`);
    console.log(`  Effect size (r): ${e3EffectSize.toFixed(3)}`);
    console.log(`  ${e3Comparison.p < argv.alpha ? '[OK] Significant difference - Different code quality' : '[X] No significant difference - Similar code quality'}\n`);
    
    results.execution_metrics.e3_comparison = {
      cbt_reject: descriptiveStats(cbtE3),
      it: descriptiveStats(itE3),
      test: e3Comparison,
      effect_size: e3EffectSize,
      significant: e3Comparison.p < argv.alpha
    };
  }
  
  return results;
}

// ============================================================================
// Descriptive Statistics Helper Function
// ============================================================================

function descriptiveStats(arr) {
  if (!arr || arr.length === 0) {
    return {
      n: 0,
      mean: NaN,
      median: NaN,
      sd: NaN,
      min: NaN,
      max: NaN,
      q25: NaN,
      q75: NaN,
      iqr: NaN
    };
  }
  
  return {
    n: arr.length,
    mean: mean(arr),
    median: median(arr),
    sd: std(arr),
    min: Math.min(...arr),
    max: Math.max(...arr),
    q25: percentile(arr, 25),
    q75: percentile(arr, 75),
    iqr: iqr(arr)
  };
}

// ============================================================================
// Generate Visualization Data
// ============================================================================

function generateVisualizationData(cbtPre, cbtReject, it, rq1Results, rq2Results) {
  console.log('\n===================================================================');
  console.log('Generating Visualization Data');
  console.log('===================================================================\n');
  
  const vizData = {
    box_plots: {},
    distributions: {},
    scatter_plots: {}
  };
  
  // RQ1: Script Count Box Plot Data
  vizData.box_plots.script_counts = {
    cbt_pre: cbtPre
      .filter(d => d.rq1_dynamic_inclusion?.scripts !== undefined)
      .map(d => d.rq1_dynamic_inclusion.scripts),
    cbt_reject: cbtReject
      .filter(d => d.rq1_dynamic_inclusion?.scripts !== undefined)
      .map(d => d.rq1_dynamic_inclusion.scripts),
    it_pre: it
      .filter(d => d.rq1_dynamic_inclusion?.pre_scripts !== null && d.rq1_dynamic_inclusion?.pre_scripts !== undefined)
      .map(d => d.rq1_dynamic_inclusion.pre_scripts),
    it: it
      .filter(d => d.rq1_dynamic_inclusion?.scripts !== undefined)
      .map(d => d.rq1_dynamic_inclusion.scripts)
  };
  
  // RQ2: Dependency Metrics Box Plot Data
  vizData.box_plots.dependency_metrics = {
    d1_cbt_reject: cbtReject
      .filter(d => d.rq2_dependency_execution?.D1_max_inclusion_depth !== undefined)
      .map(d => d.rq2_dependency_execution.D1_max_inclusion_depth),
    d1_it: it
      .filter(d => d.rq2_dependency_execution?.D1_max_inclusion_depth !== undefined)
      .map(d => d.rq2_dependency_execution.D1_max_inclusion_depth),
    d2_cbt_reject: cbtReject
      .filter(d => d.rq2_dependency_execution?.D2_average_out_degree !== undefined)
      .map(d => d.rq2_dependency_execution.D2_average_out_degree),
    d2_it: it
      .filter(d => d.rq2_dependency_execution?.D2_average_out_degree !== undefined)
      .map(d => d.rq2_dependency_execution.D2_average_out_degree),
    d3_cbt_reject: cbtReject
      .filter(d => d.rq2_dependency_execution?.D3_cross_origin_edge_ratio !== undefined)
      .map(d => d.rq2_dependency_execution.D3_cross_origin_edge_ratio),
    d3_it: it
      .filter(d => d.rq2_dependency_execution?.D3_cross_origin_edge_ratio !== undefined)
      .map(d => d.rq2_dependency_execution.D3_cross_origin_edge_ratio)
  };
  
  // Fix: RQ2 Execution Metrics Box Plot Data (Including E1, E2, E3)
  vizData.box_plots.execution_metrics = {
    e1_cbt_reject: cbtReject
      .filter(d => d.rq2_dependency_execution?.E1_dynamic_code_execution !== undefined)
      .map(d => d.rq2_dependency_execution.E1_dynamic_code_execution),
    e1_it: it
      .filter(d => d.rq2_dependency_execution?.E1_dynamic_code_execution !== undefined)
      .map(d => d.rq2_dependency_execution.E1_dynamic_code_execution),
    e2_cbt_reject: cbtReject
      .filter(d => d.rq2_dependency_execution?.E2_deferred_execution !== undefined)
      .map(d => d.rq2_dependency_execution.E2_deferred_execution),
    e2_it: it
      .filter(d => d.rq2_dependency_execution?.E2_deferred_execution !== undefined)
      .map(d => d.rq2_dependency_execution.E2_deferred_execution),
    e3_cbt_reject: cbtReject
      .filter(d => d.rq2_dependency_execution?.E3_error_rate !== undefined)
      .map(d => d.rq2_dependency_execution.E3_error_rate),
    e3_it: it
      .filter(d => d.rq2_dependency_execution?.E3_error_rate !== undefined)
      .map(d => d.rq2_dependency_execution.E3_error_rate)
  };
  
  console.log('Visualization data preparation complete');
  console.log(`   - Box plot groups: ${Object.keys(vizData.box_plots).length}`);
  console.log(`   - Script count data: ${Object.keys(vizData.box_plots.script_counts).length} groups`);
  console.log(`   - Dependency metrics data: ${Object.keys(vizData.box_plots.dependency_metrics).length} groups`);
  console.log(`   - Execution metrics data: ${Object.keys(vizData.box_plots.execution_metrics).length} groups\n`);
  
  return vizData;
}

// ============================================================================
// Output Results
// ============================================================================

function saveResults(outputDir, rq1Results, rq2Results, vizData) {
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  
  const fullResults = {
    metadata: {
      timestamp: new Date().toISOString(),
      alpha: argv.alpha,
      input_files: {
        cbt_pre: argv.inputCBTPre,
        cbt_reject: argv.inputCBTReject,
        it: argv.inputIT
      },
      note: 'Window aligned version: Both CBT and IT post windows are 30 seconds'
    },
    rq1: rq1Results,
    rq2: rq2Results
  };
  
  fs.writeFileSync(
    path.join(outputDir, 'statistical_results.json'),
    JSON.stringify(fullResults, null, 2),
    'utf-8'
  );
  
  fs.writeFileSync(
    path.join(outputDir, 'visualization_data.json'),
    JSON.stringify(vizData, null, 2),
    'utf-8'
  );
  
  const summary = generateMarkdownSummary(rq1Results, rq2Results);
  fs.writeFileSync(
    path.join(outputDir, 'summary.md'),
    summary,
    'utf-8'
  );
  
  console.log(`\nResults saved to: ${path.resolve(outputDir)}`);
  console.log(`   - statistical_results.json (Complete statistical results)`);
  console.log(`   - visualization_data.json (Visualization data)`);
  console.log(`   - summary.md (Results summary)`);
}

function generateMarkdownSummary(rq1Results, rq2Results) {
  let md = '# Statistical Analysis Results Summary (Window Aligned Version)\n\n';
  md += `Generated: ${new Date().toISOString()}\n\n`;
  md += '**Core Fix**: All data uses 30-second post window, time windows fully aligned\n\n';
  
  md += '## RQ1: Dynamic Inclusion - Scale and Timing Differences\n\n';
  
  md += '### S1: Third-party Script Count\n\n';
  
  if (rq1Results.scale_metrics.s1_pre_comparison) {
    const comp = rq1Results.scale_metrics.s1_pre_comparison;
    md += '#### CBT-Pre vs IT-Pre (Initial Load Comparison)\n\n';
    md += `- CBT-Pre: Mean=${comp.cbt_pre.mean.toFixed(2)}, Median=${comp.cbt_pre.median.toFixed(2)}, SD=${comp.cbt_pre.sd.toFixed(2)}\n`;
    md += `- IT-Pre: Mean=${comp.it_pre.mean.toFixed(2)}, Median=${comp.it_pre.median.toFixed(2)}, SD=${comp.it_pre.sd.toFixed(2)}\n`;
    md += `- Mann-Whitney U: z=${comp.test.z.toFixed(3)}, p=${comp.test.p.toFixed(4)}\n`;
    md += `- Effect size (r): ${comp.effect_size.toFixed(3)}\n`;
    md += `- **${comp.significant ? '[OK] Significant difference' : '[X] No significant difference'}**\n\n`;
  }
  
  if (rq1Results.scale_metrics.s1_reject_vs_it) {
    const comp = rq1Results.scale_metrics.s1_reject_vs_it;
    md += '#### * CBT-Reject vs IT (Core Comparison)\n\n';
    md += `- CBT-Reject: Mean=${comp.cbt_reject.mean.toFixed(2)}, Median=${comp.cbt_reject.median.toFixed(2)}, SD=${comp.cbt_reject.sd.toFixed(2)}\n`;
    md += `- IT: Mean=${comp.it.mean.toFixed(2)}, Median=${comp.it.median.toFixed(2)}, SD=${comp.it.sd.toFixed(2)}\n`;
    md += `- Mann-Whitney U: z=${comp.test.z.toFixed(3)}, p=${comp.test.p.toFixed(4)}\n`;
    md += `- Effect size (r): ${comp.effect_size.toFixed(3)}\n`;
    md += `- **${comp.significant ? '[OK] Significant difference - Violation behavior detected' : '[X] No significant difference - As expected'}**\n\n`;
  }
  
  if (rq1Results.scale_metrics.s1_cbt_internal) {
    const comp = rq1Results.scale_metrics.s1_cbt_internal;
    md += '#### CBT Internal Validation: Pre vs Reject (Paired)\n\n';
    md += `- Paired sites: ${comp.n}\n`;
    md += `- Pre: Mean=${comp.pre.mean.toFixed(2)}, Median=${comp.pre.median.toFixed(2)}\n`;
    md += `- Reject: Mean=${comp.reject.mean.toFixed(2)}, Median=${comp.reject.median.toFixed(2)}\n`;
    md += `- **${comp.significant ? '[OK] Reject significantly increased - Consent mechanism failed' : '[X] No significant increase - Consent mechanism effective'}**\n\n`;
  }
  
  md += '### Timing Metrics\n\n';
  
  if (rq1Results.timing_metrics.t1_comparison) {
    const comp = rq1Results.timing_metrics.t1_comparison;
    md += '#### T1: First Third-party Script Load Time\n\n';
    md += `- CBT-Pre: Mean=${comp.cbt_pre.mean.toFixed(2)}ms, Median=${comp.cbt_pre.median.toFixed(2)}ms\n`;
    md += `- IT-Pre: Mean=${comp.it_pre.mean.toFixed(2)}ms, Median=${comp.it_pre.median.toFixed(2)}ms\n`;
    md += `- **${comp.significant ? '[OK] Significant difference' : '[X] No significant difference'}**\n\n`;
  }
  
  if (rq1Results.growth_metrics?.t3_scripts) {
    const growth = rq1Results.growth_metrics.t3_scripts;
    md += '### T3 Growth Metrics\n\n';
    md += `- Script growth: Mean=${growth.stats.mean.toFixed(2)}, Median=${growth.stats.median.toFixed(2)}\n`;
    md += `- Positive growth sites: ${growth.positive_growth_count} (${(growth.positive_growth_rate*100).toFixed(1)}%)\n\n`;
  }
  
  md += '## RQ2: Dependency Structure and Execution Behavior (CBT-Reject vs IT)\n\n';
  
  md += '### Dependency Graph Structure\n\n';
  
  if (rq2Results.dependency_metrics.d1_comparison) {
    const comp = rq2Results.dependency_metrics.d1_comparison;
    md += '#### D1: Maximum Inclusion Depth\n\n';
    md += `- CBT-Reject: Mean=${comp.cbt_reject.mean.toFixed(2)}, Median=${comp.cbt_reject.median.toFixed(2)}\n`;
    md += `- IT: Mean=${comp.it.mean.toFixed(2)}, Median=${comp.it.median.toFixed(2)}\n`;
    md += `- **${comp.significant ? '[OK] Significant difference - Different dependency structure' : '[X] No significant difference - Similar dependency structure'}**\n\n`;
  }
  
  md += '### Execution Behavior\n\n';
  
  if (rq2Results.execution_metrics.e1_comparison) {
    const comp = rq2Results.execution_metrics.e1_comparison;
    md += '#### E1: Dynamic Code Execution\n\n';
    md += `- CBT-Reject: Mean=${comp.cbt_reject.mean.toFixed(2)}, Median=${comp.cbt_reject.median.toFixed(2)}\n`;
    md += `- IT: Mean=${comp.it.mean.toFixed(2)}, Median=${comp.it.median.toFixed(2)}\n`;
    md += `- **${comp.significant ? '[OK] Significant difference - Different code execution pattern' : '[X] No significant difference - Similar code execution pattern'}**\n\n`;
  }
  
  md += '---\n\n';
  md += '## Key Findings Interpretation\n\n';
  md += '### If CBT-Reject is approximately equal to IT\n';
  md += '- Indicates both modes behave consistently in "no consent" state (as expected)\n';
  md += '- Shows CBT sites correctly implemented consent mechanism\n\n';
  md += '### If CBT-Reject is not equal to IT\n';
  md += '- Indicates systematic differences between the two modes (requires deeper analysis)\n';
  md += '- Possible reason 1: CBT sites still load trackers after rejection in violation\n';
  md += '- Possible reason 2: IT sites themselves preload trackers\n';
  md += '- Possible reason 3: Essential differences in technical implementation paths\n';
  
  return md;
}

// ============================================================================
// Main Process
// ============================================================================

(async () => {
  console.log(`
===========================================================================
          Statistical Analysis and Comparison Tests (Window Aligned - Complete Fix)
          Analyzing CBT-Pre, CBT-Reject, IT Three Independent Datasets
===========================================================================
Input files:
  CBT-Pre:    ${argv.inputCBTPre}
  CBT-Reject: ${argv.inputCBTReject}
  IT:         ${argv.inputIT}
Output dir:   ${argv.output}
Significance: alpha = ${argv.alpha}
===========================================================================
  `);
  
  const { cbtPre, cbtReject, it } = loadDatasets();
  
  const rq1Results = analyzeRQ1(cbtPre, cbtReject, it);
  
  const rq2Results = analyzeRQ2(cbtReject, it);
  
  const vizData = generateVisualizationData(cbtPre, cbtReject, it, rq1Results, rq2Results);
  
  saveResults(argv.output, rq1Results, rq2Results, vizData);
  
  console.log('\nAnalysis complete!\n');
  console.log('Usage:');
  console.log('   node 04_analysis.js \\');
  console.log('     --inputCBTPre=./output/reaggregated/cbt_pre_aggregated.json \\');
  console.log('     --inputCBTReject=./output/reaggregated/cbt_reject_aggregated.json \\');
  console.log('     --inputIT=./output/reaggregated/it_aggregated.json \\');
  console.log('     --output=./output/analysis_results\n');
  
})().catch(e => {
  console.error('Fatal:', e && e.message ? e.message : e);
  process.exit(1);
});