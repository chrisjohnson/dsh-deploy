// model-switch: Client half (browser bundle).
//
// The interactive counterpart to the Host half's fit guard. The guard protects
// the AGENT path (the `switch_model` tool); the composer's own model picker calls
// sessionController.selectModel directly and cannot be intercepted, so a human
// switch can still land the session on a route too small for its history. The
// real incident (2026-09-28) was exactly that: deepseek-flash at 421k tokens
// switched to big-moe (262k), and the next request died with
// ContextWindowExceededError after an automatic recovery that could not work
// either - because the summarizer was the same 262k model the request overflowed.
//
// This half adds two seats, both additive list slots (replaceRisk: none):
//
//   conversation.input.left     a quiet context pill beside the model picker:
//                               `ctx 421k`, turning amber with `421k / 262k` the
//                               moment the ROUTED model cannot hold the session.
//                               Its tooltip names which routes still fit, which is
//                               the "check before you switch" cue.
//   conversation.composer.dock  an actionable banner that appears as soon as the
//                               routed window is exceeded - BEFORE the next
//                               request is sent - offering the one-click repair:
//                               move to a big-window route, compact there, come
//                               back. That is the manual "switch back, compact,
//                               switch again" sequence, automated.
//
// All authority stays in the Host half: the browser renders what
// /api/modelSwitch/state reports and asks /api/modelSwitch/fix to act, so the
// interactive path and the agent path can never disagree about the numbers.
// Nothing here computes its own token estimate.

window.__ModuleLoader__.load({
	id: "dsh-model-switch",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		var React = require("react");
		var h = React.createElement;

		var connection = null;

		var COLOR = {
			text: "var(--dsw-alias-label-primary, #333)",
			dim: "var(--dsw-alias-label-tertiary, #8a8a8a)",
			faint: "var(--dsw-alias-label-secondary, #666)",
			border: "var(--dsw-alias-border-l1, #e4e4e4)",
			raised: "var(--dsw-specific-tip, #f7f8fa)",
			panel: "var(--dsw-alias-bg-base, #fff)",
			warn: "#e8a33d",
			danger: "#e5484d"
		};

		var CSS =
			".dmsw-pill{display:inline-flex;align-items:center;gap:4px;height:22px;padding:0 7px;border-radius:11px;" +
			"font:11px/1 Inter,sans-serif;color:" + COLOR.faint + ";background:" + COLOR.raised + ";border:1px solid " + COLOR.border + ";" +
			"white-space:nowrap;cursor:help}" +
			".dmsw-pill-alert{color:#fff;background:" + COLOR.danger + ";border-color:" + COLOR.danger + ";font-weight:600}" +
			".dmsw-pill-warn{color:#fff;background:" + COLOR.warn + ";border-color:" + COLOR.warn + ";font-weight:600}" +
			".dmsw-pill-dot{width:6px;height:6px;border-radius:50%;background:currentColor;opacity:.75;flex:0 0 auto}" +
			".dmsw-banner{display:flex;align-items:center;gap:10px;margin:0 0 6px;padding:7px 10px;border-radius:8px;" +
			"font:12px/17px Inter,sans-serif;color:" + COLOR.text + ";background:rgba(229,72,77,.08);" +
			"border:1px solid rgba(229,72,77,.35)}" +
			".dmsw-banner-warn{background:rgba(232,163,61,.1);border-color:rgba(232,163,61,.45)}" +
			".dmsw-banner-text{flex:1 1 auto;min-width:0}" +
			".dmsw-banner-title{font-weight:600}" +
			".dmsw-banner-sub{color:" + COLOR.faint + ";font-size:11px}" +
			".dmsw-btn{flex:0 0 auto;height:24px;padding:0 9px;border-radius:6px;border:1px solid " + COLOR.border + ";" +
			"background:" + COLOR.panel + ";color:" + COLOR.text + ";font:11px/1 Inter,sans-serif;cursor:pointer;white-space:nowrap}" +
			".dmsw-btn:hover:not(:disabled){background:" + COLOR.raised + "}" +
			".dmsw-btn:disabled{opacity:.5;cursor:default}" +
			".dmsw-btn-primary{border-color:rgba(229,72,77,.5);color:" + COLOR.danger + ";font-weight:600}" +
			".dmsw-btn-warn{border-color:rgba(232,163,61,.6);color:" + COLOR.warn + ";font-weight:600}" +
			".dmsw-err{color:" + COLOR.danger + ";font-size:11px;margin-top:2px}";

		// ================================================================
		// TRANSPORT
		// ================================================================

		/**
		 * Every endpoint lives behind the same authenticated /api fence the
		 * profile's other local plugins use (see ../semantic-loop-evals). The
		 * browser never talks to the model catalog or the token meter itself.
		 */
		function api(endpoint, payload) {
			// A plain same-origin fetch against the Host half's own `webServer`
			// prefix route. NOT connection.rpc.call("/api", ...): that path
			// answers 405 on this deployment (the /api fence is mounted from a
			// child scope, so the rpc helper has no webServer to reach) - which is
			// why the host call never arrived and the badge could not learn any
			// route's capacity beyond the one in the last request.
			return fetch("/modelSwitch/" + encodeURIComponent(endpoint), {
				method: "POST",
				headers: { "content-type": "application/json" },
				credentials: "same-origin",
				body: JSON.stringify(payload === undefined ? {} : payload),
			}).then(function (response) {
				if (!response.ok) throw new Error("HTTP " + response.status + " from " + endpoint);
				return response.json();
			});
		}

		/** 421337 -> "421k", 1048576 -> "1M". */
		/**
		 * A route id that stays readable when two providers ship the same model id -
		 * on this deployment three providers all expose "deepseek-flash", and picking
		 * the wrong one silently changes the provider behind the user's back.
		 */
		function routeName(route, all) {
			if (!route || typeof route.model !== "string") return "?";
			var shared = Array.isArray(all) && all.filter(function (m) { return m.model === route.model; }).length > 1;
			return shared && route.provider ? route.provider + "/" + route.model : route.model;
		}

		function fmt(n) {
			if (typeof n !== "number" || !isFinite(n)) return "?";
			if (n < 1000) return String(n);
			if (n < 1e6) return String(Math.round(n / 100) / 10) + "k";
			return String(Math.round(n / 1e5) / 10) + "M";
		}

		/**
		 * `fits === false` covers two states that must never share a sentence.
		 *
		 *   "warn" - past the auto-compact line (fitRatio, the same 0.8 the harness
		 *     compacts at) but still inside the route's own window. Nothing fails;
		 *     the next request compacts here, on a route that can read it.
		 *   "hard" - past the route's own window. The request 400s and the automatic
		 *     rescue summarises with the route that just overflowed, so it 400s too.
		 *
		 * An earlier build printed "210520 tokens does not fit big-moe (262.1k)" -
		 * arithmetically self-refuting, and it called the harmless case a failure.
		 */
		function severity(state) {
			if (!state || state.available !== true || state.fits !== false) return null;
			if (typeof state.exceedsWindow === "boolean") return state.exceedsWindow ? "hard" : "warn";
			var w = state.route && typeof state.route.contextWindow === "number" ? state.route.contextWindow : undefined;
			if (w === undefined) return "warn";
			return state.tokens > w ? "hard" : "warn";
		}

		/** Full context sentence shared by the pill tooltip and the banner. */
		function describe(state) {
			if (!state || state.available !== true) return "Context fit is unavailable for this session.";
			var routed = state.routed || {};
			var lines = [
				"Conversation is ~" + state.tokens + " tokens.",
				"Routed model " + routed.provider + "/" + routed.model + " holds " +
					(routed.contextWindow === undefined ? "an undeclared window" : routed.contextWindow + " tokens") +
					(state.budget === undefined ? "" : " (~" + state.budget + " usable at this safety margin)") + "."
			];
			var fitting = (state.models || []).filter(function (m) { return m.fits === true; });
			var over = (state.models || []).filter(function (m) { return m.fits !== true; });
			var named = function (m) { return routeName(m, state.models) + " (" + fmt(m.contextWindow) + ")"; };
			if (fitting.length > 0) {
				lines.push("Still fits: " + fitting.map(named).join(", ") + ".");
			}
			if (over.length > 0) {
				lines.push("Too small: " + over.map(named).join(", ") + ".");
			}
			return lines.join("\n");
		}

		/**
		 * Shared state for the pill and the banner.
		 *
		 * The display is built from the LOCAL `contextPressure` projection, not
		 * from the host round-trip. That is deliberate and load-bearing: the
		 * warning has to appear the instant the routed window is exceeded, and a
		 * host call is not always fast - `resolveModelInfo` on a busy local GPU
		 * can take seconds or stall, and an earlier version that rendered only
		 * from the response showed nothing at all while the promise hung. The
		 * host call therefore only ENRICHES (which other routes would fit, and
		 * whether a one-click repair is available).
		 *
		 * The enrich refresh key is narrow - session plus the selected route -
		 * because the obvious dependency, the live pressure numbers, changes on
		 * every streamed token; keying on those restarted the request faster than
		 * it could settle. Pressure reaches the display through the projection
		 * itself, which is already reactive.
		 */
		var REFRESH_MS = 30000;
		// Mirror of the Host half's `fitRatio` default, used only until the host
		// reports its own budget (and if the host is unreachable at all).
		var FALLBACK_FIT_RATIO = 0.8;

		function useFitState(sessionId, useProjection) {
			var pressure = useProjection ? useProjection("contextPressure") : null;
			var selection = useProjection ? useProjection("modelSelection") : null;
			// The modelSelection projection state is { lastUsed, next } - each
			// either null or {provider, model, reasoningEffort?}. `lastUsed` is the
			// route the last request actually went out on, which is what the fit
			// verdict is about; `next` covers a switch that has not been used yet.
			// `lastUsed` describes the last request; `next` is a switch queued in
			// the picker with nothing sent yet. The pending intent wins, because
			// that is the route the next message would actually go out on.
			var pending = selection && selection.next ? selection.next : null;
			var chosen = pending || (selection ? selection.lastUsed : null) || null;
			var hostPair = React.useState(null);
			var host = hostPair[0];
			var setHost = hostPair[1];
			var routeKey =
				String(sessionId) +
				"|" +
				String(chosen ? chosen.provider : "") +
				"|" +
				String(chosen ? chosen.model : "");

			React.useEffect(function () {
				var live = true;
				var settle = function (next) {
					if (live) setHost(next);
				};
				var load = function () {
					api("state", {
						sessionId: sessionId,
						provider: chosen ? chosen.provider : undefined,
						model: chosen ? chosen.model : undefined,
					}).then(
						function (reply) {
							settle(
								reply && reply.ok === true
									? reply.state
									: { available: false, reason: (reply && reply.error) || "unavailable" },
							);
						},
						function (error) {
							settle({
								available: false,
								reason: "host call failed: " + (error && error.message ? error.message : String(error)),
							});
						},
					);
				};
				load();
				var interval = setInterval(load, REFRESH_MS);
				return function () {
					live = false;
					clearInterval(interval);
				};
			}, [routeKey]);

			var hostHas = host !== null && host !== undefined && host.available === true;
			// Prefer the Host half's measurement: it is the same number the fit
			// guard decides on, so the badge and the tool can never disagree.
			var tokens =
				hostHas && typeof host.tokens === "number"
					? host.tokens
					: pressure && typeof pressure.pressureTokens === "number"
						? pressure.pressureTokens
						: pressure && typeof pressure.surfaceTokens === "number"
							? pressure.surfaceTokens
							: undefined;
			if (tokens === undefined) {
				// A brand-new session has nothing to show yet.
				return [host, function () { setHost(null); }];
			}
			if (!hostHas && pending !== null) {
				// A switch is pending and the host has not reported the new route's
				// capacity. The projection only describes the LAST request, so any
				// verdict computed here would be about the wrong model - staying
				// silent is the only honest option.
				return [
					{ available: false, reason: "waiting for the host to report the pending route capacity" },
					function () { setHost(null); },
				];
			}
			var window =
				hostHas && host.route && typeof host.route.contextWindow === "number"
					? host.route.contextWindow
					: pressure && typeof pressure.contextWindow === "number"
						? pressure.contextWindow
						: undefined;
			var budget =
				hostHas && typeof host.budget === "number"
					? host.budget
					: window === undefined
						? undefined
						: Math.floor(window * FALLBACK_FIT_RATIO);
			var fits = budget === undefined ? true : tokens <= budget;
			var merged = {
				available: true,
				sessionId: sessionId,
				tokens: tokens,
				route: {
					provider: chosen ? chosen.provider : undefined,
					model: chosen ? chosen.model : undefined,
					contextWindow: window,
				},
				routed: {
					provider: chosen ? chosen.provider : undefined,
					model: chosen ? chosen.model : undefined,
					contextWindow: window,
				},
				budget: budget,
				fits: fits,
				currentWindowKnown: window !== undefined,
				exceedsWindow:
					hostHas && typeof host.exceedsWindow === "boolean"
						? host.exceedsWindow
						: window === undefined
							? undefined
							: tokens > window,
				pending: pending !== null,
				fromHost: hostHas,
				canFix: fits === false && hostHas && host.canFix === true,
				reader: hostHas ? host.reader : undefined,
				models: hostHas && Array.isArray(host.models) ? host.models : [],
				suggest: hostHas && host.suggest ? host.suggest : null,
			};
			return [merged, function () { setHost(null); }];
		}

		// ================================================================
		// THE PILL (beside the model picker)
		// ================================================================

		function FitPill(props) {
			var pair = useFitState(props.sessionId, props.useProjection);
			var state = pair[0];
			var refetch = pair[1];
			// Rendered ONLY when there is something to act on. A quiet pill on a
			// healthy session is noise: the whole point is that a red one appearing
			// the instant a too-small model is picked is the signal.
			if (!state || state.available !== true) return null;
			if (state.fits !== false || state.route === undefined) return null;
			var hard = severity(state) === "hard";
			// Two different sentences, because they are two different facts: a
			// comparison the user can check against the number next to it ("won't
			// fit" only when the tokens really exceed the window), and a countdown
			// to the automatic summary for everything above the 0.8 line.
			var label = hard
				? fmt(state.tokens) + " > " + fmt(state.route.contextWindow) + " — won't fit " +
					routeName(state.route, state.models)
				: fmt(state.tokens) + " / " + fmt(state.route.contextWindow) + " — compacts at " + fmt(state.budget);
			return h(
				"span",
				{
					className: "dmsw-pill " + (hard ? "dmsw-pill-alert" : "dmsw-pill-warn"),
					title: describe(state),
					role: "status",
					"aria-live": "polite",
					onDoubleClick: refetch
				},
				h("span", { className: "dmsw-pill-dot" }),
				label,
			);
		}

		// ================================================================
		// THE BANNER (below the composer, before the failing request)
		// ================================================================

		function FitBanner(props) {
			var pair = useFitState(props.sessionId, props.useProjection);
			var state = pair[0];
			var refetch = pair[1];
			var runPair = React.useState(null);
			var running = runPair[0];
			var setRunning = runPair[1];
			var resultPair = React.useState(null);
			var result = resultPair[0];
			var setResult = resultPair[1];

			if (!state || state.available !== true || state.fits !== false) return null;
			var hard = severity(state) === "hard";
			var routed = state.routed || {};

			// Where to move if the user does not want to stay. The Host owns this
			// choice: "smallest window that still fits" is intuitive and wrong -
			// three deepseek-official routes at 1,000,000 sit just under the
			// 1,048,576 cloud route the operator actually uses, so that rule kept
			// landing on a route nobody picked and shared its model id.
			var destination = state.suggest || null;
			if (!destination) {
				var fitting = (state.models || [])
					.filter(function (m) {
						return m.fits === true && !(m.provider === routed.provider && m.model === routed.model);
					})
					.sort(function (a, b) { return a.contextWindow - b.contextWindow; });
				destination = fitting.length > 0 ? fitting[0] : null;
			}

			function act(provider, model, label) {
				setRunning(label);
				setResult(null);
				api("fix", { sessionId: props.sessionId, provider: provider, model: model }).then(function (reply) {
					setRunning(null);
					setResult(reply || { ok: false, error: "no reply" });
					if (reply && reply.ok === true) refetch();
				});
			}

			var busy = running !== null;
			var children = [
				h(
					"div",
					{ className: "dmsw-banner-text", key: "text" },
					h(
						"div",
						{ className: "dmsw-banner-title" },
						hard
							? "This conversation (" + state.tokens + " tokens) is over " +
								routeName(routed, state.models) + "'s own window (" + fmt(routed.contextWindow) + ")."
							: "This conversation (" + state.tokens + " tokens) is past " +
								routeName(routed, state.models) + "'s auto-compact line (" + fmt(state.budget) +
								" of " + fmt(routed.contextWindow) + ").",
					),
					h(
						"div",
						{ className: "dmsw-banner-sub" },
						hard
							? state.canFix === true
								? "The next request fails, and the automatic rescue cannot fix it either: it summarises with the route that just overflowed. This repairs it on a larger-window route (" +
									(state.reader ? state.reader.model : "reader") + ") and returns here."
								: "The next request fails, and no route with a large enough window is available to read it. Delegate the work to a subagent instead."
							: "Nothing fails and nothing is stranded — the next request compacts it here, on a route that can still read it. Do it now while you choose what survives, or move to a route with room and skip the summary.",
					),
					result !== null
						? h(
								"div",
								{ className: result.ok === true ? "dmsw-banner-sub" : "dmsw-err" },
								result.ok === true
									? "Repaired" + (result.steps && result.steps.length ? ": " + result.steps.join(" -> ") + "." : ".") +
										(result.tokensAfter ? " Now ~" + result.tokensAfter + " tokens." : "")
									: String(result.error || "repair failed"),
							)
						: null,
				),
			];

			if (state.canFix === true) {
				children.push(
					h(
						"button",
						{
							key: "repair",
							className: "dmsw-btn " + (hard ? "dmsw-btn-primary" : "dmsw-btn-warn"),
							disabled: busy,
							onClick: function () { act(routed.provider, routed.model, "compacting"); },
							title: hard
								? "Compact on a larger-window route, then come back to " + routeName(routed, state.models) + "."
								: "Compact here now instead of letting the next request do it."
						},
						busy ? running : hard ? "Compact and stay" : "Compact now",
					),
				);
			}
			if (destination !== null && !(destination.provider === routed.provider && destination.model === routed.model)) {
				children.push(
					h(
						"button",
						{
							key: "move",
							className: "dmsw-btn",
							disabled: busy,
							onClick: function () { act(destination.provider, destination.model, "switching"); },
							title:
								"Move to " + destination.provider + "/" + destination.model + " (" +
								fmt(destination.contextWindow) + " window) without compacting."
						},
						"Move to " + routeName(destination, state.models),
					),
				);
			}

			return h("div", { className: hard ? "dmsw-banner" : "dmsw-banner dmsw-banner-warn", role: "alert" }, children);
		}

		// ================================================================
		// PLUGIN
		// ================================================================

		function apply(ctx) {
			connection = ctx.connection !== undefined ? ctx.connection : ctx.get ? ctx.get("connection") : null;

			var styleId = "dmsw-styles";
			if (typeof document !== "undefined" && document.getElementById(styleId) === null) {
				var tag = document.createElement("style");
				tag.id = styleId;
				tag.textContent = CSS;
				document.head.appendChild(tag);
			}

			var slots = ctx.slots !== undefined ? ctx.slots : ctx.get ? ctx.get("slots") : undefined;
			if (slots === undefined || slots === null) {
				console.error("dsh-model-switch: slots service missing - the fit pill and banner stay off");
				var diag = document.createElement("div");
				diag.id = "dmsw-diag-no-slots";
				diag.textContent = "model-switch: no slots service";
				document.body.appendChild(diag);
				return;
			}

			// `slots.inject` defers registration until the owning seat is live,
			// which is what makes an additive list entry safe here.
			ctx.effect(function () {
				return slots.inject("conversation.input.left", function () {
					return slots.register(
						{ name: "conversation.input.left", id: "model-switch-fit-pill", order: 45 },
						function FitPillSlot(props) { return h(FitPill, props); },
					);
				});
			}, "dsh-model-switch: fit pill");

			ctx.effect(function () {
				return slots.inject("conversation.composer.dock", function () {
					return slots.register(
						{ name: "conversation.composer.dock", id: "model-switch-fit-banner", order: 20 },
						function FitBannerSlot(props) { return h(FitBanner, props); },
					);
				});
			}, "dsh-model-switch: fit banner");
		}

		exports.apply = apply;
		exports.inject = ["connection", "slots"];
		return module.exports;
	}
});
