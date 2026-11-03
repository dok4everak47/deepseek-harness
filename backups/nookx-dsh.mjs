// NookX managed Agent plugin v1
// DeepSeek Harness Cordis adapter, based on the public contracts at
// deepseek-ai/deepseek-harness 5badb15009ae1756c3afe0ae0cef1faafc290ccc.
// Only the independent Helper performs NookX I/O. Native policy and execution
// remain in Harness. No dependencies, shell commands, or reasoning capture.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";

const NOOKX_HELPER = "/Applications/NookX Helper.app/Contents/MacOS/NookX Helper";
export const name = "nookx-agent";

function bridge(payload, timeout = 3000) {
  let child, settled = false, finish;
  const promise = new Promise(resolve => { finish = resolve; });
  const settle = value => { if (!settled) { settled = true; finish(value); } };
  try {
    const input = JSON.stringify(payload);
    if (Buffer.byteLength(input) > 256 * 1024) throw new Error("Oversized hook");
    child = execFile(NOOKX_HELPER, ["--agent-hook", "dsh", "--event", payload.hook_event_name],
      { timeout, killSignal: "SIGKILL", maxBuffer: 524288 }, (error, stdout) => {
        if (error) { settle(null); return; }
        try { const value = JSON.parse(stdout); settle(value && typeof value === "object" && !Array.isArray(value) ? value : null); }
        catch { settle(null); }
      });
    child.stdin?.on("error", () => settle(null));
    child.stdin?.end(input);
  } catch { settle(null); }
  return { promise, cancel() { settle(null); try { child?.kill("SIGKILL"); } catch {} } };
}
function publicText(content) {
  return Array.isArray(content) ? content.filter(b => b?.type === "text" && typeof b.text === "string").map(b => b.text).join("\n").slice(0, 16000) : "";
}

export function apply(ctx) {
  let disposed = false, tail = Promise.resolve(), queued = 0;
  const sessions = new Map(), agents = new Map(), parents = new Map(), calls = new Map(), pending = new Set();
  const generations = new WeakMap();
  const descriptors = new WeakMap();
  function remember(session) {
    if (session && typeof session.id === "string" && session.id.length <= 900) {
      sessions.set(session.id, session);
      if (sessions.size > 512) { const oldest = sessions.keys().next().value; sessions.delete(oldest); parents.delete(oldest); }
      return session;
    }
  }
  function base(session) {
    if (!remember(session)) return null;
    let root = session, seen = new Set([session.id]);
    while (parents.get(root.id)) {
      const parent = parents.get(root.id);
      if (seen.has(parent) || seen.size > 32) return null;
      seen.add(parent);
      root = sessions.get(parent) ?? { id: parent, header: {} };
    }
    const agent = agents.get(session.id);
    const descriptor = descriptors.get(session);
    return { session_id: root.id, cwd: session.header?.cwd ?? root.header?.cwd ?? "",
      ...(root.id !== session.id ? { agent_id: session.id, parent_agent_id: parents.get(session.id) === root.id ? undefined : parents.get(session.id),
        agent_name: session.header?.agentPreset ?? "DeepSeek", subagent_type: session.header?.agentPreset,
        description: descriptor?.label, subagent_mode: descriptor?.mode } : {}),
      model: agent?.options?.model, reasoning_effort: agent?.options?.reasoningEffort };
  }
  function emit(session, event, extra = {}) {
    const fields = base(session);
    if (!fields || disposed || queued >= 256) return;
    queued++;
    tail = tail.then(async () => {
      if (disposed) return;
      const job = bridge({ ...fields, ...extra, hook_event_name: event });
      pending.add(job); try { await job.promise; } finally { pending.delete(job); }
    }).catch(() => {}).finally(() => { queued--; });
  }
  function cancelSession(id) {
    const session = sessions.get(id);
    if (session) generations.set(session, (generations.get(session) ?? 0) + 1);
    for (const job of pending) if (job.sessionID === id) { job.cancelled = true; job.cancel(); }
    for (const [key, exec] of calls) if (exec.agent?.session?.id === id) calls.delete(key);
  }
  const key = (agent, callId) => JSON.stringify([agent?.session?.id, callId]);
  async function request(agent, signal, extra) {
    const fields = base(agent?.session);
    if (!fields || disposed || signal?.aborted) return null;
    const generation = generations.get(agent.session) ?? 0;
    await tail;
    if (disposed || signal?.aborted) return null;
    if (generation !== (generations.get(agent.session) ?? 0)) return { cancelled: true };
    const job = bridge({ ...fields, ...extra, hook_event_name: "PermissionRequest" }, 86400000);
    job.sessionID = agent.session.id;
    pending.add(job);
    const abort = () => job.cancel();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    try { const result = await job.promise; return job.cancelled ? { cancelled: true } : result?.hookSpecificOutput?.decision ?? null; }
    finally { signal?.removeEventListener("abort", abort); pending.delete(job); }
  }
  async function delegate(req, next, kind) {
    if (kind === "permission") return next();
    const session = req.agent?.session, generation = session ? generations.get(session) ?? 0 : 0;
    const callId = req.callId ?? req.wait?.callId ?? randomUUID();
    emit(session, "Notification", { native_response_kind: kind, tool_use_id: callId,
      tool_name: req.toolName ?? "AskUserQuestion", message: req.reason ?? (Array.isArray(req.questions) ? req.questions.map(q => q?.question ?? "").join("\n") : "") });
    try { return await next(); }
    finally {
      if (session && !disposed && generation === (generations.get(session) ?? 0)) {
        emit(session, "NativeResponseResolved", { tool_use_id: callId, tool_name: req.toolName ?? "AskUserQuestion" });
      }
    }
  }

  ctx.on("session/created", session => { remember(session); });
  ctx.on("agent/created", ({ agent }) => {
    if (!remember(agent?.session)) return;
    agents.set(agent.session.id, agent);
    if (agents.size > 512) agents.delete(agents.keys().next().value);
    // Subagent parent linkage now lives on the session header; the runtime
    // ownership tree that isOwnedBy() queried was removed in v0.2.1-rc.3. A
    // subagent Session records its direct creator's id in parentSession.
    const parentId = agent.session?.header?.parentSession;
    parents.set(agent.id, parentId);
    emit(agent.session, parentId ? "SubagentStart" : "SessionStart");
  });
  // Durable turn boundaries are authoritative; agent/status idle alone is not
  // proof of completion. The later human message supplies the actual prompt.
  ctx.on("session/event", (session, event) => {
    if (event?.type === "subagent/descriptor" && event.data?.version === 3
        && ["one-shot", "continuable"].includes(event.data.mode) && parents.get(session.id)) {
      descriptors.set(session, { mode: event.data.mode, label: typeof event.data.label === "string" ? event.data.label.slice(0, 4096) : undefined });
      emit(session, "SubagentStart");
    } else if (event?.type === "turn/start") {
      emit(session, "UserPromptSubmit");
    } else if (event?.type === "user/message" && event.data?.source?.kind === "user") {
      const prompt = publicText(event.data.content);
      if (prompt) emit(session, "UserPromptSubmit", { prompt });
    } else if (event?.type === "assistant/message") {
      const text = publicText(event.data?.message?.content);
      if (text) emit(session, "afterAgentResponse", { text, model: event.data?.message?.source?.model });
    } else if (event?.type === "turn/end") {
      cancelSession(session.id);
      const kind = event.data?.reason?.kind;
      emit(session, kind === "completed" ? "Stop" : kind === "error" ? "StopFailure" : "Interrupt");
    }
  });
  ctx.on("tools/pre-execute", (exec, next) => {
    if (exec.agent?.session) {
      calls.set(key(exec.agent, exec.callId), exec);
      if (calls.size > 1024) calls.delete(calls.keys().next().value);
      emit(exec.agent.session, "PreToolUse", { tool_name: exec.name, tool_use_id: exec.callId, tool_input: exec.arguments });
    }
    return next();
  }, { prepend: true });
  ctx.on("tools/result", (exec, result) => {
    calls.delete(key(exec.agent, exec.callId));
    emit(exec.agent?.session, result.isError ? "PostToolUseFailure" : "PostToolUse", {
      tool_name: exec.name, tool_use_id: exec.callId, tool_input: exec.arguments,
      tool_response: publicText(result.content) });
  });
  ctx.on("approval/request", async (req, next) => {
    const exec = calls.get(key(req.agent, req.callId));
    const decision = await request(req.agent, req.signal, { tool_name: req.toolName,
      tool_use_id: req.callId ?? randomUUID(), tool_input: { ...(exec?.arguments && typeof exec.arguments === "object" ? exec.arguments : {}),
        ...(req.reason ? { reason: req.reason } : {}) } });
    if (req.signal?.aborted || decision?.cancelled) return "cancelled";
    if (disposed) return "unavailable";
    if (decision?.behavior === "allow") return "allowed-once";
    if (decision?.behavior === "deny") return "rejected";
    return delegate(req, next, "permission");
  }, { prepend: true });
  ctx.on("user-questions/request", async (req, next) => {
    // Timed questions need the native claim/late-answer stream, not an
    // independent indefinite waiter. Preserve native ownership for these.
    const native = () => delegate(req, next, "question");
    if (req.wait?.timed || !req.agent || !Array.isArray(req.questions) || !req.questions.length || req.questions.length > 8) return native();
    if (req.questions.some(q => !q || typeof q.question !== "string" || !q.question || (q.detail !== undefined && typeof q.detail !== "string"))) return native();
    const ids = new Set();
    const questions = req.questions.map(q => ({ ...q, question: q.question + (q.detail ? "\n\n" + q.detail : "") }));
    if (questions.some(q => typeof q.id !== "string" || ids.has(q.id) || !ids.add(q.id) || typeof q.question !== "string" || q.question.length > 4096
      || (q.options && (!Array.isArray(q.options) || q.options.length > 20 || q.options.some(o => !o || typeof o.label !== "string" || !o.label)
        || new Set(q.options.map(o => o.label)).size !== q.options.length)))) return native();
    const decision = await request(req.agent, req.signal, { tool_name: "AskUserQuestion", tool_use_id: req.wait?.callId ?? randomUUID(), tool_input: { questions } });
    if (req.signal?.aborted || disposed || decision?.cancelled) throw req.signal?.reason ?? new Error("NookX question cancelled");
    if (decision?.behavior === "deny") return { answers: [] };
    if (decision?.behavior !== "allow" || !Array.isArray(decision.nookxAnswers)) return native();
    const answers = decision.nookxAnswers;
    if (answers.length !== questions.length || answers.some((a, i) => a.id !== questions[i].id || !Array.isArray(a.selected)
      || (!questions[i].multiSelect && a.selected.length > 1)
      || a.selected.some(label => !questions[i].options?.some(o => o.label === label))
      || (a.custom !== undefined && typeof a.custom !== "string") || new Set(a.selected).size !== a.selected.length
      || (!a.selected.length && !a.custom?.trim()))) return native();
    return { answers };
  }, { prepend: true });
  ctx.on("agent/disposed", ({ agent }) => {
    cancelSession(agent.id);
    emit(agent.session, parents.get(agent.id) ? "SubagentStop" : "SessionEnd");
    agents.delete(agent.id);
  });
  ctx.on("session/disposed", session => { cancelSession(session.id); sessions.delete(session.id); parents.delete(session.id); });
  ctx.effect(() => () => {
    disposed = true;
    for (const job of pending) job.cancel();
    pending.clear(); sessions.clear(); agents.clear(); parents.clear(); calls.clear();
  });
}
