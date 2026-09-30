/**
 * Stats.ts — pure-TypeScript statistics core for the DataScience skill.
 *
 * Zero external dependencies. Everything here is deterministic and unit-tested
 * against known reference values (see DataScience.test.ts). DuckDB does the
 * data movement / aggregation; this module does the inference math that DuckDB
 * has no native primitive for (hypothesis tests, OLS/logistic regression).
 *
 * Special functions (gammaln, betai, gammap) follow the standard Numerical
 * Recipes continued-fraction / series algorithms, which are accurate to ~1e-10
 * across the ranges we exercise.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Special functions
// ─────────────────────────────────────────────────────────────────────────────

/** Log of the gamma function (Lanczos approximation). Valid for x > 0. */
export function gammaln(x: number): number {
  const cof = [
    76.18009172947146, -86.50532032941677, 24.01409824083091,
    -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5,
  ];
  let y = x;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) {
    y += 1;
    ser += cof[j]! / y;
  }
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

/** Continued-fraction expansion for the incomplete beta function. */
function betacf(a: number, b: number, x: number): number {
  const MAXIT = 300;
  const EPS = 3e-12;
  const FPMIN = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/** Regularized incomplete beta function I_x(a, b). */
export function betai(a: number, b: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(
    gammaln(a + b) - gammaln(a) - gammaln(b) + a * Math.log(x) + b * Math.log(1 - x),
  );
  if (x < (a + 1) / (a + b + 2)) return (bt * betacf(a, b, x)) / a;
  return 1 - (bt * betacf(b, a, 1 - x)) / b;
}

/** Series expansion of the regularized lower incomplete gamma P(a, x). */
function gser(a: number, x: number): number {
  const ITMAX = 400;
  const EPS = 3e-12;
  const gln = gammaln(a);
  if (x <= 0) return 0;
  let ap = a;
  let sum = 1 / a;
  let del = sum;
  for (let n = 0; n < ITMAX; n++) {
    ap += 1;
    del *= x / ap;
    sum += del;
    if (Math.abs(del) < Math.abs(sum) * EPS) break;
  }
  return sum * Math.exp(-x + a * Math.log(x) - gln);
}

/** Continued-fraction expansion of the regularized upper incomplete gamma Q(a, x). */
function gcf(a: number, x: number): number {
  const ITMAX = 400;
  const EPS = 3e-12;
  const FPMIN = 1e-300;
  const gln = gammaln(a);
  let b = x + 1 - a;
  let c = 1 / FPMIN;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i <= ITMAX; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = b + an / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return Math.exp(-x + a * Math.log(x) - gln) * h;
}

/** Regularized lower incomplete gamma P(a, x). */
export function gammap(a: number, x: number): number {
  if (x < 0 || a <= 0) return NaN;
  if (x === 0) return 0;
  if (x < a + 1) return gser(a, x);
  return 1 - gcf(a, x);
}

/** Regularized upper incomplete gamma Q(a, x) = 1 - P(a, x). */
export function gammaq(a: number, x: number): number {
  return 1 - gammap(a, x);
}

/** Complementary error function (Numerical Recipes rational approximation). */
export function erfc(x: number): number {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const ans =
    t *
    Math.exp(
      -z * z -
        1.26551223 +
        t *
          (1.00002368 +
            t *
              (0.37409196 +
                t *
                  (0.09678418 +
                    t *
                      (-0.18628806 +
                        t *
                          (0.27886807 +
                            t *
                              (-1.13520398 +
                                t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))),
    );
  return x >= 0 ? ans : 2 - ans;
}

/** Standard normal CDF Φ(z). */
export function normalCdf(z: number): number {
  return 0.5 * erfc(-z / Math.SQRT2);
}

// ─────────────────────────────────────────────────────────────────────────────
// Distribution tail probabilities (p-values)
// ─────────────────────────────────────────────────────────────────────────────

/** Two-tailed p-value for a Student-t statistic with `df` degrees of freedom. */
export function tDistTwoTailedP(t: number, df: number): number {
  if (!isFinite(t)) return 0;
  if (df <= 0) return NaN;
  return betai(df / 2, 0.5, df / (df + t * t));
}

/** Upper-tail p-value for an F statistic (df1 numerator, df2 denominator). */
export function fDistP(f: number, df1: number, df2: number): number {
  if (f <= 0) return 1;
  if (df1 <= 0 || df2 <= 0) return NaN;
  return betai(df2 / 2, df1 / 2, df2 / (df2 + df1 * f));
}

/** Upper-tail p-value for a chi-square statistic with `df` degrees of freedom. */
export function chiSquareP(chi2: number, df: number): number {
  if (chi2 <= 0) return 1;
  if (df <= 0) return NaN;
  return gammaq(df / 2, chi2 / 2);
}

// ─────────────────────────────────────────────────────────────────────────────
// Descriptive statistics
// ─────────────────────────────────────────────────────────────────────────────

export interface Describe {
  n: number;
  mean: number;
  std: number; // sample standard deviation (n-1)
  variance: number;
  min: number;
  max: number;
  median: number;
  q1: number;
  q3: number;
  skewness: number;
  kurtosis: number; // excess kurtosis (normal = 0)
}

export function mean(xs: number[]): number {
  if (xs.length === 0) return NaN;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/** Sample variance (denominator n-1). */
export function variance(xs: number[]): number {
  const n = xs.length;
  if (n < 2) return NaN;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) * (x - m);
  return s / (n - 1);
}

export function std(xs: number[]): number {
  return Math.sqrt(variance(xs));
}

/** Linear-interpolated quantile (matches DuckDB quantile_cont / numpy default). */
export function quantile(sorted: number[], q: number): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  if (n === 1) return sorted[0]!;
  const pos = (n - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo]!;
  const frac = pos - lo;
  return sorted[lo]! * (1 - frac) + sorted[hi]! * frac;
}

export function describe(xs: number[]): Describe {
  const n = xs.length;
  const sorted = [...xs].sort((a, b) => a - b);
  const m = mean(xs);
  const v = variance(xs);
  const sd = Math.sqrt(v);
  // Skewness & excess kurtosis (population moment estimators, matches scipy defaults).
  let m2 = 0;
  let m3 = 0;
  let m4 = 0;
  for (const x of xs) {
    const d = x - m;
    m2 += d * d;
    m3 += d * d * d;
    m4 += d * d * d * d;
  }
  m2 /= n;
  m3 /= n;
  m4 /= n;
  const skewness = m2 > 0 ? m3 / Math.pow(m2, 1.5) : 0;
  const kurtosis = m2 > 0 ? m4 / (m2 * m2) - 3 : 0;
  return {
    n,
    mean: m,
    std: sd,
    variance: v,
    min: sorted[0]!,
    max: sorted[n - 1]!,
    median: quantile(sorted, 0.5),
    q1: quantile(sorted, 0.25),
    q3: quantile(sorted, 0.75),
    skewness,
    kurtosis,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Hypothesis tests
// ─────────────────────────────────────────────────────────────────────────────

export interface TestResult {
  test: string;
  statistic: number;
  df: number | string;
  pValue: number;
  effect?: { name: string; value: number };
  detail?: Record<string, number | string>;
}

/** Welch's two-sample t-test (does NOT assume equal variances). Two-tailed. */
export function welchTTest(a: number[], b: number[]): TestResult {
  const na = a.length;
  const nb = b.length;
  const ma = mean(a);
  const mb = mean(b);
  const va = variance(a);
  const vb = variance(b);
  const sa = va / na;
  const sb = vb / nb;
  const t = (ma - mb) / Math.sqrt(sa + sb);
  // Welch–Satterthwaite degrees of freedom.
  const df =
    Math.pow(sa + sb, 2) /
    (Math.pow(sa, 2) / (na - 1) + Math.pow(sb, 2) / (nb - 1));
  // Cohen's d using pooled standard deviation.
  const pooledSd = Math.sqrt(
    ((na - 1) * va + (nb - 1) * vb) / (na + nb - 2),
  );
  const d = pooledSd > 0 ? (ma - mb) / pooledSd : 0;
  return {
    test: "Welch two-sample t-test",
    statistic: t,
    df,
    pValue: tDistTwoTailedP(t, df),
    effect: { name: "Cohen's d", value: d },
    detail: { meanA: ma, meanB: mb, nA: na, nB: nb },
  };
}

/** One-sample t-test against a hypothesized population mean `mu`. Two-tailed. */
export function oneSampleTTest(xs: number[], mu: number): TestResult {
  const n = xs.length;
  const m = mean(xs);
  const sd = std(xs);
  const t = (m - mu) / (sd / Math.sqrt(n));
  const df = n - 1;
  return {
    test: "One-sample t-test",
    statistic: t,
    df,
    pValue: tDistTwoTailedP(t, df),
    effect: { name: "Cohen's d", value: sd > 0 ? (m - mu) / sd : 0 },
    detail: { mean: m, mu, n },
  };
}

/** One-way ANOVA across `groups` (2+ groups). */
export function oneWayAnova(groups: number[][]): TestResult {
  const k = groups.length;
  const all = groups.flat();
  const grandMean = mean(all);
  const nTotal = all.length;
  let ssBetween = 0;
  let ssWithin = 0;
  for (const g of groups) {
    const gm = mean(g);
    ssBetween += g.length * Math.pow(gm - grandMean, 2);
    for (const x of g) ssWithin += Math.pow(x - gm, 2);
  }
  const dfBetween = k - 1;
  const dfWithin = nTotal - k;
  const msBetween = ssBetween / dfBetween;
  const msWithin = ssWithin / dfWithin;
  const f = msBetween / msWithin;
  const ssTotal = ssBetween + ssWithin;
  return {
    test: "One-way ANOVA",
    statistic: f,
    df: `${dfBetween}, ${dfWithin}`,
    pValue: fDistP(f, dfBetween, dfWithin),
    effect: { name: "eta-squared", value: ssTotal > 0 ? ssBetween / ssTotal : 0 },
    detail: { groups: k, nTotal },
  };
}

/** Pearson correlation coefficient with a two-tailed significance test. */
export function pearson(x: number[], y: number[]): TestResult & { r: number } {
  const n = x.length;
  const mx = mean(x);
  const my = mean(y);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i]! - mx;
    const dy = y[i]! - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  const r = sxy / Math.sqrt(sxx * syy);
  const df = n - 2;
  // t = r * sqrt(df / (1 - r^2)); guard against |r| == 1.
  const denom = 1 - r * r;
  const t = denom <= 0 ? Infinity * Math.sign(r) : r * Math.sqrt(df / denom);
  return {
    r,
    test: "Pearson correlation",
    statistic: t,
    df,
    pValue: denom <= 0 ? 0 : tDistTwoTailedP(t, df),
    effect: { name: "r", value: r },
    detail: { n },
  };
}

/**
 * Chi-square test of independence on a contingency table (rows × cols of
 * observed counts). Returns the statistic, df, p-value, and Cramér's V.
 */
export function chiSquareIndependence(observed: number[][]): TestResult {
  const nRows = observed.length;
  const nCols = observed[0]!.length;
  const rowSums = observed.map((row) => row.reduce((s, v) => s + v, 0));
  const colSums: number[] = new Array(nCols).fill(0);
  let total = 0;
  for (let i = 0; i < nRows; i++) {
    for (let j = 0; j < nCols; j++) {
      colSums[j]! += observed[i]![j]!;
      total += observed[i]![j]!;
    }
  }
  let chi2 = 0;
  for (let i = 0; i < nRows; i++) {
    for (let j = 0; j < nCols; j++) {
      const expected = (rowSums[i]! * colSums[j]!) / total;
      if (expected > 0) {
        const diff = observed[i]![j]! - expected;
        chi2 += (diff * diff) / expected;
      }
    }
  }
  const df = (nRows - 1) * (nCols - 1);
  const minDim = Math.min(nRows, nCols) - 1;
  const cramersV = minDim > 0 ? Math.sqrt(chi2 / (total * minDim)) : 0;
  return {
    test: "Chi-square test of independence",
    statistic: chi2,
    df,
    pValue: chiSquareP(chi2, df),
    effect: { name: "Cramér's V", value: cramersV },
    detail: { rows: nRows, cols: nCols, n: total },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Linear algebra (for regression)
// ─────────────────────────────────────────────────────────────────────────────

/** Invert a square matrix via Gauss-Jordan elimination. Returns null if singular. */
export function invert(matrix: number[][]): number[][] | null {
  const n = matrix.length;
  // Augment [A | I].
  const a = matrix.map((row, i) => [
    ...row,
    ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)),
  ]);
  for (let col = 0; col < n; col++) {
    // Partial pivot.
    let pivotRow = col;
    let maxVal = Math.abs(a[col]![col]!);
    for (let r = col + 1; r < n; r++) {
      const v = Math.abs(a[r]![col]!);
      if (v > maxVal) {
        maxVal = v;
        pivotRow = r;
      }
    }
    if (maxVal < 1e-12) return null; // singular
    [a[col], a[pivotRow]] = [a[pivotRow]!, a[col]!];
    const pivot = a[col]![col]!;
    for (let j = 0; j < 2 * n; j++) a[col]![j]! /= pivot;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = a[r]![col]!;
      if (factor === 0) continue;
      for (let j = 0; j < 2 * n; j++) a[r]![j]! -= factor * a[col]![j]!;
    }
  }
  return a.map((row) => row.slice(n));
}

function matVec(m: number[][], v: number[]): number[] {
  return m.map((row) => row.reduce((s, x, j) => s + x * v[j]!, 0));
}

// ─────────────────────────────────────────────────────────────────────────────
// Regression
// ─────────────────────────────────────────────────────────────────────────────

export interface Coefficient {
  name: string;
  estimate: number;
  stdError: number;
  statistic: number; // t (linear) or z (logistic)
  pValue: number;
}

export interface LinearModel {
  type: "linear";
  coefficients: Coefficient[];
  rSquared: number;
  adjRSquared: number;
  fStatistic: number;
  fPValue: number;
  residualStdError: number;
  n: number;
  df: number;
}

export interface LogisticModel {
  type: "logistic";
  coefficients: Coefficient[];
  logLikelihood: number;
  accuracy: number;
  iterations: number;
  converged: boolean;
  n: number;
}

/**
 * Ordinary least squares. `X` rows are observations of the feature vector
 * (WITHOUT the intercept column — it is added automatically). `names` are the
 * feature names in column order. Returns full inferential summary.
 */
export function linearRegression(
  X: number[][],
  y: number[],
  names: string[],
): LinearModel {
  const n = X.length;
  // Design matrix with leading intercept column.
  const design = X.map((row) => [1, ...row]);
  const p = design[0]!.length; // params incl. intercept
  const Xt = transpose(design);
  const XtX = matMul(Xt, design);
  const XtXinv = invert(XtX);
  if (!XtXinv) throw new Error("Singular design matrix (collinear features?)");
  const Xty = matVec(Xt, y);
  const beta = matVec(XtXinv, Xty);

  // Residuals and sums of squares.
  const yHat = matVec(design, beta);
  let sse = 0;
  for (let i = 0; i < n; i++) sse += Math.pow(y[i]! - yHat[i]!, 2);
  const yMean = mean(y);
  let sst = 0;
  for (const yi of y) sst += Math.pow(yi - yMean, 2);
  const dfResid = n - p;
  const sigma2 = sse / dfResid;
  const residualStdError = Math.sqrt(sigma2);
  const rSquared = sst > 0 ? 1 - sse / sst : 0;
  const adjRSquared = 1 - (1 - rSquared) * ((n - 1) / dfResid);

  const allNames = ["(Intercept)", ...names];
  const coefficients: Coefficient[] = beta.map((b, j) => {
    const se = Math.sqrt(sigma2 * XtXinv[j]![j]!);
    const t = b / se;
    return {
      name: allNames[j]!,
      estimate: b,
      stdError: se,
      statistic: t,
      pValue: tDistTwoTailedP(t, dfResid),
    };
  });

  const dfModel = p - 1;
  const fStatistic = dfModel > 0 ? (rSquared / dfModel) / ((1 - rSquared) / dfResid) : NaN;
  const fPValue = dfModel > 0 ? fDistP(fStatistic, dfModel, dfResid) : NaN;

  return {
    type: "linear",
    coefficients,
    rSquared,
    adjRSquared,
    fStatistic,
    fPValue,
    residualStdError,
    n,
    df: dfResid,
  };
}

function transpose(m: number[][]): number[][] {
  const rows = m.length;
  const cols = m[0]!.length;
  const t: number[][] = Array.from({ length: cols }, () => new Array(rows).fill(0));
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) t[j]![i] = m[i]![j]!;
  }
  return t;
}

function matMul(a: number[][], b: number[][]): number[][] {
  const n = a.length;
  const m = b[0]!.length;
  const k = b.length;
  const out: number[][] = Array.from({ length: n }, () => new Array(m).fill(0));
  for (let i = 0; i < n; i++) {
    for (let l = 0; l < k; l++) {
      const ail = a[i]![l]!;
      if (ail === 0) continue;
      for (let j = 0; j < m; j++) out[i]![j]! += ail * b[l]![j]!;
    }
  }
  return out;
}

function sigmoid(z: number): number {
  if (z >= 0) return 1 / (1 + Math.exp(-z));
  const e = Math.exp(z);
  return e / (1 + e);
}

/**
 * Binary logistic regression fit by iteratively reweighted least squares
 * (Newton–Raphson). `y` must be 0/1. Reports Wald z-tests and standard errors
 * from the inverse Fisher information at the solution.
 */
export function logisticRegression(
  X: number[][],
  y: number[],
  names: string[],
  maxIter = 50,
): LogisticModel {
  const n = X.length;
  const design = X.map((row) => [1, ...row]);
  const p = design[0]!.length;
  let beta = new Array(p).fill(0);
  const Xt = transpose(design);
  let converged = false;
  let iter = 0;
  let lastCov: number[][] | null = null;

  for (; iter < maxIter; iter++) {
    const eta = matVec(design, beta);
    const mu = eta.map(sigmoid);
    // Weights w = mu(1-mu), clipped to avoid singular Hessian on separation.
    const w = mu.map((m) => Math.max(m * (1 - m), 1e-8));
    // Working response z = eta + (y - mu)/w.
    const z = eta.map((e, i) => e + (y[i]! - mu[i]!) / w[i]!);
    // Solve (X'WX) beta = X'W z.
    const XtW: number[][] = Xt.map((row) => row.map((v, i) => v * w[i]!));
    const XtWX = matMul(XtW, design);
    const XtWz = matVec(XtW, z);
    const inv = invert(XtWX);
    if (!inv) break;
    lastCov = inv;
    const newBeta = matVec(inv, XtWz);
    let delta = 0;
    for (let j = 0; j < p; j++) delta += Math.abs(newBeta[j]! - beta[j]!);
    beta = newBeta;
    if (delta < 1e-8) {
      converged = true;
      iter++;
      break;
    }
  }

  // Final covariance for standard errors.
  const eta = matVec(design, beta);
  const mu = eta.map(sigmoid);
  if (!lastCov) {
    const w = mu.map((m) => Math.max(m * (1 - m), 1e-8));
    const XtW: number[][] = Xt.map((row) => row.map((v, i) => v * w[i]!));
    lastCov = invert(matMul(XtW, design));
  }

  const allNames = ["(Intercept)", ...names];
  const coefficients: Coefficient[] = beta.map((b, j) => {
    const se = lastCov ? Math.sqrt(Math.abs(lastCov[j]![j]!)) : NaN;
    const zStat = b / se;
    return {
      name: allNames[j]!,
      estimate: b,
      stdError: se,
      statistic: zStat,
      pValue: 2 * (1 - normalCdf(Math.abs(zStat))),
    };
  });

  let logLik = 0;
  let correct = 0;
  for (let i = 0; i < n; i++) {
    const pi = Math.min(Math.max(mu[i]!, 1e-12), 1 - 1e-12);
    logLik += y[i]! * Math.log(pi) + (1 - y[i]!) * Math.log(1 - pi);
    const pred = mu[i]! >= 0.5 ? 1 : 0;
    if (pred === y[i]!) correct++;
  }

  return {
    type: "logistic",
    coefficients,
    logLikelihood: logLik,
    accuracy: correct / n,
    iterations: iter,
    converged,
    n,
  };
}
