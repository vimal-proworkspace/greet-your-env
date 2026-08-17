import { formatIstTime } from "@/lib/datetime";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  compileCode,
  getCodeProblem,
  getDebugProblem,
  runCode,
  runCodeWithInput,
  runDebugCode,
  saveCodeDraft,
  saveDebugDraft,
  submitCode,
  submitDebugFix,
  submitRound,
} from "@/lib/student.functions";
import { AppShell, STUDENT_NAV } from "@/components/AppShell";
import { CountdownTimer } from "@/components/CountdownTimer";
import { FloatingTimer } from "@/components/FloatingTimer";
import { ProblemNav } from "@/components/ProblemNav";
import { CompilerOutput } from "@/components/CompilerOutput";
import { TestCaseResults, type TestRun } from "@/components/TestCaseResults";
import { inferStatus, outcomeStatus, type StatusTone } from "@/lib/exec-status";
import { useProctor } from "@/hooks/use-proctor";
import { useLiveSync } from "@/hooks/use-live-sync";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

export const Route = createFileRoute("/_authenticated/problems/$problemId")({
  validateSearch: (search: Record<string, unknown>) => ({
    kind: search["kind"] === "debug" ? ("debug" as const) : ("code" as const),
  }),
  head: () => ({
    meta: [
      { title: "Problem — CodeArena" },
      { name: "description", content: "Solve the problem and submit your code for evaluation." },
      { property: "og:title", content: "Problem — CodeArena" },
      { property: "og:description", content: "Coding problem workspace on CodeArena." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: ProblemPage,
});

type ConsolePanel = {
  status: string;
  tone: StatusTone;
  input: string;
  output: string;
  compileOutput: string;
  error: string;
  durationMs: number;
  memoryKb: number;
  message: string;
};

/** Card shown once the round is submitted, with the next step in the event. */
function SubmissionSuccess({
  roundName,
  nextRound,
}: {
  roundName: string;
  nextRound: { id: string; name: string } | null;
}) {
  const navigate = useNavigate();
  const [confirmNext, setConfirmNext] = useState(false);
  return (
    <div className="surface mb-5 rounded-lg border border-border/70 p-5">
      <Badge>Submission Successful</Badge>
      <p className="mt-3 text-sm text-muted-foreground">
        {roundName} submitted successfully. It has been scored by the server and is now locked.
      </p>
      {nextRound ? (
        <>
          <Button className="mt-4" onClick={() => setConfirmNext(true)}>
            Go to {nextRound.name}
          </Button>
          <AlertDialog open={confirmNext} onOpenChange={setConfirmNext}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Move to {nextRound.name}?</AlertDialogTitle>
                <AlertDialogDescription>
                  Are you sure you want to move to {nextRound.name}? {roundName} stays submitted and
                  locked.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Stay in {roundName}</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() =>
                    void navigate({ to: "/rounds/$roundId", params: { roundId: nextRound.id } })
                  }
                >
                  Go to {nextRound.name}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      ) : (
        <Button asChild className="mt-4">
          <Link to="/results">Finish Competition</Link>
        </Button>
      )}
    </div>
  );
}

function ProblemPage() {
  const { problemId } = Route.useParams();
  const { kind } = Route.useSearch();
  // Keying by problem id gives each problem its own editor state; the code
  // itself is autosaved server-side, so nothing is lost when switching.
  return kind === "debug" ? (
    <DebugWorkspace key={problemId} problemId={problemId} />
  ) : (
    <CodeWorkspace key={problemId} problemId={problemId} />
  );
}

function DebugWorkspace({ problemId }: { problemId: string }) {
  const queryClient = useQueryClient();
  const [code, setCode] = useState<string | null>(null);
  const [panel, setPanel] = useState<ConsolePanel | null>(null);
  const [stdin, setStdin] = useState("");
  const [confirmRound, setConfirmRound] = useState(false);
  const [debugRuns, setDebugRuns] = useState<TestRun[] | undefined>(undefined);


  const q = useQuery({
    queryKey: ["debug-problem", problemId],
    queryFn: () => getDebugProblem({ data: { problemId } }),
    refetchInterval: 20_000,
  });
  const data = q.data;
  const value = code ?? data?.savedCode ?? "";
  const canPlay = Boolean(data?.canPlay);
  const roundId = data?.problem.roundId ?? null;
  const submitted = data?.status === "SUBMITTED" || data?.status === "LOCKED";
  const proctor = useProctor(roundId, canPlay);
  const sync = useLiveSync(roundId);
  const remaining = sync.round?.remainingSeconds ?? data?.remainingSeconds ?? 0;
  const roundState = sync.round?.state ?? data?.round.state ?? "DRAFT";
  useEffect(() => {
    void q.refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roundState]);

  // The server owns the clock; we only render a local countdown from it.
  const endsAt = useMemo(
    () => (remaining > 0 ? new Date(Date.now() + remaining * 1000).toISOString() : null),
    [remaining, data?.status],
  );

  // Autosave the draft so a refresh or navigation never loses work.
  useEffect(() => {
    if (code === null || !canPlay) return;
    const id = setTimeout(() => {
      saveDebugDraft({ data: { problemId, sourceCode: code } }).catch(() => undefined);
    }, 1200);
    return () => clearTimeout(id);
  }, [code, canPlay, problemId]);

  const showResult = (
    usedInput: string,
    result: {
      status: string;
      compiled?: boolean;
      compileOutput: string;
      output: string;
      error: string;
      durationMs: number;
      memoryKb: number;
      serviceAvailable: boolean;
      message: string;
    },
  ) => {
    const status = inferStatus({
      compileOutput: result.compileOutput,
      error: result.error,
      ...(result.compiled === undefined ? {} : { compiled: result.compiled }),
      serviceAvailable: result.serviceAvailable,
      status: result.status,
    });
    setPanel({
      status: status.label,
      tone: status.tone,
      input: usedInput,
      output: result.output,
      compileOutput: result.compileOutput,
      error: result.error,
      durationMs: result.durationMs,
      memoryKb: result.memoryKb,
      message: result.message,
    });
    if (!result.serviceAvailable) toast.error(result.message);
    else toast.message(`${status.label} · ${result.durationMs} ms · ${result.memoryKb} KB`);
  };

  const compile = useMutation({
    mutationFn: () => runDebugCode({ data: { problemId, sourceCode: value, mode: "COMPILE" } }),
    onSuccess: (result) => showResult("", result),
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Could not compile your code."),
  });
  const run = useMutation({
    mutationFn: () => runDebugCode({ data: { problemId, sourceCode: value, mode: "RUN", stdin } }),
    onSuccess: (result) => showResult(stdin, result),
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Could not run your code."),
  });
  const submit = useMutation({
    mutationFn: () => submitDebugFix({ data: { problemId, sourceCode: value } }),
    onSuccess: (result) => {
      toast.success(result.message || "Submission evaluated.");
      // Sample cases show full detail; hidden cases only report pass/fail.
      setDebugRuns(
        result.results.map((r) => ({
          index: r.index,
          passed: r.passed,
          status: r.status,
          actual: r.actual,
          error: r.error,
          durationMs: r.durationMs,
        })),
      );
      queryClient.invalidateQueries({ queryKey: ["debug-problem", problemId] });
      queryClient.invalidateQueries({ queryKey: ["round-play"] });
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Could not submit your fix."),
  });

  const finishRound = useMutation({
    mutationFn: () => submitRound({ data: { roundId: roundId ?? "" } }),
    onSuccess: () => {
      toast.success("Round submitted.");
      queryClient.invalidateQueries({ queryKey: ["debug-problem", problemId] });
      queryClient.invalidateQueries({ queryKey: ["round-play"] });
      queryClient.invalidateQueries({ queryKey: ["student-dashboard"] });
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Could not submit the round."),
  });

  return (
    <AppShell
      nav={STUDENT_NAV}
      title={data?.problem.title ?? "Bug Hunt"}
      subtitle="Fix every bug you can find."
    >
      {q.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : q.isError || !data ? (
        <p className="text-sm text-destructive">
          {q.error instanceof Error ? q.error.message : "Could not load this problem."}
        </p>
      ) : (
        <>
          {submitted ? (
            <SubmissionSuccess roundName={data.round.name} nextRound={data.nextRound} />
          ) : null}

          <ProblemNav
            problems={data.siblings}
            currentId={problemId}
            kind="debug"
            roundLabel={`${data.round.name} — Bug Hunt`}
            finalLabel={`Submit ${data.round.name}`}
            onFinalAction={submitted ? undefined : () => setConfirmRound(true)}
            finalPending={finishRound.isPending}
            finalDisabled={!canPlay}
          />

          <div className="flex flex-wrap items-center justify-between gap-4">
            <p className="font-mono text-sm">
              {data.problem.language} · {data.totalTests} test case(s)
              {data.hiddenTestCount ? ` (${data.hiddenTestCount} hidden)` : ""}
              {data.totalBugs ? ` · ${data.fixedBugs}/${data.totalBugs} bugs fixed` : ""} ·{" "}
              {data.earned}/{data.problem.marks} marks
            </p>
            <CountdownTimer endsAt={endsAt} onExpire={() => q.refetch()} />
          </div>


          {canPlay ? (
            <FloatingTimer
              serverSeconds={remaining}
              state={roundState}
              label="Time left"
              paused={roundState === "PAUSED"}
              onExpire={() => void q.refetch()}
            />
          ) : null}
          {canPlay && !proctor.fullscreen ? (
            <Button
              size="sm"
              variant="outline"
              className="mt-3"
              onClick={proctor.requestFullscreen}
            >
              Enter fullscreen
            </Button>
          ) : null}

          <p className="mt-4 whitespace-pre-wrap text-sm text-muted-foreground">
            {data.problem.description}
          </p>

          {data.problem.expectedBehavior ? (
            <div className="surface mt-4 rounded-lg border border-border/70 p-4">
              <h2 className="text-sm font-semibold">Expected behaviour after your fix</h2>
              <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">
                {data.problem.expectedBehavior}
              </p>
            </div>
          ) : null}

          <TestCaseResults
            tests={data.visibleTests.map((t, i) => ({
              index: i + 1,
              input: t.input,
              expectedOutput: t.expectedOutput,
            }))}
            runs={debugRuns}
            title="Sample test cases"
          />
          {data.hiddenTestCount ? (
            <p className="mt-2 text-xs text-muted-foreground">
              {data.hiddenTestCount} additional hidden test case(s) are used for marking.
            </p>
          ) : null}

          {data.bugs.length ? (
            <>
              <h2 className="mt-6 text-sm font-semibold">Bonus bugs to find</h2>
              <div className="mt-3 space-y-2">
                {data.bugs.map((bug) => (
                  <div
                    key={bug.id}
                    className="surface flex items-center justify-between gap-3 rounded-lg border border-border/70 px-4 py-2"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">
                        {bug.bugCode} · {bug.title}
                      </p>
                      {bug.description ? (
                        <p className="truncate text-xs text-muted-foreground">{bug.description}</p>
                      ) : null}
                    </div>
                    <Badge variant={bug.awarded ? "default" : "secondary"}>
                      {bug.awarded ? `Fixed · ${bug.marks}` : `${bug.marks} marks`}
                    </Badge>
                  </div>
                ))}
              </div>
            </>
          ) : null}



          <Textarea
            className="mt-6 min-h-80 font-mono text-xs"
            value={value}
            onChange={(event) => setCode(event.target.value)}
            disabled={!canPlay}
            spellCheck={false}
          />

          <div className="mt-4 grid gap-2">
            <label className="text-xs font-medium text-muted-foreground" htmlFor="stdin">
              Custom Input (stdin — one value per line, exactly as your scanf() expects)
            </label>
            <Textarea
              id="stdin"
              className="min-h-20 font-mono text-xs"
              placeholder={"10 20"}
              value={stdin}
              onChange={(event) => setStdin(event.target.value)}
              disabled={!canPlay}
              spellCheck={false}
            />
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Button
              variant="outline"
              disabled={!canPlay || compile.isPending}
              onClick={() => compile.mutate()}
            >
              {compile.isPending ? "Compiling…" : "Compile"}
            </Button>
            <Button
              variant="secondary"
              disabled={!canPlay || run.isPending}
              onClick={() => run.mutate()}
            >
              {run.isPending ? "Running…" : "Run"}
            </Button>
            <Button disabled={!canPlay || submit.isPending} onClick={() => submit.mutate()}>
              {submit.isPending ? "Evaluating…" : "Submit fix"}
            </Button>
            <span className="text-xs text-muted-foreground">
              Running never awards marks. Submitting awards each bug only the first time it is
              fixed.
            </span>
          </div>

          {panel ? <CompilerOutput {...panel} /> : null}

          {!canPlay ? (
            <p className="mt-3 text-sm text-muted-foreground">
              {data.gate.reason || "This round is not open for you right now."}
            </p>
          ) : null}

          {data.submissions.length ? (
            <>
              <h2 className="mt-10 text-sm font-semibold">Your submissions</h2>
              <div className="mt-3 space-y-2">
                {data.submissions.map((s) => (
                  <div
                    key={s.id}
                    className="surface flex items-center justify-between gap-4 rounded-lg border border-border/70 px-4 py-2"
                  >
                    <p className="min-w-0 truncate text-xs text-muted-foreground">
                      {formatIstTime(s.createdAt)}
                      {s.testsTotal ? ` · ${s.testsPassed}/${s.testsTotal} tests` : ""} ·{" "}
                      {s.message}
                    </p>
                    <span className="font-mono text-sm">{s.score}</span>

                  </div>
                ))}
              </div>
            </>
          ) : null}

          <AlertDialog open={confirmRound} onOpenChange={setConfirmRound}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Submit {data.round.name}?</AlertDialogTitle>
                <AlertDialogDescription>
                  Your latest code for every problem in this round is evaluated and the round is
                  locked. You cannot return to it afterwards.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={() => finishRound.mutate()}>
                  Submit round
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      )}
    </AppShell>
  );
}

function CodeWorkspace({ problemId }: { problemId: string }) {
  const queryClient = useQueryClient();
  const [code, setCode] = useState<string | null>(null);
  const [language, setLanguage] = useState<string | null>(null);
  const [confirmSubmit, setConfirmSubmit] = useState(false);
  const [confirmRound, setConfirmRound] = useState(false);
  const [customInput, setCustomInput] = useState("");
  const [panel, setPanel] = useState<ConsolePanel | null>(null);
  const [testRuns, setTestRuns] = useState<TestRun[] | undefined>(undefined);

  const q = useQuery({
    queryKey: ["code-problem", problemId],
    queryFn: () => getCodeProblem({ data: { problemId } }),
  });

  const data = q.data;
  const value = code ?? data?.savedCode ?? data?.problem.starterCode ?? "";
  const lang = language ?? data?.languages[0] ?? "C";
  const submitted = data?.status === "SUBMITTED" || data?.status === "LOCKED";
  const roundId = data?.problem.roundId ?? null;

  const codeProctor = useProctor(roundId, Boolean(data?.canPlay));
  const codeSync = useLiveSync(roundId);
  const codeRemaining = codeSync.round?.remainingSeconds ?? data?.remainingSeconds ?? 0;
  const codeRoundState = codeSync.round?.state ?? data?.round.state ?? "DRAFT";
  useEffect(() => {
    void q.refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [codeRoundState]);

  // Autosave to the database so navigating between problems keeps the code.
  const canPlayCode = Boolean(data?.canPlay);
  useEffect(() => {
    if (code === null || !canPlayCode) return;
    const id = setTimeout(() => {
      saveCodeDraft({ data: { problemId, sourceCode: code } }).catch(() => undefined);
    }, 1200);
    return () => clearTimeout(id);
  }, [code, canPlayCode, problemId]);

  const compile = useMutation({
    mutationFn: () => compileCode({ data: { problemId, language: lang, code: value } }),
    onSuccess: (result) => {
      const status = inferStatus({
        compiled: result.compiled,
        serviceAvailable: result.serviceAvailable,
        error: result.error,
      });
      setPanel({
        status: result.compiled && result.serviceAvailable ? "SUCCESS" : status.label,
        tone: status.tone,
        input: "",
        output: result.output,
        compileOutput: result.compileOutput,
        error: result.error,
        durationMs: result.durationMs,
        memoryKb: result.memoryKb,
        message: result.message,
      });
      if (!result.serviceAvailable) toast.error(result.message);
      else if (result.compiled) toast.success("Compilation successful.");
      else toast.error("Compilation failed.");
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Could not compile your code."),
  });

  const custom = useMutation({
    mutationFn: () =>
      runCodeWithInput({ data: { problemId, language: lang, code: value, stdin: customInput } }),
    onSuccess: (result) => {
      const status = result.serviceAvailable
        ? outcomeStatus(result.outcome)
        : ({ label: "EXECUTION ENGINE ERROR", tone: "warn" } as const);
      setPanel({
        status: status.label,
        tone: status.tone,
        input: result.stdin,
        output: result.output,
        compileOutput: result.compileOutput,
        error: result.error,
        durationMs: result.durationMs,
        memoryKb: result.memoryKb,
        message: result.message,
      });
      if (!result.serviceAvailable) toast.error(result.message);
      else toast.message(`${status.label} · ${result.durationMs} ms`);
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Could not run your code."),
  });

  const trial = useMutation({
    mutationFn: () => runCode({ data: { problemId, language: lang, code: value } }),
    onSuccess: (result) => {
      setTestRuns(
        result.results.map((r) => ({
          index: r.index,
          passed: r.passed,
          status: r.status,
          actual: r.actual,
          error: r.error,
          durationMs: r.durationMs,
        })),
      );
      const status = inferStatus({ status: result.status, compileOutput: result.compileOutput });
      setPanel({
        status: result.status === "ACCEPTED" ? "SUCCESS" : status.label,
        tone: result.status === "ACCEPTED" ? "ok" : status.tone,
        input: "(test case inputs — see each test case below)",
        output: result.results.map((r) => r.actual ?? "").join("\n---\n"),
        compileOutput: result.compileOutput,
        error: result.results
          .map((r) => r.error ?? "")
          .filter(Boolean)
          .join("\n"),
        durationMs: result.durationMs,
        memoryKb: result.memoryKb,
        message: `${result.passed}/${result.total} test case(s) passed · ${result.message}`,
      });
      toast.message(`${result.status}: ${result.message}`);
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Could not run your code."),
  });

  const submit = useMutation({
    mutationFn: () => submitCode({ data: { problemId, language: lang, code: value } }),
    onSuccess: (result) => {
      toast.success(`${result.status} · ${result.passed}/${result.total} tests`);
      setTestRuns(
        result.results.map((r) => ({
          index: r.index,
          passed: r.passed,
          status: r.status,
          actual: r.actual,
          error: r.error,
          durationMs: r.durationMs,
        })),
      );
      queryClient.invalidateQueries({ queryKey: ["code-problem", problemId] });
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Could not submit your code."),
  });

  const finishRound = useMutation({
    mutationFn: () => submitRound({ data: { roundId: roundId ?? "" } }),
    onSuccess: () => {
      toast.success("Round submitted.");
      queryClient.invalidateQueries({ queryKey: ["code-problem", problemId] });
      queryClient.invalidateQueries({ queryKey: ["round-play"] });
      queryClient.invalidateQueries({ queryKey: ["student-dashboard"] });
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Could not submit the round."),
  });

  return (
    <AppShell
      nav={STUDENT_NAV}
      title={data?.problem.title ?? "Problem"}
      subtitle="Code Sprint workspace."
    >
      {q.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : q.isError || !data ? (
        <p className="text-sm text-destructive">
          {q.error instanceof Error ? q.error.message : "Could not load this problem."}
        </p>
      ) : (
        <>
          {submitted ? (
            <SubmissionSuccess roundName={data.round.name} nextRound={data.nextRound} />
          ) : null}

          <ProblemNav
            problems={data.siblings}
            currentId={problemId}
            kind="code"
            roundLabel={`${data.round.name} — Code Sprint`}
            finalLabel={`Submit ${data.round.name}`}
            onFinalAction={submitted ? undefined : () => setConfirmRound(true)}
            finalPending={finishRound.isPending}
            finalDisabled={!data.canPlay}
          />

          {data.canPlay ? (
            <FloatingTimer
              serverSeconds={codeRemaining}
              state={codeRoundState}
              label="Time left"
              paused={codeRoundState === "PAUSED"}
              onExpire={() => void q.refetch()}
            />
          ) : null}
          {data.canPlay && !codeProctor.fullscreen ? (
            <Button
              size="sm"
              variant="outline"
              className="mb-4"
              onClick={codeProctor.requestFullscreen}
            >
              Enter fullscreen
            </Button>
          ) : null}
          <p className="whitespace-pre-wrap text-sm text-muted-foreground">
            {data.problem.description}
          </p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <div className="surface rounded-lg border border-border/70 p-4">
              <p className="mono-label text-muted-foreground">Input format</p>
              <p className="mt-2 whitespace-pre-wrap text-xs">{data.problem.inputFormat || "—"}</p>
            </div>
            <div className="surface rounded-lg border border-border/70 p-4">
              <p className="mono-label text-muted-foreground">Output format</p>
              <p className="mt-2 whitespace-pre-wrap text-xs">{data.problem.outputFormat || "—"}</p>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            {data.languages.map((option) => (
              <Button
                key={option}
                size="sm"
                variant={lang === option ? "default" : "outline"}
                onClick={() => setLanguage(option)}
              >
                {option}
              </Button>
            ))}
          </div>

          <Textarea
            className="mt-4 min-h-80 font-mono text-xs"
            value={value}
            onChange={(event) => setCode(event.target.value)}
            disabled={!data.canPlay}
            spellCheck={false}
          />

          <div className="mt-4 grid gap-2">
            <label className="text-xs font-medium text-muted-foreground" htmlFor="custom-input">
              Custom Input (stdin — exactly what your scanf() will read)
            </label>
            <Textarea
              id="custom-input"
              className="min-h-20 font-mono text-xs"
              placeholder={"10 20"}
              value={customInput}
              onChange={(event) => setCustomInput(event.target.value)}
              disabled={!data.canPlay}
              spellCheck={false}
            />
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Button
              variant="outline"
              disabled={!data.canPlay || compile.isPending}
              onClick={() => compile.mutate()}
            >
              {compile.isPending ? "Compiling…" : "Compile"}
            </Button>
            <Button
              variant="secondary"
              disabled={!data.canPlay || custom.isPending}
              onClick={() => custom.mutate()}
            >
              {custom.isPending ? "Running…" : "Run with custom input"}
            </Button>
            <Button
              variant="secondary"
              disabled={!data.canPlay || trial.isPending}
              onClick={() => trial.mutate()}
            >
              {trial.isPending ? "Running…" : "Run test cases"}
            </Button>
            <Button
              disabled={!data.canPlay || submit.isPending}
              onClick={() => setConfirmSubmit(true)}
            >
              {submit.isPending ? "Submitting…" : "Submit solution"}
            </Button>
            <AlertDialog open={confirmSubmit} onOpenChange={setConfirmSubmit}>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Submit this solution?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Your program will be compiled and judged server-side against every configured
                    test case for {data.problem.marks} marks. Make sure this is the version you want
                    graded.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Keep editing</AlertDialogCancel>
                  <AlertDialogAction onClick={() => submit.mutate()}>
                    Submit solution
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>

            <span className="text-xs text-muted-foreground">
              {data.visibleTests.length} test case(s) · {data.problem.marks} marks
            </span>
          </div>

          {panel ? <CompilerOutput {...panel} /> : null}

          <TestCaseResults tests={data.visibleTests} runs={testRuns} title="Test cases" />

          {!data.canPlay ? (
            <p className="mt-3 text-sm text-muted-foreground">{data.gate.reason}</p>
          ) : null}

          <div className="mt-8 space-y-2">
            {data.submissions.map((s) => (
              <div
                key={s.id}
                className="surface flex items-center justify-between rounded-lg border border-border/70 px-5 py-3"
              >
                <span className="text-xs text-muted-foreground">
                  {s.language} · {s.passedTests}/{s.totalTests} ·{" "}
                  {formatIstTime(s.createdAt)}
                </span>
                <span className="font-mono text-sm">
                  {s.status} · {s.score}
                </span>
              </div>
            ))}
          </div>

          <AlertDialog open={confirmRound} onOpenChange={setConfirmRound}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Submit {data.round.name}?</AlertDialogTitle>
                <AlertDialogDescription>
                  This locks the round and finalises your score. Submit your solutions for every
                  problem first.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={() => finishRound.mutate()}>
                  Submit round
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      )}
    </AppShell>
  );
}
