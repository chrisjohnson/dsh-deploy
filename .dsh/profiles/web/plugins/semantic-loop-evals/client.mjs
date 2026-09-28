// dsh-semantic-loop-evals: Client half (browser bundle).
//
// Registers ONE right-sidebar tab through dsh-better-sidebar's
// `ctx.betterSidebar.registerTab` service. The tab is session-scoped: its
// component receives the sidebar's SessionScope and defaults to showing only
// the CURRENT session's evaluations, with a toggle for all sessions.
//
// It is a pure reader. All data comes from the Host half over the
// authenticated /api fence:
//   connection.rpc.call("/api", "semanticLoopEvals/<endpoint>", payload)
//     list   -> compact rows (no transcript window) + stats + session list
//     detail -> ONE full record, including the transcript window
// The split matters: windows are KB-sized and only the inspected row needs one.
//
// Layout (synced):
//   header  - totals, layer split, session scope, refresh
//    graph  - time axis; a CODE lane and a MODEL lane (plus a dim skip lane)
//             so "which layer decided" is visible at a glance; click a marker
//             to select it
//    ledger - the same evaluations as rows in time order; the selected row is
//             highlighted, and selecting in either place drives the other
//    detail - the selected evaluation: phase-by-phase result + transcript

window.__ModuleLoader__.load({
	id: "dsh-semantic-loop-evals",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		var React = require("react");
		var h = React.createElement;

		var connection = null;

		var COLOR = {
			stuck: "#e5484d",
			watch: "#e8a33d",
			noise: "#8b8b8b",
			codeClear: "#5b7fa6",
			skip: "#c4c4c4",
			grid: "var(--dsw-alias-border-l1, #e4e4e4)",
			text: "var(--dsw-alias-label-primary, #333)",
			dim: "var(--dsw-alias-label-tertiary, #8a8a8a)",
			faint: "var(--dsw-alias-label-secondary, #666)",
			panel: "var(--dsw-alias-bg-base, #fff)",
			raised: "var(--dsw-specific-tip, #f7f8fa)"
		};

		var CSS =
			".sle-root{display:flex;flex-direction:column;height:100%;min-height:0;font:12px/17px Inter,sans-serif;color:" + COLOR.text + "}"
			+ ".sle-head{padding:8px 10px 6px;border-bottom:.5px solid " + COLOR.grid + ";flex:none}"
			+ ".sle-title{display:flex;align-items:center;gap:6px;font:600 12px/16px Inter,sans-serif}"
			+ ".sle-sub{color:" + COLOR.dim + ";font:11px/15px Inter,sans-serif;margin-top:2px;word-break:break-all}"
			+ ".sle-tools{display:flex;align-items:center;gap:6px;margin-top:6px;flex-wrap:wrap}"
			+ ".sle-seg{display:inline-flex;border:.5px solid " + COLOR.grid + ";border-radius:6px;overflow:hidden}"
			+ ".sle-seg button{border:none;background:0 0;color:" + COLOR.faint + ";font:500 11px/16px Inter,sans-serif;padding:2px 7px;cursor:pointer}"
			+ ".sle-seg button.on{background:" + COLOR.raised + ";color:" + COLOR.text + ";font-weight:600}"
			+ ".sle-btn{border:.5px solid " + COLOR.grid + ";background:0 0;border-radius:6px;color:" + COLOR.faint + ";font:500 11px/16px Inter,sans-serif;padding:2px 7px;cursor:pointer}"
			+ ".sle-btn:hover{background:" + COLOR.raised + "}"
			+ ".sle-counts{display:flex;gap:8px;flex-wrap:wrap;margin-top:6px;font:11px/15px Inter,sans-serif;color:" + COLOR.faint + "}"
			+ ".sle-count b{font-weight:600;color:" + COLOR.text + "}"
			+ ".sle-dot{display:inline-block;width:7px;height:7px;border-radius:999px;margin-right:3px;vertical-align:middle}"
			+ ".sle-graph{flex:none;padding:4px 2px 0;border-bottom:.5px solid " + COLOR.grid + "}"
			+ ".sle-graph svg{display:block}"
			+ ".sle-lane{font:10px/12px Inter,sans-serif;fill:" + COLOR.dim + "}"
			+ ".sle-axis{font:10px/12px ui-monospace,monospace;fill:" + COLOR.dim + "}"
			+ ".sle-mk{cursor:pointer}"
			+ ".sle-mk:hover{opacity:.75}"
			+ ".sle-list{flex:1 1 auto;overflow:auto;min-height:60px}"
			+ ".sle-row{display:flex;align-items:center;gap:6px;padding:4px 10px;border-bottom:.5px solid " + COLOR.grid + ";cursor:pointer}"
			+ ".sle-row:hover{background:" + COLOR.raised + "}"
			+ ".sle-row.on{background:" + COLOR.raised + ";box-shadow:inset 2px 0 0 " + COLOR.text + "}"
			+ ".sle-ts{font:10px/14px ui-monospace,monospace;color:" + COLOR.dim + ";flex:none}"
			+ ".sle-tag{flex:none;font:600 9px/13px Inter,sans-serif;letter-spacing:.03em;padding:0 4px;border-radius:3px;border:.5px solid " + COLOR.grid + ";color:" + COLOR.faint + "}"
			+ ".sle-tag.code{border-color:#b9cde0;color:#41648a}"
			+ ".sle-tag.model{border-color:#d8c4a0;color:#8a6a2a}"
			+ ".sle-tag.skip{opacity:.6}"
			+ ".sle-verdict{font:600 11px/15px Inter,sans-serif;flex:none}"
			+ ".sle-conf{font:10px/14px ui-monospace,monospace;color:" + COLOR.dim + ";flex:none}"
			+ ".sle-flex{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:" + COLOR.dim + ";font:11px/15px Inter,sans-serif}"
			+ ".sle-empty{padding:16px 12px;color:" + COLOR.dim + ";font:11px/16px Inter,sans-serif}"
			+ ".sle-detail{flex:none;max-height:46%;overflow:auto;border-top:.5px solid " + COLOR.grid + ";background:" + COLOR.raised + ";padding:8px 10px}"
			+ ".sle-dhead{display:flex;align-items:center;justify-content:space-between;gap:6px}"
			+ ".sle-dtitle{font:600 11px/16px Inter,sans-serif}"
			+ ".sle-x{border:none;background:0 0;color:" + COLOR.dim + ";cursor:pointer;font:14px/14px Inter,sans-serif;padding:0 2px}"
			+ ".sle-kv{display:grid;grid-template-columns:auto 1fr;gap:1px 8px;margin:6px 0;font:11px/16px Inter,sans-serif}"
			+ ".sle-k{color:" + COLOR.dim + "}"
			+ ".sle-v{color:" + COLOR.text + ";word-break:break-word}"
			+ ".sle-sect{margin-top:8px;font:600 10px/14px Inter,sans-serif;letter-spacing:.04em;text-transform:uppercase;color:" + COLOR.dim + "}"
			+ ".sle-fp{font:10px/14px ui-monospace,monospace;color:" + COLOR.faint + ";margin-top:2px;word-break:break-all}"
			+ ".sle-pre{margin:4px 0 0;padding:6px;background:" + COLOR.panel + ";border:.5px solid " + COLOR.grid + ";border-radius:6px;font:10px/14px ui-monospace,monospace;white-space:pre-wrap;word-break:break-word;max-height:220px;overflow:auto}";

		function rpc(endpoint, payload) {
			if (!connection) return Promise.reject(new Error("dsh-semantic-loop-evals: connection service unavailable"));
			return connection.rpc.call("/api", "semanticLoopEvals/" + endpoint, payload || {});
		}

		// ---------------------------------------------------------------
		// formatting helpers
		// ---------------------------------------------------------------
		function hhmmss(ts) {
			if (!ts) return "--:--:--";
			var d = new Date(ts);
			if (isNaN(d.getTime())) return "--:--:--";
			function p(n) { return n < 10 ? "0" + n : String(n); }
			return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
		}
		function ms(n) {
			if (typeof n !== "number" || !isFinite(n)) return "-";
			return n >= 1000 ? (n / 1000).toFixed(1) + "s" : Math.round(n) + "ms";
		}
		function shortSession(id) {
			if (!id) return "?";
			var s = String(id).replace(/^session-/, "");
			return s.slice(0, 8);
		}
		// The color of an evaluation, by which layer decided and how it landed.
		function rowColor(r) {
			if (r.skip) return COLOR.skip;
			if (r.band === "stuck") return COLOR.stuck;
			if (r.band === "watch") return COLOR.watch;
			if (r.layer === "code") return r.code && r.code.stuck ? COLOR.stuck : COLOR.codeClear;
			if (r.layer === "model") return COLOR.noise;
			return COLOR.skip;
		}
		function layerLabel(r) {
			if (r.skip) return "skip";
			if (r.layer === "code") return "code";
			if (r.layer === "model") return "model";
			return "?";
		}
		function verdictText(r) {
			if (r.skip) return r.skip;
			return r.verdict || "unparseable";
		}
		// The one-line "why" for a ledger row. The layer tag already says WHICH
		// layer decided, so this says what that layer saw - notably that a model
		// row is an ESCALATION (the code layer ran first and found nothing).
		function rowDetail(r) {
			if (r.skip) return "not evaluated \u00b7 " + r.skip;
			var parts = [];
			if (r.code && r.code.ran) {
				parts.push(r.code.stuck ? "stuck \u00d7" + r.code.stuckCount : "no repetition");
				if (typeof r.code.calls === "number") parts.push(r.code.calls + " calls");
				if (typeof r.code.groupCount === "number") parts.push(r.code.groupCount + " fingerprints");
			} else if (r.layer === "model") {
				parts.push("code detail not recorded");
			}
			if (r.layer === "model") parts.push(ms(r.model && r.model.latencyMs));
			return parts.join(" \u00b7 ");
		}

		// Measured element width - the graph needs real pixels so its labels
		// stay legible in a narrow sidebar (a scaled viewBox would shrink them).
		function useWidth() {
			var st = React.useState(320);
			var ref = React.useRef(null);
			React.useEffect(function () {
				var el = ref.current;
				if (!el) return;
				function measure() { st[1](el.clientWidth || 320); }
				measure();
				var ro = null;
				if (typeof ResizeObserver === "function") {
					ro = new ResizeObserver(measure);
					ro.observe(el);
				} else {
					window.addEventListener("resize", measure);
				}
				return function () {
					if (ro) ro.disconnect();
					else window.removeEventListener("resize", measure);
				};
			}, []);
			return [ref, st[0]];
		}

		// ---------------------------------------------------------------
		// graph: one marker per evaluation, positioned by TIME, split into a
		// code lane and a model lane so the layer that decided is visible.
		// ---------------------------------------------------------------
		var GRAPH_CAP = 300;

		function EvalGraph(props) {
			var records = props.records || [];
			var selectedId = props.selectedId;
			var onSelect = props.onSelect;
			var width = useWidth();
			var ref = width[0];
			var W = width[1] || 320;

			var H = 122;
			var padL = 40;
			var padR = 12;
			var laneCode = 30;
			var laneModel = 62;
			var laneSkip = 90;

			// Only the most recent slice is drawn: a few thousand SVG nodes
			// would stall the sidebar, and the tail is what is being watched.
			var shown = records.length > GRAPH_CAP ? records.slice(-GRAPH_CAP) : records;

			var times = [];
			for (var i = 0; i < shown.length; i++) {
				var t = shown[i].ts ? Date.parse(shown[i].ts) : NaN;
				if (!isNaN(t)) times.push(t);
			}
			var t0 = times.length ? Math.min.apply(null, times) : 0;
			var t1 = times.length ? Math.max.apply(null, times) : 0;
			var span = t1 - t0;
			var usable = Math.max(20, W - padL - padR);

			function xOf(r) {
				var t = r.ts ? Date.parse(r.ts) : NaN;
				if (isNaN(t)) return padL;
				if (!span) return padL + usable / 2;
				return padL + ((t - t0) / span) * usable;
			}

			var marks = [];
			for (var j = 0; j < shown.length; j++) {
				var r = shown[j];
				var x = xOf(r);
				var isSel = r.id === selectedId;
				var color = rowColor(r);

				if (r.skip) {
					// Not evaluated: an explicitly dim tick on its own lane, so a
					// gap in coverage is visible rather than implied.
					marks.push(h("rect", {
						key: "s" + r.id, className: "sle-mk", x: x - 1, y: laneSkip - 4, width: 2, height: 8,
						fill: COLOR.skip, opacity: isSel ? 1 : 0.65, onClick: (function (id) { return function () { onSelect(id); }; })(r.id)
					}, h("title", null, hhmmss(r.ts) + " - skipped (" + r.skip + ")")));
					continue;
				}

				if (r.code && r.code.ran) {
					// Code lane. A stuck code layer is the whole point of the fast
					// path; "clear" is drawn smaller and cooler to read as
					// "ran, found nothing, escalated".
					var codeStuck = !!(r.code.stuck);
					marks.push(h("circle", {
						key: "c" + r.id, className: "sle-mk", cx: x, cy: laneCode, r: codeStuck ? 5 : 3.2,
						fill: codeStuck ? COLOR.stuck : COLOR.codeClear, opacity: codeStuck ? 1 : 0.8,
						stroke: isSel ? COLOR.text : "none", strokeWidth: isSel ? 1.5 : 0,
						onClick: (function (id) { return function () { onSelect(id); }; })(r.id)
					}, h("title", null,
						hhmmss(r.ts) + " - CODE: " + (codeStuck ? "STUCK" : "no qualifying repetition")
						+ (typeof r.code.calls === "number" ? " (" + r.code.calls + " calls, " + r.code.groupCount + " fingerprints)" : "")
						+ (codeStuck ? " x" + r.code.stuckCount : ""))));
				}

				if (r.model) {
					// Model lane. The connecting line is the escalation: the code
					// layer ran, found nothing stuck, and the model was consulted.
					if (r.code && r.code.ran) {
						marks.push(h("line", {
							key: "l" + r.id, x1: x, y1: laneCode + 5, x2: x, y2: laneModel - 5,
							stroke: color, strokeWidth: 0.6, opacity: 0.35
						}));
					}
					marks.push(h("circle", {
						key: "m" + r.id, className: "sle-mk", cx: x, cy: laneModel, r: 4.5,
						fill: color, opacity: 0.95,
						stroke: isSel ? COLOR.text : "none", strokeWidth: isSel ? 1.5 : 0,
						onClick: (function (id) { return function () { onSelect(id); }; })(r.id)
					}, h("title", null,
						hhmmss(r.ts) + " - MODEL: " + (r.verdict || "unparseable")
						+ (r.confidence != null ? " " + r.confidence : "")
						+ " (" + ms(r.model.latencyMs) + ")")));
				}
			}

			var axis = [];
			if (times.length) {
				var stops = [t0, t0 + span / 2, t1];
				for (var k = 0; k < stops.length; k++) {
					var ax = padL + (span ? ((stops[k] - t0) / span) * usable : usable / 2);
					axis.push(h("text", {
						key: "a" + k, className: "sle-axis", x: ax, y: H - 3,
						textAnchor: k === 0 ? "start" : k === stops.length - 1 ? "end" : "middle"
					}, hhmmss(new Date(stops[k]).toISOString())));
				}
			}

			return h("div", { className: "sle-graph", ref: ref },
				h("svg", { width: "100%", height: H, role: "img", "aria-label": "Evaluation timeline" },
					h("line", { x1: padL, y1: laneCode, x2: W - padR, y2: laneCode, stroke: COLOR.grid, strokeWidth: 0.5 }),
					h("line", { x1: padL, y1: laneModel, x2: W - padR, y2: laneModel, stroke: COLOR.grid, strokeWidth: 0.5 }),
					h("line", { x1: padL, y1: laneSkip, x2: W - padR, y2: laneSkip, stroke: COLOR.grid, strokeWidth: 0.5, strokeDasharray: "2 3" }),
					h("text", { className: "sle-lane", x: 2, y: laneCode + 3 }, "code"),
					h("text", { className: "sle-lane", x: 2, y: laneModel + 3 }, "model"),
					h("text", { className: "sle-lane", x: 2, y: laneSkip + 3, opacity: 0.7 }, "skip"),
					marks,
					axis
				),
				records.length > GRAPH_CAP
					? h("div", { className: "sle-sub", style: { padding: "0 8px 4px" } },
						"graph shows the most recent " + GRAPH_CAP + " of " + records.length + " evaluations")
					: null
			);
		}

		// ---------------------------------------------------------------
		// detail: everything behind one evaluation
		// ---------------------------------------------------------------
		function KV(props) {
			return h("div", { className: "sle-kv" },
				h("div", { className: "sle-k" }, props.k),
				h("div", { className: "sle-v" }, props.v)
			);
		}

		function Detail(props) {
			var d = props.detail;
			var onClose = props.onClose;
			if (!d) return null;
			if (d.loading) return h("div", { className: "sle-detail" }, h("div", { className: "sle-empty" }, "loading evaluation\u2026"));
			if (d.error) return h("div", { className: "sle-detail" },
				h("div", { className: "sle-dhead" }, h("div", { className: "sle-dtitle" }, "evaluation"), h("button", { className: "sle-x", onClick: onClose }, "\u00d7")),
				h("div", { className: "sle-empty" }, "could not load: " + d.error));

			var r = d.record;
			if (!r) return null;
			var code = r.code;
			var model = r.model;

			return h("div", { className: "sle-detail" },
				h("div", { className: "sle-dhead" },
					h("div", { className: "sle-dtitle" }, hhmmss(r.ts) + "  \u00b7  " + layerLabel(r) + "  \u00b7  id " + r.id),
					h("button", { className: "sle-x", onClick: onClose, title: "close" }, "\u00d7")),

				h(KV, { k: "session", v: String(r.sessionId || "?") }),
				h(KV, { k: "verdict", v: verdictText(r) + (r.confidence != null ? "  (" + r.confidence + "%)" : "") }),
				h(KV, { k: "band", v: String(r.band || "-") + "   streak " + String(r.streak) + "   mode " + String(r.mode || "-") }),
				h(KV, { k: "outcome", v: String(r.outcome || "-") + (r.skip ? "  (skip: " + r.skip + ")" : "") }),
				h(KV, { k: "latency", v: ms(r.latencyMs) + (r.v ? "   schema v" + r.v : "") }),
				r.events ? h(KV, { k: "events", v: String(r.events.total) + " total / " + String(r.events.substantive) + " substantive" }) : null,

				h("div", { className: "sle-sect" }, "1 \u00b7 code layer (deterministic)"),
				code
					? h("div", null,
						h(KV, { k: "ran", v: code.ran ? "yes" : "no" }),
						typeof code.calls === "number" ? h(KV, { k: "tool calls", v: String(code.calls) }) : null,
						h(KV, { k: "fingerprints", v: String(code.groupCount || 0) + " distinct, " + String((code.stuckGroups || []).length) + " stuck" }),
						code.synthesized ? h("div", { className: "sle-fp", style: { opacity: 0.75 } }, "reconstructed from a v1 decision record") : null,
						(code.stuckGroups || []).length
							? h("div", null,
								h("div", { className: "sle-fp", style: { marginTop: 4 } }, "stuck groups:"),
								(code.stuckGroups || []).map(function (f, i) {
									return h("div", { className: "sle-fp", key: i }, "\u2022 " + f.fp + "   \u00d7" + f.count + "   distinct=" + f.distinctResults);
								}))
							: h("div", { className: "sle-fp" }, "no qualifying repetition in the scanned window"),
						(code.topGroups || []).length
							? h("div", null,
								h("div", { className: "sle-fp", style: { marginTop: 4 } }, "most repeated:"),
								(code.topGroups || []).slice(0, 6).map(function (f, i) {
									return h("div", { className: "sle-fp", key: i }, "\u2022 " + f.fp + "   \u00d7" + f.count + "   distinct=" + f.distinctResults);
								}))
							: null)
					: h("div", { className: "sle-empty", style: { padding: "4px 0" } }, "code layer did not run for this step"),

				h("div", { className: "sle-sect" }, "2 \u00b7 model layer (LLM)"),
				model
					? h("div", null,
						h(KV, { k: "verdict", v: String(model.verdict || "unparseable") + (model.confidence != null ? "  (" + model.confidence + "%)" : "") }),
						h(KV, { k: "latency", v: ms(model.latencyMs) + (model.inferred ? "   confidence inferred" : "") }),
						typeof model.hasReasoning === "boolean" ? h(KV, { k: "thought", v: model.hasReasoning ? "yes (reasoning present)" : "no (thinking disabled)" }) : null,
						model.synthesized ? h("div", { className: "sle-fp", style: { opacity: 0.75 } }, "reconstructed from a v1 decision record (raw response not kept)") : null,
						model.raw ? h("pre", { className: "sle-pre" }, model.raw) : null)
					: h("div", { className: "sle-empty", style: { padding: "4px 0" } },
						r.skip ? "not consulted (step was " + r.skip + ")" : "not consulted (the code layer already decided)"),

				h("div", { className: "sle-sect" }, "transcript window"),
				r.window
					? h("pre", { className: "sle-pre" }, r.window)
					: h("div", { className: "sle-empty", style: { padding: "4px 0" } }, "(no window recorded)")
			);
		}

		// ---------------------------------------------------------------
		// the tab
		// ---------------------------------------------------------------
		function EvalsPanel(props) {
			var scope = props.scope || {};
			var sessionId = scope.sessionId || null;
			var visible = props.visible !== false;

			var dataSt = React.useState({ loading: true, error: null, records: [], stats: null, sessions: [], ledgerFile: null, ledgerError: null });
			var data = dataSt[0], setData = dataSt[1];

			var scopeSt = React.useState("session");
			var scopeMode = scopeSt[0], setScopeMode = scopeSt[1];

			var skipSt = React.useState(false);
			var includeSkipped = skipSt[0], setIncludeSkipped = skipSt[1];

			var selSt = React.useState(null);
			var selectedId = selSt[0], setSelectedId = selSt[1];

			var detSt = React.useState(null);
			var detail = detSt[0], setDetail = detSt[1];

			var tickSt = React.useState(0);
			var refreshTick = tickSt[0], bump = tickSt[1];

			var capSt = React.useState(300);
			var renderCap = capSt[0], setRenderCap = capSt[1];

			// list (and its session index) - refetched when the scope, the
			// skip filter, or the refresh tick changes
			React.useEffect(function () {
				var alive = true;
				var target = scopeMode === "session" ? sessionId : null;
				setData(function (d) { return Object.assign({}, d, { loading: true }); });
				// Skips are ALWAYS fetched: they carry the coverage story (why a
				// step has no evaluation), the header counts them whether or not
				// their rows are shown, and having them locally makes the toggle
				// instant instead of a round trip.
				rpc("list", { sessionId: target, includeSkipped: true, limit: 5000 }).then(
					function (res) {
						if (!alive) return;
						if (res && res.ok && res.value) {
							setData({
								loading: false,
								error: null,
								records: res.value.records || [],
								stats: res.value.stats || null,
								sessions: res.value.sessions || [],
								ledgerFile: res.value.ledgerFile || null,
								ledgerError: res.value.error || null
							});
						} else {
							setData(function (d) {
								return Object.assign({}, d, { loading: false, error: (res && res.error && res.error.message) || "list failed" });
							});
						}
					},
					function (err) {
						if (!alive) return;
						setData(function (d) {
							return Object.assign({}, d, { loading: false, error: String((err && err.message) || err) });
						});
					}
				);
				return function () { alive = false; };
			}, [sessionId, scopeMode, refreshTick]);

			// live-tail while the tab is actually on screen
			React.useEffect(function () {
				if (!visible) return undefined;
				var id = setInterval(function () { bump(function (n) { return n + 1; }); }, 5000);
				return function () { clearInterval(id); };
			}, [visible]);

			// detail for the selected row only (windows are large)
			React.useEffect(function () {
				if (selectedId === null) { setDetail(null); return undefined; }
				var alive = true;
				setDetail({ loading: true, error: null, record: null });
				rpc("detail", { id: selectedId }).then(
					function (res) {
						if (!alive) return;
						if (res && res.ok && res.value && res.value.record) setDetail({ loading: false, error: null, record: res.value.record });
						else setDetail({ loading: false, error: (res && res.error && res.error.message) || "detail failed", record: null });
					},
					function (err) {
						if (!alive) return;
						setDetail({ loading: false, error: String((err && err.message) || err), record: null });
					}
				);
				return function () { alive = false; };
			}, [selectedId]);

			var records = data.records || [];
			var stats = data.stats || null;

			// Session scope label: the raw session id is long, and the operator
			// needs to know WHICH session the numbers belong to.
			var scopeSession = null;
			for (var i = 0; i < (data.sessions || []).length; i++) {
				if (data.sessions[i].sessionId === sessionId) { scopeSession = data.sessions[i]; break; }
			}

			// Counts describe the WHOLE scope (skips included) so the header is
			// the complete picture; the toggle only hides skip ROWS below.
			var counts = { code: 0, model: 0, skipped: 0, stuck: 0 };
			for (var c = 0; c < records.length; c++) {
				if (records[c].skip) counts.skipped++;
				else if (records[c].layer === "code") counts.code++;
				else if (records[c].layer === "model") counts.model++;
				if (records[c].band === "stuck") counts.stuck++;
			}

			var ledgerRecords = includeSkipped ? records : records.filter(function (r) { return !r.skip; });
			var ledgerRows = ledgerRecords.slice().reverse();
			var shownRows = ledgerRows.length > renderCap ? ledgerRows.slice(0, renderCap) : ledgerRows;

			var head = h("div", { className: "sle-head" },
				h("div", { className: "sle-title" },
					h("span", null, "Loop watchdog evaluations")),
				h("div", { className: "sle-sub" },
					scopeMode === "session"
						? (sessionId ? "session " + shortSession(sessionId) + (scopeSession ? " \u00b7 " + scopeSession.count + " evaluations" : "") : "no session bound")
						: "all sessions \u00b7 " + (data.sessions || []).length + " sessions"),
				h("div", { className: "sle-tools" },
					h("div", { className: "sle-seg" },
						h("button", { className: scopeMode === "session" ? "on" : "", onClick: function () { setScopeMode("session"); } }, "this session"),
						h("button", { className: scopeMode === "all" ? "on" : "", onClick: function () { setScopeMode("all"); } }, "all")),
					h("button", { className: includeSkipped ? "sle-btn on" : "sle-btn", onClick: function () { setIncludeSkipped(!includeSkipped); }, title: "include steps the watchdog deliberately did not evaluate" },
						includeSkipped ? "skips shown" : "skips hidden"),
					h("button", { className: "sle-btn", onClick: function () { bump(function (n) { return n + 1; }); } }, data.loading ? "\u2026" : "refresh")),
				h("div", { className: "sle-counts" },
					h("span", { className: "sle-count", title: "decided by the deterministic fingerprint layer alone - no model call" },
						h("span", { className: "sle-dot", style: { background: COLOR.codeClear } }), "code-only ", h("b", null, String(counts.code))),
					h("span", { className: "sle-count", title: "the code layer found no qualifying repetition, so the model adjudicated" },
						h("span", { className: "sle-dot", style: { background: COLOR.noise } }), "model ", h("b", null, String(counts.model))),
					h("span", { className: "sle-count", title: "evaluations landing in the actionable stuck band" },
						h("span", { className: "sle-dot", style: { background: COLOR.stuck } }), "stuck ", h("b", null, String(counts.stuck))),
					h("span", { className: "sle-count", title: "steps deliberately not evaluated (no-signal / cooldown / busy-yield)" },
						h("span", { className: "sle-dot", style: { background: COLOR.skip } }), "skipped ", h("b", null, String(counts.skipped))),
					stats ? h("span", { className: "sle-count", title: "records in the whole ledger file, all sessions" },
						"ledger ", h("b", null, String(stats.total))) : null)
			);

			var body;
			if (data.error) {
				body = h("div", { className: "sle-empty" }, "could not reach the host reader: " + data.error);
			} else if (data.ledgerError === "ledger-missing") {
				body = h("div", { className: "sle-empty" },
					"No ledger yet at " + String(data.ledgerFile || "?") + ".",
					h("br", null),
					"The watchdog writes one record per evaluation; the first entry appears after its next check.");
			} else if (!records.length) {
				body = h("div", { className: "sle-empty" },
					scopeMode === "session"
						? "No evaluations recorded for this session yet. The watchdog records one entry per step it checks (subject to its cooldown), so this fills in as the session runs."
						: "No evaluations recorded yet.");
			} else {
				body = h(React.Fragment, null,
					h(EvalGraph, { records: records, selectedId: selectedId, onSelect: setSelectedId }),
					h("div", { className: "sle-list" },
						shownRows.map(function (r) {
							var color = rowColor(r);
							return h("div", {
								key: r.id,
								className: "sle-row" + (r.id === selectedId ? " on" : ""),
								onClick: function () { setSelectedId(r.id === selectedId ? null : r.id); }
							},
								h("span", { className: "sle-ts" }, hhmmss(r.ts)),
								h("span", { className: "sle-dot", style: { background: color, flex: "none" } }),
								h("span", { className: "sle-tag " + layerLabel(r) }, layerLabel(r)),
								h("span", { className: "sle-verdict", style: { color: r.skip ? COLOR.dim : r.verdict === "LOOP" ? COLOR.stuck : COLOR.text } }, verdictText(r)),
								h("span", { className: "sle-conf" }, r.confidence != null ? String(r.confidence) : ""),
								h("span", { className: "sle-flex" }, rowDetail(r)),
								r.outcome === "intervened" ? h("span", { className: "sle-tag", style: { borderColor: COLOR.stuck, color: COLOR.stuck } }, "steered") : null
							);
						}),
						ledgerRows.length > shownRows.length
							? h("div", { className: "sle-empty", style: { textAlign: "center" } },
								h("button", { className: "sle-btn", onClick: function () { setRenderCap(renderCap + 400); } },
									"show " + Math.min(400, ledgerRows.length - shownRows.length) + " older"))
							: null)
				);
			}

			return h("div", { className: "sle-root" },
				head,
				body,
				h(Detail, { detail: detail, onClose: function () { setSelectedId(null); } })
			);
		}

		var inject = ["connection", "betterSidebar"];

		function apply(ctx) {
			connection = ctx.connection;

			var styleId = "sle-styles";
			if (!document.getElementById(styleId)) {
				var tag = document.createElement("style");
				tag.id = styleId;
				tag.textContent = CSS;
				document.head.appendChild(tag);
			}

			var sidebar = ctx.betterSidebar;
			if (!sidebar) {
				console.error("dsh-semantic-loop-evals: betterSidebar service missing - tab not registered");
				return;
			}

			var register = function () {
				return sidebar.registerTab({
					id: "semantic-loop-kicker:evals",
					title: "Loop evals",
					description: "Watchdog evaluations for this session: deterministic fingerprint checks and model adjudications, per step.",
					order: 55,
					icon: function (size) {
						return h("svg", { width: size || 14, height: size || 14, viewBox: "0 0 16 16", "aria-hidden": "true", fill: "currentColor" },
							h("path", { d: "M1 8.5h3l1.5-4 2.5 8 2-5 1.2 2.5H15v1.5h-4.3l-.7-1.4-2.4 6-2.6-8.2-.6 1.6H1z" }));
						},
					component: function (props) { return h(EvalsPanel, props); }
				});
			};

			// ctx.effect ties the registration to this plugin's fiber; without
			// it a reload would leave the tab registered against a dead plugin.
			if (typeof ctx.effect === "function") ctx.effect(register);
			else register();
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
