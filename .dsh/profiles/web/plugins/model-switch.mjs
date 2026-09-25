// model-switch: host-plane plugin for the `web` profile registering two
// model-facing tools that let the agent change its OWN model mid-session:
//
//   switch_model  - the agent picks provider/model + the first message the
//                   new model should receive.
//   switch_model_escalate - the "escape hatch": the agent calls it with no
//                   arguments; deployment policy picks the route (config:
//                   escalationProvider/escalationModel, default
//                   local-ai-machine/medium-dense). The tool switches the
//                   session to that model and steers a short static notice
//                   explaining the switch (so the new model inherits the
//                   session and can continue anything in-flight). For now the
//                   policy is this static pair; the indirection exists so the
//                   rule can grow (e.g. "same family, bigger role",
//                   per-session caps) without changing the tool contract the
//                   model sees.
//
// Why a profile plugin and not an agent-preset row: it reaches every agent
// preset automatically (the dsh-image-search-searxng precedent in this same
// directory), and both capabilities it wires up are host-plane services -
// the `sessionController` model-selection path and the agent inbox - which a
// preset realm must not own. It publishes no service, so no isolate realm is
// needed either.
//
// Mechanism (all pre-existing, verified against dsh-api-session-controller):
//
//   1. sessionController.selectModel({ sessionId, provider, model }) - the
//      SAME in-process method the browser model picker calls. It validates
//      the pair through llm.resolveCallConfig, appends the durable
//      `model/selection` event to the session log, installs the live
//      per-agent selection (prompt-assembly + request-routing waterfalls),
//      and persists the selection as the deployment default for new sessions
//      (agent-default-model settings) - identical side effects to switching
//      from the UI, deliberately so.
//   2. installModelSelection's `agent/pre-step` listener then appends its own
//      durable "[model changed: ...]" user notice at the boundary on the
//      first request under the new route - the model-facing accounting the
//      agent gets for free.
//   3. agent.steer(createUserMessage(...)) injects the agent-authored first
//      message at the inbox's next-step position and wakes the driver; it is
//      delivered immediately after the model switch completes, before the new
//      model picks up any other work. (Same underlying inbox.send as
//      agent.followup, but next-step instead of next-turn.)
//
// The tool result reports from/to routes; a failed pair returns the
// modelCatalog's routable provider/model list so the model can self-correct
// without a user round-trip.

import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

const PLUGIN_NAME = 'model-switch'
const DEFAULT_ESCALATION = { provider: 'local-ai-machine', model: 'medium-dense' }

function routeLabel(route) {
  if (route === undefined || route === null) return 'unknown'
  return `${route.provider}/${route.model}`
}

function sameRoute(a, b) {
  return (
    a !== undefined && b !== undefined && a.provider === b.provider && a.model === b.model
  )
}

function catalogRouteList(catalog) {
  const routes = []
  for (const group of catalog?.groups ?? []) {
    for (const model of group?.models ?? []) routes.push(`${group.id}/${model.id}`)
  }
  return routes
}

/**
 * Validate + install a model selection for one agent, then queue the
 * agent-authored first message for the new model's next turn.
 * Returns { ok, from, to, alreadyOnRoute } or { ok: false, error }.
 */
async function switchAgentModel(ctx, log, agent, provider, model, text, noticeSummary) {
  const controller = ctx.get('sessionController')
  if (controller === undefined) {
    return {
      ok: false,
      error: 'model switching is unavailable in this profile (no sessionController service).',
    }
  }

  const from = agent.session.requestHeader()?.config

  let to
  try {
    to = (await controller.selectModel({ sessionId: agent.id, provider, model })).selected
  } catch (error) {
    let hint = ''
    try {
      const routes = catalogRouteList(await controller.modelCatalog())
      if (routes.length > 0) hint = ` Available routes: ${routes.join(', ')}.`
    } catch {
      // catalog is a convenience; never mask the real error with it
    }
    const message = error instanceof Error ? error.message : String(error)
    log.warn('switch to %s/%s failed: %s', provider, model, message)
    return { ok: false, error: `model switch failed: ${message}${hint}` }
  }

  agent.steer(
    createUserMessage({
      content: [{ type: 'text', text }],
      source: {
        kind: 'plugin',
        plugin: PLUGIN_NAME,
        form: 'notice',
        summary: noticeSummary,
      },
    }),
  )

  const alreadyOnRoute = sameRoute(from, to)
  log.info(
    'session %s: model %s -> %s (%s)',
    agent.id,
    routeLabel(from),
    routeLabel(to),
    alreadyOnRoute ? 'already on route, message queued only' : 'switched',
  )
  return { ok: true, from: routeLabel(from), to: routeLabel(to), alreadyOnRoute }
}

function noAgent() {
  return {
    ok: false,
    error: 'no agent context for this tool call; model switching only works from a model turn of the session itself.',
  }
}

function switchOutput() {
  return {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean', required: true },
        from: { type: 'string' },
        to: { type: 'string' },
        alreadyOnRoute: { type: 'boolean' },
        error: { type: 'string' },
      },
    },
    render(_args, value) {
      if (!value.ok) return [{ type: 'text', text: value.error }]
      if (value.alreadyOnRoute) {
        return [
          {
            type: 'text',
            text: `Session is already on ${value.to}; the notice was steered to the current turn.`,
          },
        ]
      }
      return [
        {
          type: 'text',
          text: `Session switched to ${value.to} (was ${value.from}). A notice explaining the switch was steered to the new model; a durable "model changed" notice marks the boundary in the transcript.`,
        },
      ]
    },
  }
}

export default function modelSwitch(ctx, config = {}) {
  const log = ctx.logger(PLUGIN_NAME)
  const escalation = {
    provider: config.escalationProvider ?? DEFAULT_ESCALATION.provider,
    model: config.escalationModel ?? DEFAULT_ESCALATION.model,
  }

  ctx.inject(['tools'], (toolCtx) => {
    ctx.effect(
      () =>
        toolCtx.tools.register(
          defineTool({
            name: 'switch_model',
            description:
              'Switch the current session\'s model to a different provider/model, sending the given message to the new model immediately. Use when you judge the remaining work is better served by another model - a stronger reasoner for a hard problem, a model with a needed capability, or a cheaper model for mechanical work. The session\'s full history carries over; a durable "model changed" notice marks the boundary, and the selection also becomes the deployment default for new sessions (exactly like switching from the UI). provider and model must be an exact pair from the model catalog - on a bad pair the tool returns the available routes so you can self-correct. message is the first message the new model receives: make it self-contained - where things stand, what you tried, and what to do next. The session stays on the new model until switched again.',
            parameters: {
              provider: {
                type: 'string',
                required: true,
                description: 'Exact provider id from the model catalog, e.g. "local-ai-machine".',
              },
              model: {
                type: 'string',
                required: true,
                description: 'Exact model id under that provider, e.g. "medium-moe".',
              },
              message: {
                type: 'string',
                required: true,
                description:
                  'The first message the new model receives as a user message. Self-contained: where things stand, what was tried, what to do next.',
              },
            },
            output: switchOutput(),
            async execute(args, exec) {
              const agent = exec.agent
              if (agent === undefined) return noAgent()
              return await switchAgentModel(
                ctx,
                log,
                agent,
                args.provider,
                args.model,
                args.message,
                `Model switched to ${args.provider}/${args.model}`,
              )
            },
          }),
        ),
      'model-switch: register switch_model',
    )
    ctx.effect(
      () =>
        toolCtx.tools.register(
          defineTool({
            name: 'switch_model_escalate',
            description:
              `Escape hatch for being stuck: repeated failures, a loop you cannot break out of, or a judgment call you cannot settle. Hands this session to the escalation model - you do NOT choose it; deployment policy decides (currently ${escalation.provider}/${escalation.model}). The session's full history carries over, the new model inherits the current task and continues anything in-flight, and a durable "model changed" notice marks the boundary. Make a genuine further attempt yourself first; never use this for an ordinary follow-up question.`,
            parameters: {},
            output: switchOutput(),
            async execute(_args, exec) {
              const agent = exec.agent
              if (agent === undefined) return noAgent()
              const text = `Switched to ${escalation.provider}/${escalation.model} (escalation route). Continuing with the current task.`
              return await switchAgentModel(
                ctx,
                log,
                agent,
                escalation.provider,
                escalation.model,
                text,
                `Escalated to ${escalation.provider}/${escalation.model}`,
              )
            },
          }),
        ),
      'model-switch: register switch_model_escalate',
    )
  })

  log.info(
    'model-switch active (escalation=%s/%s)',
    escalation.provider,
    escalation.model,
  )
}
