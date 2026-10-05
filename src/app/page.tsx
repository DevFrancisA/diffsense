"use client";

import {
  Activity,
  AlertCircle,
  ArrowDownToLine,
  ArrowUpRight,
  BookOpenText,
  Braces,
  Check,
  ChevronDown,
  CircleHelp,
  Clock3,
  Code2,
  FileCode2,
  GitFork,
  GitPullRequest,
  Layers3,
  LoaderCircle,
  LockKeyhole,
  Play,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
  X,
} from "lucide-react";
import { FormEvent, useEffect, useState } from "react";

type Finding = {
  title: string;
  severity: "critical" | "high" | "medium" | "low";
  file: string;
  line: number;
  explanation: string;
  suggestion: string;
};

type ReviewResult = {
  findings: Finding[];
  contextUsed: number;
  changedFilesIncluded: number;
  contextCommit: string;
  model: string;
  durationMs: number;
};

type TestStep = { action: string; selector: string; value: string; expected: string };
type TestScenario = { title: string; purpose: string; steps: TestStep[] };
type GeneratedPlan = { scenarios: TestScenario[]; dropped?: { title: string; reason: string }[] };
type MetricRange = { min: number; max: number } | null;
type EvaluationSummary = {
  available: boolean;
  message?: string;
  date?: string;
  cohort?: number;
  reviewModel?: string;
  withContext?: {
    runs: { runNumber: number; precision: number | null; recall: number | null; falsePositives: number }[];
    precisionRange: MetricRange;
    recallRange: MetricRange;
  };
  withoutContext?: { runNumber: number; precision: number | null; recall: number | null; falsePositives: number }[];
  manualReview?: { status: string; reason: string };
  regressionEvaluation?: { status: string; reason: string };
  regressions?: { validScenarios: number; detected: number; invalidPlans: number; validPlans: number } | null;
};

function formatPercentRange(range: MetricRange) {
  if (!range) return "—";
  return `${(range.min * 100).toFixed(1)}–${(range.max * 100).toFixed(1)}`;
}

const sampleDiff = `diff --git a/src/api/invoices/[id]/route.ts b/src/api/invoices/[id]/route.ts
index 62e14fc..d0a31b4 100644
--- a/src/api/invoices/[id]/route.ts
+++ b/src/api/invoices/[id]/route.ts
@@ -18,6 +18,11 @@ export async function GET(request: Request, { params }: RouteContext) {
   const { id } = await params;
   const invoice = await db.invoice.findUnique({ where: { id } });
${" "}
+  if (!invoice) {
+    return Response.json({ error: "Invoice not found" }, { status: 404 });
+  }
+
   return Response.json(invoice);
 }`;

export default function Home() {
  const [diff, setDiff] = useState("");
  const [pullRequestUrl, setPullRequestUrl] = useState("");
  const [skipTestFiles, setSkipTestFiles] = useState(true);
  const [result, setResult] = useState<ReviewResult | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [indexing, setIndexing] = useState(false);
  const [indexMessage, setIndexMessage] = useState("");
  const [generatedPlan, setGeneratedPlan] = useState<GeneratedPlan | null>(null);
  const [generatingTests, setGeneratingTests] = useState(false);
  const [planError, setPlanError] = useState("");
  const [testEnvironment, setTestEnvironment] = useState("");
  const [apiReady, setApiReady] = useState<boolean | null>(null);
  const [evaluation, setEvaluation] = useState<EvaluationSummary | null>(null);
  const [activeView, setActiveView] = useState("Review desk");

  useEffect(() => {
    fetch("/api/status")
      .then((response) => response.json())
      .then((status: { ready?: boolean }) => setApiReady(Boolean(status.ready)))
      .catch(() => setApiReady(false));
  }, []);

  useEffect(() => {
    fetch("/api/evaluation/results")
      .then((response) => response.json())
      .then((summary: EvaluationSummary) => setEvaluation(summary))
      .catch(() => setEvaluation({ available: false, message: "Evaluation results unavailable." }));
  }, []);

  async function runReview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setResult(null);

    try {
      const response = await fetch("/api/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ diff, pullRequestUrl, skipTestFiles }),
      });
      const body = (await response.json()) as ReviewResult & { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Review could not be completed.");
      setResult(body);
    } catch (reviewError) {
      setError(
        reviewError instanceof Error ? reviewError.message : "Review could not be completed.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function indexContext() {
    setIndexing(true);
    setIndexMessage("");
    setError("");
    try {
      const response = await fetch("/api/index", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceUrl: pullRequestUrl }),
      });
      const body = (await response.json()) as { repository?: string; chunksIndexed?: number; commitSha?: string; error?: string };
      if (!response.ok) throw new Error(body.error ?? "Repository indexing failed.");
      setIndexMessage(`Indexed ${body.chunksIndexed} context chunks from ${body.repository} at ${body.commitSha?.slice(0, 7)}.`);
      setApiReady(true);
    } catch (indexError) {
      setIndexMessage(indexError instanceof Error ? indexError.message : "Repository indexing failed.");
    } finally {
      setIndexing(false);
    }
  }

  async function generateTests() {
    setGeneratingTests(true);
    setPlanError("");
    setGeneratedPlan(null);
    try {
      const response = await fetch("/api/tests/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ diff, pullRequestUrl, environment: testEnvironment }),
      });
      const body = (await response.json()) as GeneratedPlan & { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Test-plan generation failed.");
      setGeneratedPlan(body);
    } catch (generationError) {
      setPlanError(generationError instanceof Error ? generationError.message : "Test-plan generation failed.");
    } finally {
      setGeneratingTests(false);
    }
  }

  function downloadPlan() {
    if (!generatedPlan) return;
    const file = new Blob([JSON.stringify(generatedPlan, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(file);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "diffsense-playwright-plan.json";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function loadSample() {
    setDiff(sampleDiff.replace("\n++++ b/", "\n+++ b/"));
    setPullRequestUrl("");
    setResult(null);
    setError("");
  }

  const changedFiles = [...new Set(
    diff.match(/^\+\+\+ b\/(.+)$/gm)?.map((path) => path.slice(6)) ?? [],
  )];

  return (
    <main className="app-frame">
      <aside className="sidebar">
        <a className="brand" href="#workspace" aria-label="DiffSense home">
          <span className="brand-mark"><Braces size={19} strokeWidth={2.4} /></span>
          <span className="brand-name">diff<span>sense</span></span>
        </a>

        <div className="workspace-switcher">
          <span className="workspace-avatar">D</span>
          <span className="workspace-copy"><strong>Demo workspace</strong><small>Personal plan</small></span>
          <ChevronDown size={15} />
        </div>

        <div className="nav-label">WORKSPACE</div>
        <nav className="primary-nav" aria-label="Main navigation">
          <button className={`nav-item ${activeView === "Review desk" ? "is-active" : ""}`} aria-label="Review desk" title="Review desk" onClick={() => setActiveView("Review desk")}><Code2 size={17} /><span>Review desk</span><span className="nav-key">1</span></button>
          <button className={`nav-item ${activeView === "Pull requests" ? "is-active" : ""}`} aria-label="Pull requests" title="Pull requests" onClick={() => setActiveView("Pull requests")}><GitPullRequest size={17} /><span>Pull requests</span><span className="nav-count">0</span></button>
          <button className={`nav-item ${activeView === "Evaluations" ? "is-active" : ""}`} aria-label="Evaluations" title="Evaluations" onClick={() => setActiveView("Evaluations")}><Activity size={17} /><span>Evaluations</span></button>
          <button className={`nav-item ${activeView === "Test lab" ? "is-active" : ""}`} aria-label="Test lab" title="Test lab" onClick={() => setActiveView("Test lab")}><ShieldCheck size={17} /><span>Test lab</span></button>
        </nav>

        <div className="nav-label repositories-label">REPOSITORIES <button aria-label="Add repository" title="Add repository"><Plus size={14} /></button></div>
        <button className="repo-empty" onClick={() => document.getElementById("pr-url")?.focus()}>
          <span className="repo-empty-icon"><GitFork size={15} /></span>
          <span><strong>Connect a repository</strong><small>Paste a pull request URL</small></span>
          <ArrowUpRight size={14} />
        </button>

        <div className="sidebar-spacer" />
        <div className="sidebar-note"><span className="note-icon"><CircleHelp size={15} /></span><span>Reviews are suggestions.<br />Verify findings before merging.</span></div>
        <button className="nav-item settings-item" aria-label="Settings" title="Settings" onClick={() => setActiveView("Settings")}><Settings2 size={17} /><span>Settings</span></button>
        <div className="profile-row"><span className="profile-avatar">AF</span><span className="profile-copy"><strong>Anto Francis</strong><small>Local environment</small></span><ChevronDown size={15} /></div>
      </aside>

      <section className="workspace" id="workspace">
        <header className="topbar">
          <div className="breadcrumbs"><span>Workspace</span><span className="breadcrumb-slash">/</span><strong>{activeView}</strong></div>
          <div className="topbar-right">
            <span className={`connection-pill ${apiReady ? "connected" : "disconnected"}`}><i />{apiReady === null ? "Checking setup" : apiReady ? "Review engine ready" : "Setup required"}</span>
            <button className="icon-button" title="Documentation" aria-label="Documentation"><BookOpenText size={17} /></button>
            <button className="icon-button" title="Help" aria-label="Help"><CircleHelp size={17} /></button>
          </div>
        </header>

        <div className="page-content">
          <section className="page-heading">
            <div><div className="eyebrow"><span className="eyebrow-dot" />CODE INTELLIGENCE <span className="eyebrow-divider">/</span> LOCAL</div><h1>Review desk</h1><p>Understand the change. Catch what matters.</p></div>
            <button className="button-secondary" onClick={loadSample}><Play size={15} fill="currentColor" /> Load example diff</button>
          </section>

          <section className="metrics-strip" aria-label="Evaluation metrics">
            <div className="metric-cell"><span className="metric-label">PRECISION · WITH CONTEXT</span><strong>{formatPercentRange(evaluation?.withContext?.precisionRange ?? null)}<small>%</small></strong><span className="metric-foot">{evaluation?.available ? `${evaluation.cohort} BugsJS cases · ${evaluation.withContext?.runs.length} runs` : evaluation ? "No results yet" : "Loading results"}</span></div>
            <div className="metric-cell"><span className="metric-label">RECALL · WITH CONTEXT</span><strong>{formatPercentRange(evaluation?.withContext?.recallRange ?? null)}<small>%</small></strong><span className="metric-foot">{evaluation?.available ? `Range across ${evaluation.withContext?.runs.length} runs` : evaluation ? "No results yet" : "Loading results"}</span></div>
            <div className="metric-cell"><span className="metric-label">REVIEW TIME</span><strong>—<small>min</small></strong><span className="metric-foot"><span className="metric-neutral">Unmeasured</span> · paired human study pending</span></div>
            <div className="metric-cell metric-last"><span className="metric-label">REGRESSION CATCH RATE</span><strong>{evaluation?.regressions ? ((evaluation.regressions.detected / evaluation.regressions.validScenarios) * 100).toFixed(1) : "—"}<small>%</small></strong><span className="metric-foot">{evaluation?.regressions ? `${evaluation.regressions.detected}/${evaluation.regressions.validScenarios} seeded · ${evaluation.regressions.invalidPlans} invalid plans` : <><span className="metric-neutral">Unmeasured</span> · scenarios not run</>}</span></div>
          </section>

          <form className="review-form" onSubmit={runReview}>
            <section className="input-panel panel">
              <div className="panel-heading input-heading">
                <div className="panel-title"><span className="title-icon"><GitPullRequest size={16} /></span><div><h2>Change under review</h2><p>Start with a public pull request or paste a unified diff.</p></div></div>
                <span className="step-indicator"><span>01</span> / 02</span>
              </div>
              <label className="field-label" htmlFor="pr-url">GITHUB REPOSITORY OR PR URL <span>REQUIRED FOR CONTEXT</span></label>
              <div className="url-field"><GitFork size={17} /><input id="pr-url" type="url" required placeholder="https://github.com/owner/repo or /pull/42" value={pullRequestUrl} onChange={(event) => { setPullRequestUrl(event.target.value); setIndexMessage(""); }} /><span className="url-hint">Context source</span></div>
              <div className="index-context-row"><button className="index-button" type="button" onClick={indexContext} disabled={indexing || !pullRequestUrl.trim() || apiReady !== true}>{indexing ? <LoaderCircle size={13} className="spin" /> : <RefreshCw size={13} />}{indexing ? "Indexing repository…" : "Index repository context"}</button><span role="status">{indexMessage || "Required before the first review"}</span></div>
              <label className="skip-tests-toggle"><input type="checkbox" checked={skipTestFiles} onChange={(event) => setSkipTestFiles(event.target.checked)} /> Skip findings in test files</label>
              <div className="field-label diff-label"><span>UNIFIED DIFF</span><span className="diff-label-right"><span>{changedFiles.length || 0} files</span><span className="label-separator">·</span><span>{diff ? `${diff.split("\n").length} lines` : "No diff loaded"}</span></span></div>
              <div className="diff-editor">
                <div className="editor-gutter"><span>⋯</span><span>⋯</span><span>⋯</span><span>⋯</span><span>⋯</span><span>⋯</span><span>⋯</span><span>⋯</span></div>
                <textarea aria-label="Unified diff" spellCheck={false} value={diff} onChange={(event) => setDiff(event.target.value)} placeholder={'Paste a unified diff here, or enter a GitHub pull request URL above.\n\nDiffSense will retrieve repository context before analyzing changed lines.'} />
                {!diff && <div className="editor-watermark"><FileCode2 size={19} /><span>Waiting for a diff</span></div>}
              </div>
              <div className="editor-footer"><span><LockKeyhole size={13} /> Diff content stays in your configured review pipeline</span><button type="button" className="text-button" onClick={() => { setDiff(""); setResult(null); setError(""); }} disabled={!diff}>Clear diff <X size={13} /></button></div>
              <button className="run-button" type="submit" disabled={busy || !pullRequestUrl.trim() || (!diff.trim() && !pullRequestUrl.trim()) || apiReady !== true}>
                {busy ? <LoaderCircle size={16} className="spin" /> : <Sparkles size={16} />}{busy ? "Reviewing change…" : "Analyze change"}<span className="run-shortcut">⌘ ↵</span>
              </button>
              {apiReady === false && <div className="setup-inline"><AlertCircle size={15} /><span>Configure <code>OPENAI_API_KEY</code> and <code>DATABASE_URL</code> to enable reviews. See the setup guide.</span></div>}
              {error && <div className="error-inline" role="alert"><AlertCircle size={15} /><span>{error}</span></div>}
            </section>

            <section className="results-panel panel">
              <div className="panel-heading results-heading"><div className="panel-title"><span className="title-icon result-icon"><Layers3 size={16} /></span><div><h2>Review findings</h2><p>{result ? `${result.findings.length} candidate${result.findings.length === 1 ? "" : "s"} · ${result.model}` : "Issues are grounded in changed lines and repository context."}</p></div></div><span className="step-indicator"><span>02</span> / 02</span></div>
              {result ? <div className="findings-list">
                {result.findings.length === 0 ? <div className="empty-result"><span className="empty-result-icon"><Check size={18} /></span><strong>No actionable findings returned</strong><span>Review the change manually before merging.</span></div> : result.findings.map((finding, index) => <article className="finding-card" key={`${finding.file}:${finding.line}:${index}`}><div className="finding-topline"><span className={`severity severity-${finding.severity}`}>{finding.severity}</span><span className="finding-location"><FileCode2 size={13} />{finding.file}<b>:{finding.line}</b></span><button type="button" className="icon-button finding-action" title="Copy suggested fix" aria-label="Copy suggested fix" onClick={() => navigator.clipboard.writeText(finding.suggestion)}><ArrowDownToLine size={15} /></button></div><h3>{finding.title}</h3><p>{finding.explanation}</p><div className="suggestion-block"><div><TerminalSquare size={13} /> SUGGESTED FIX</div><pre>{finding.suggestion}</pre></div></article>)}
                <div className="result-meta"><span><Search size={13} />{result.contextUsed} context chunks · {result.changedFilesIncluded} full files @ {result.contextCommit.slice(0, 7)}</span><span><Clock3 size={13} />{(result.durationMs / 1000).toFixed(1)}s</span></div>
              </div> : <div className="empty-state"><span className="empty-illustration"><Code2 size={23} /><i /><i /></span><strong>Your review starts here</strong><p>Analyze a pull request or diff to see<br />evidence-linked findings.</p><div className="empty-state-footer"><span><RefreshCw size={13} /> Context retrieval</span><span className="state-pending">waiting</span></div><div className="empty-state-footer"><span><ShieldCheck size={13} /> Regression tests</span><span className="state-pending">waiting</span></div></div>}
            </section>
          </form>

          <section className="evaluation-panel panel">
            <div className="evaluation-copy"><span className="evaluation-mark"><Activity size={16} /></span><div><h2>{evaluation?.available ? "BugsJS review baseline" : "Evidence, not vibes"}</h2><p>{evaluation?.available ? `${evaluation.cohort} pre-labeled cases · ${evaluation.reviewModel} · ${evaluation.date}` : "Score reviews against labeled defects and seeded regressions."}</p></div></div>
            <div className="evaluation-status"><span className="status-dot" />{evaluation?.available ? "Results saved" : evaluation ? "No results yet" : "Loading results"}</div>
            <button className="text-button evaluation-link" type="button" onClick={generateTests} disabled={generatingTests || apiReady !== true || (!diff.trim() && !pullRequestUrl.trim())}>{generatingTests ? <LoaderCircle size={13} className="spin" /> : <ShieldCheck size={14} />}{generatingTests ? "Generating plan…" : "Generate Playwright plan"}</button>
            <input className="test-environment" aria-label="Test environment notes" placeholder="Optional: how the app under test looks (signed-in user, feature flags, …)" value={testEnvironment} onChange={(event) => setTestEnvironment(event.target.value)} />
          </section>

          {planError && <p className="plan-error" role="alert">{planError}</p>}
          {generatedPlan && <section className="generated-plan panel"><div className="generated-plan-header"><div><h2>Regression test plan</h2><p>Structured Playwright actions that assert the pre-change behavior; run against the base build first.{generatedPlan.dropped?.length ? ` ${generatedPlan.dropped.length} invalid scenario${generatedPlan.dropped.length === 1 ? "" : "s"} dropped.` : ""}</p></div><button className="button-secondary" type="button" onClick={downloadPlan}><ArrowDownToLine size={14} /> Download JSON</button></div>{generatedPlan.scenarios.map((scenario) => <article className="plan-scenario" key={scenario.title}><strong>{scenario.title}</strong><p>{scenario.purpose}</p><ol>{scenario.steps.map((step, index) => <li key={`${scenario.title}-${index}`}>{step.action.replace(/[A-Z]/g, (letter) => ` ${letter.toLowerCase()}`)}{step.selector ? ` ${step.selector}` : ""}{step.expected ? ` → ${step.expected}` : step.value ? ` → ${step.value}` : ""}</li>)}</ol></article>)}</section>}

          <footer className="page-footer"><span>DiffSense <b>·</b> private by default</span><span><span className="footer-online" /> Pipeline status: {apiReady ? "ready" : "not configured"}</span><button title="Refresh status" aria-label="Refresh status" onClick={() => { setApiReady(null); fetch("/api/status").then((response) => response.json()).then((status: { ready?: boolean }) => setApiReady(Boolean(status.ready))).catch(() => setApiReady(false)); }}><RefreshCw size={13} /></button></footer>
        </div>
      </section>
    </main>
  );
}
