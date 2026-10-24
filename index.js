/**
 * Host half of the "fork to workspace" bundle.
 *
 * Implements one operation — copy a conversation's exact event prefix into a
 * new Session whose recorded working directory is a different registered
 * Workspace — and exposes it through both callers:
 *   - the human `/fork-to-workspace <workspace>` command (used by the sidebar UI)
 *   - the `fork_conversation_to_workspace` agent tool
 *
 * The operation mirrors the shipped `session.fork` semantics: it cuts at the
 * latest completed turn by default, closes an open tail with `forked` closers,
 * preserves lineage (`parentSession`), and increments an inherited title.
 *
 * This module deliberately imports only Node built-ins: a locally linked
 * bundle lives outside the profile's package tree, where the Harness package
 * resolver does not reach.
 */
import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'

/** Cordis plugin name. */
export const name = 'workspace-fork'

/** Required Host services. Optional peers (presets, titles) are looked up per call. */
export const inject = ['agents', 'sessionQuery', 'workspaceRegistry', 'commands', 'tools', 'agentDefaultModel']

/** Recovery code for a recorded tool call whose completed outcome was not recorded. */
const TOOL_OUTCOME_UNKNOWN = 'TOOL_OUTCOME_UNKNOWN'

/** Recovery code for an assistant tool request that never reached a recorded call start. */
const TOOL_NOT_STARTED = 'TOOL_NOT_STARTED'

/** Synthetic tool-result wording for a branch, split by whether the call started. */
const CLOSER_TEXT = {
  started: 'The history inherited by this branch records this tool call starting but does not include its result. The parent session may have completed it after the fork point. Decide whether to retry from the tool semantics: retry only if the operation is read-only or idempotent; if it may have side effects, first verify external state or ask the user. Do not retry blindly.',
  notStarted: 'The history inherited by this branch has no record of this tool call starting. The parent session may have executed it after the fork point. Decide whether to retry from the tool semantics: retry only if the operation is read-only or idempotent; if it may have side effects, first verify external state or ask the user. Do not retry blindly.',
}

/** One stable, caller-readable failure of the fork operation. */
class WorkspaceForkError extends Error {
  /**
   * @param code - stable machine code used in logs and by future callers.
   * @param message - human-readable explanation.
   */
  constructor(code, message) {
    super(message)
    this.name = 'WorkspaceForkError'
    this.code = code
  }
}

/**
 * Resolve the omitted-boundary default: the latest completed turn, including
 * standalone events that follow it before the next turn begins.
 * @param events - the source session's complete event prefix.
 * @returns the inclusive boundary seq, or undefined when no turn completed.
 */
function latestCompletedPrefixBoundary(events) {
  const lastTurnEnd = events.findLast((event) => event.type === 'turn/end')
  if (lastTurnEnd === undefined) return undefined
  let boundary = lastTurnEnd.seq
  for (const next of events.slice(boundary + 1)) {
    if (next.type === 'turn/start' || (next.type === 'user/message' && next.surfaceOp === 'append') || next.type === 'agent/inbox/spliced') break
    boundary = next.seq
  }
  return boundary
}

/**
 * Build the synthetic events that balance an open tail turn for a branch.
 * Unanswered tool calls receive error results first, then an open step closes,
 * then the turn closes with the `forked` cause.
 * @param events - the copied prefix, ending with `session/end-seed`.
 * @returns synthetic closer events in order; empty for an already balanced log.
 */
function openTurnClosers(events) {
  let openTurn = null
  let openStep = null
  const pending = new Map()

  for (const event of events) {
    switch (event.type) {
      case 'turn/start':
        openTurn = event.data.turn
        openStep = null
        pending.clear()
        break
      case 'turn/end':
        openTurn = null
        openStep = null
        pending.clear()
        break
      case 'step/start':
        openStep = event.data.step
        break
      case 'step/end':
        // A closed step keeps its own history; only the still-open tail turn is
        // balanced by openTurnClosers, matching dsh-session's recovery rule.
        openStep = null
        pending.clear()
        break
      case 'assistant/message':
        for (const block of event.data.message.content) {
          if (block.type === 'tool-call') {
            pending.set(block.id, {
              turn: event.data.turn,
              step: event.data.step,
              callSeq: undefined,
            })
          }
        }
        break
      case 'tool/call': {
        const entry = pending.get(event.data.callId)
        if (entry !== undefined) entry.callSeq = event.seq
        break
      }
      case 'tool/result': {
        const callId = event.data.message.source.callId
        const entry = pending.get(callId)
        // Only an appended result settles the call for this prefix. A replace
        // result rewrites an earlier surface range, so it is left to the
        // upstream ToolCallRecovery semantics rather than closing a call here.
        if (event.surfaceOp === 'append' && entry !== undefined
          && entry.turn === event.data.turn && entry.step === event.data.step) {
          pending.delete(callId)
        }
        break
      }
      default:
        break
    }
  }

  const last = events.at(-1)
  if (openTurn === null || last === undefined) return []

  let seq = last.seq + 1
  const time = last.time
  const closers = []
  for (const [callId, entry] of pending) {
    const started = entry.callSeq !== undefined
    const message = {
      id: `forked-tool-result-${callId}-${seq}`,
      role: 'tool',
      toolCallId: callId,
      isError: true,
      source: { kind: 'tool', callId },
      content: [{ type: 'text', text: started ? CLOSER_TEXT.started : CLOSER_TEXT.notStarted }],
    }
    closers.push({
      type: 'tool/result',
      seq: seq++,
      time,
      data: {
        turn: entry.turn,
        step: entry.step,
        message,
        error: started
          ? { name: 'ToolOutcomeUnknownError', code: TOOL_OUTCOME_UNKNOWN }
          : { name: 'ToolNotStartedError', code: TOOL_NOT_STARTED },
      },
      surfaceOp: 'append',
      ...(started ? { sourceEventSeqs: [entry.callSeq] } : {}),
    })
  }

  if (openStep !== null) {
    closers.push({ type: 'step/end', seq: seq++, time, data: { turn: openTurn, step: openStep } })
  }
  closers.push({ type: 'turn/end', seq: seq++, time, data: { turn: openTurn, reason: { kind: 'forked' } } })
  return closers
}

/**
 * Copy an inclusive event prefix, mark the inherited cut, and balance its tail.
 * @param events - source log with contiguous seqs from zero.
 * @param boundary - inclusive source event seq the child inherits through.
 * @returns the seed events, including synthetic closers.
 */
function buildForkSeed(events, boundary) {
  const prefix = events.slice(0, boundary + 1)
  prefix.push({
    type: 'session/end-seed',
    seq: boundary + 1,
    time: events[boundary].time,
    data: { inherited: true },
  })
  return prefix.concat(openTurnClosers(prefix))
}

/**
 * Increment a trailing fork number while preserving its bracket style.
 * @param title - the source conversation's durable title.
 * @returns the title assigned to the branch.
 */
function increasedForkTitle(title) {
  const ascii = /^(.*?)\((\d+)\)$/u.exec(title)
  if (ascii?.[1] !== undefined && ascii[2] !== undefined) return `${ascii[1]}(${BigInt(ascii[2]) + 1n})`
  const fullWidth = /^(.*?)（(\d+)）$/u.exec(title)
  if (fullWidth?.[1] !== undefined && fullWidth[2] !== undefined) return `${fullWidth[1]}（${BigInt(fullWidth[2]) + 1n}）`
  return `${title} (1)`
}

/**
 * Compare two filesystem paths under the host platform's case and separator rules.
 * @param left - one path.
 * @param right - the other path.
 * @returns whether they name the same location.
 */
function samePath(left, right) {
  const fold = (value) => {
    const normalized = String(value).replace(/[\\/]+/gu, '/').replace(/\/+$/u, '')
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized
  }
  return fold(left) === fold(right)
}

/**
 * Resolve one registered Workspace from an id, absolute path, or exact title.
 * @param ctx - Host context carrying the Workspace registry.
 * @param input - caller-provided workspace reference.
 * @returns the matching Workspace entity.
 * @throws WorkspaceForkError when the reference is missing, ambiguous, or unknown.
 */
async function resolveTargetWorkspace(ctx, input) {
  const raw = String(input ?? '').trim()
  if (raw.length === 0) throw new WorkspaceForkError('workspace/missing', 'A target workspace is required.')
  const list = ctx.workspaceRegistry.list()
  const byId = list.find((workspace) => String(workspace.id) === raw)
  if (byId) return byId
  const byPath = list.find((workspace) => samePath(workspace.path, raw))
  if (byPath) return byPath
  const title = raw.toLowerCase()
  const titled = list.filter((workspace) => workspace.title.trim().toLowerCase() === title)
  if (titled.length === 1) return titled[0]
  if (titled.length > 1) {
    throw new WorkspaceForkError('workspace/ambiguous', `Several workspaces are titled "${raw}"; pass the workspace id or path instead.`)
  }
  if (isAbsolute(raw)) {
    try {
      const resolved = await ctx.workspaceRegistry.resolveByPath(raw)
      if (resolved !== undefined) return resolved
    } catch {
      // A missing or unreadable directory simply falls through to the catalog error.
    }
  }
  const available = list.map((workspace) => `"${workspace.title}" (${workspace.path})`).join(', ')
  throw new WorkspaceForkError('workspace/not-found', `No workspace matches "${raw}". Available workspaces: ${available.length > 0 ? available : 'none'}.`)
}

/**
 * Fork one Session's latest completed prefix into another Workspace.
 *
 * @param ctx - Host context carrying agents, sessions, workspaces, and titles.
 * @param options.sourceId - the conversation being forked.
 * @param options.workspace - target workspace id, absolute path, or exact title.
 * @param options.atSeq - optional inclusive source event boundary.
 * @returns the new Session's identity and the workspace that now owns it.
 * @throws WorkspaceForkError for every expected refusal.
 */
export async function forkToWorkspace(ctx, options) {
  const sourceId = String(options.sourceId ?? '').trim()
  if (sourceId.length === 0) throw new WorkspaceForkError('session/missing', 'A source conversation is required.')
  const target = await resolveTargetWorkspace(ctx, options.workspace)
  const status = await target.status()
  if (status === 'missing-dir') {
    throw new WorkspaceForkError('workspace/missing-dir', `The workspace directory "${target.path}" no longer exists.`)
  }

  const observation = await ctx.sessionQuery.observeSession(sourceId, { projectionMode: 'all' })
  try {
    const header = observation.header
    if (header.origin === 'subagent') throw new WorkspaceForkError('session/subagent', 'A subagent conversation cannot be forked into a workspace.')
    const events = observation.events

    let boundary
    if (options.atSeq === undefined) {
      boundary = latestCompletedPrefixBoundary(events)
      if (boundary === undefined) {
        throw new WorkspaceForkError('session/no-completed-turn', 'This conversation has no completed turn to fork from yet.')
      }
    } else {
      if (!Number.isSafeInteger(options.atSeq) || options.atSeq < 0) {
        throw new WorkspaceForkError('boundary/invalid', 'The fork boundary must be a non-negative safe integer.')
      }
      boundary = options.atSeq
    }
    if (events[boundary]?.seq !== boundary) {
      const last = events.at(-1)?.seq ?? 'none'
      throw new WorkspaceForkError('boundary/unknown', `Event ${String(boundary)} does not exist in this conversation (last seq: ${String(last)}).`)
    }

    const seed = buildForkSeed(events, boundary)
    const childId = `session-${randomUUID()}`

    const presets = ctx.get('agentPresets')
    let agentPreset
    let setup
    if (presets !== undefined) {
      const resolved = await presets.resolve(observation.projections?.values?.agentPreset)
      agentPreset = resolved.id
      setup = async (agentCtx) => {
        await presets.mount(agentCtx, resolved.id)
      }
    }

    const selection = ctx.agentDefaultModel.currentSelection()
    const created = await ctx.agents.create({
      sessionId: childId,
      seed,
      inheritedEventCount: boundary + 1,
      meta: {
        cwd: target.path,
        parentSession: sourceId,
        isSeeded: true,
        ...(agentPreset === undefined ? {} : { agentPreset }),
      },
      agentOptions: { provider: selection.provider, model: selection.model },
      ...(setup === undefined ? {} : { setup }),
    })
    const agent = created.agent

    try {
      await target.attachSession(childId)
    } catch (error) {
      // The child is already persisted. Never leave a live, unlisted branch
      // behind: tear the live Agent down and surface its identity so the
      // persisted log can be recovered instead of silently disappearing.
      ctx.logger.warn(
        `workspace-fork: branch "${childId}" was created but could not attach to workspace "${target.title}" (${target.path}): ${String(error)}`,
      )
      try {
        await created.dispose()
      } catch (disposeError) {
        ctx.logger.warn(`workspace-fork: could not dispose unattached branch "${childId}": ${String(disposeError)}`)
      }
      throw new WorkspaceForkError(
        'workspace/attach-failed',
        `The conversation was created as "${childId}" but could not be attached to workspace "${target.title}" (${target.path}): ${String(error)}. Its log remains on disk outside every workspace.`,
      )
    }

    let title
    try {
      const titles = ctx.get('sessionTitle')
      const inherited = titles?.get(agent.session)?.title
      if (titles !== undefined && inherited !== undefined && inherited.trim().length > 0) {
        title = titles.rename(agent.session, increasedForkTitle(inherited)).title
      }
    } catch (error) {
      ctx.logger.warn(`workspace-fork: could not title the branch of "${sourceId}": ${String(error)}`)
    }

    const value = {
      sessionId: childId,
      workspaceId: String(target.id),
      workspaceTitle: target.title,
      workspacePath: target.path,
      ...(title === undefined ? {} : { title }),
    }
    return value
  } finally {
    observation[Symbol.dispose]?.()
  }
}

/**
 * Render one fork outcome as the human-only command result text.
 * @param value - the fork result.
 * @returns a sentence naming the workspace and new conversation id.
 */
function successText(value) {
  return `Forked this conversation to "${value.workspaceTitle}" — new conversation ${value.sessionId}.`
}

/**
 * Register the human command and the agent tool over one operation.
 * @param ctx - Host context.
 */
export function apply(ctx) {
  ctx.effect(() => {
    const disposeCommand = ctx.commands.register({
      name: 'fork-to-workspace',
      description: 'Fork this conversation into another workspace',
      input: { hint: '<workspace id, title, or path>' },
      recordInput: false,
      async handler(invocation) {
        try {
          const value = await forkToWorkspace(ctx, {
            sourceId: invocation.agent.id,
            workspace: invocation.rawInput.trim(),
          })
          return { kind: 'success', text: successText(value) }
        } catch (error) {
          if (error instanceof WorkspaceForkError) return { kind: 'error', text: error.message }
          throw error
        }
      },
    })

    const disposeTool = ctx.tools.register({
      name: 'fork_conversation_to_workspace',
      description:
        'Copy this (or another) conversation into a different workspace as a new independent conversation, inheriting its history through the latest completed turn. Use when the user asks to continue a conversation in another workspace or to move a branch of it elsewhere. Only workspaces registered in the harness are accepted.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          workspace: {
            type: 'string',
            description: 'Target workspace: its exact id, exact title, or absolute directory path.',
          },
          session_id: {
            type: 'string',
            description: 'Source conversation id. Omit to fork the calling conversation.',
          },
          at_seq: {
            type: 'number',
            description: 'Optional inclusive source event sequence to fork through. Omit for the latest completed turn.',
          },
        },
        required: ['workspace'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            sessionId: { type: 'string', description: 'New conversation id.' },
            workspaceId: { type: 'string', description: 'Workspace that owns the new conversation.' },
            workspaceTitle: { type: 'string', description: 'Workspace display title.' },
            workspacePath: { type: 'string', description: 'Workspace directory.' },
            title: { type: 'string', description: 'Branch title when the source had one.' },
          },
          required: ['sessionId', 'workspaceId', 'workspaceTitle', 'workspacePath'],
        },
        render: (_args, value) => [{
          type: 'text',
          text: `Forked into "${value.workspaceTitle}" as ${value.sessionId}${value.title === undefined ? '' : ` (${value.title})`}.`,
        }],
      },
      async execute(args, exec) {
        if (exec.agent === undefined) throw new Error('fork_conversation_to_workspace requires a conversation')
        if (typeof args.workspace !== 'string' || args.workspace.trim().length === 0) {
          throw new WorkspaceForkError('workspace/missing', 'A target workspace is required.')
        }
        return forkToWorkspace(ctx, {
          sourceId: typeof args.session_id === 'string' && args.session_id.length > 0 ? args.session_id : exec.agent.id,
          workspace: args.workspace,
          ...(args.at_seq === undefined ? {} : { atSeq: args.at_seq }),
        })
      },
    })

    return () => {
      disposeTool()
      disposeCommand()
    }
  }, 'workspace-fork: command and tool')
}
