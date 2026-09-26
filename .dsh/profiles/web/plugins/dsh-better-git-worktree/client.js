// dsh-better-git-worktree — Client half (browser bundle).
//
// Structure
// ---------
//   1. The inlined official Workspace Browser (see scripts/build-client.mjs).
//      The harness exposes one `single` slot for the sidebar browsing region,
//      and this plugin needs to decorate its session rows — so it stands in for
//      the official row (exactly the trade dsh-git-worktree makes) instead of
//      fighting it for the same seat.
//   2. The status store: a polled projection of the Host's worktree registry.
//   3. The decorated Browser wrapper, which pins a per-session decoration onto
//      the session summaries the official Browser renders.
//   4. The two additive surfaces: the composer's Worktree switch (blank
//      sessions only) and the session-header Worktree menu.
//   5. An optional sidebar panel that opens through dsh-better-sidebar when it
//      is installed, and an inline modal with the same content when it is not.
window.__ModuleLoader__.load({
	id: "dsh-better-git-worktree",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		var React = require("react");
		var jsxRuntime = require("react/jsx-runtime");
		var primitives = require("@deepseek-ai/dsh-client-ui-primitives");

		// ════════════════════════════════════════════════════════════════════
		// 1. Inlined official Workspace Browser
		// ════════════════════════════════════════════════════════════════════
		var officialWorkspace = (function () {

		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let _deepseek_ai_cordis = require("@deepseek-ai/cordis");
		let _deepseek_ai_dsh_client_store = require("@deepseek-ai/dsh-client-store");
		let react_jsx_runtime = require("react/jsx-runtime");
		let react = require("react");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		//#region lib/types/client/navigation.js
		/** Workspace archive and directory UI capability. */
		/** Structured directory failure exposed to directory UI consumers. */
		var DirectoryBrowseError = class extends Error {
			rpcError;
			name = "DirectoryBrowseError";
			/** @param rpcError - Host directory business failure. */
			constructor(rpcError) {
				super(`directory browse failed: ${rpcError.code}: ${rpcError.message}`);
				this.rpcError = rpcError;
			}
		};
		/** Implements Workspace archive and directory UI operations. */
		var UiWorkspaceService = class extends _deepseek_ai_cordis.Service {
			directoryPicker;
			workspaces;
			sessions;
			connecting = /* @__PURE__ */ new Map();
			lifetime = new AbortController();
			/**
			* @param ctx - Client root Context.
			* @param directoryPicker - the directory-picking Remote namespace.
			* @param workspaces - pure Workspace Controller.
			* @param sessions - pure Session Controller.
			*/
			constructor(ctx, directoryPicker, workspaces, sessions) {
				super(ctx, "uiWorkspace");
				this.directoryPicker = directoryPicker;
				this.workspaces = workspaces;
				this.sessions = sessions;
				ctx.effect(() => this.watchNavigation(), "ui-workspace: Workspace navigation policy");
			}
			async connectWorkspace(workspaceId) {
				const workspace = this.workspaces.list.getSnapshot().items.find((item) => item.workspaceId === workspaceId);
				if (workspace === void 0) throw new Error(`uiWorkspace.connectWorkspace: unknown workspace ${workspaceId}`);
				const inflight = this.connecting.get(workspaceId);
				if (inflight !== void 0) return inflight;
				const archived = this.workspaces.list.getSnapshot().archivedSessionIds;
				const sessions = this.sessions.list.getSnapshot();
				for (const id of sessions.ids) {
					const summary = sessions.byId[id];
					if (summary !== void 0 && summary.blank && summary.cwd === workspace.path && workspace.sessionIds.includes(summary.id) && !archived.includes(summary.id)) return summary.id;
				}
				const attempt = this.sessions.create({ workspaceId }).finally(() => {
					this.connecting.delete(workspaceId);
				});
				this.connecting.set(workspaceId, attempt);
				return attempt;
			}
			openSession(sessionId) {
				this.sessions.open(sessionId);
				this.ctx.layout.selectPanel(null);
			}
			async openWorkspace(workspaceId, beforeOpen) {
				const navigation = AbortSignal.any([this.ctx.layout.beginNavigation(), this.lifetime.signal]);
				const isCurrent = () => !navigation.aborted;
				const sessionId = await this.connectWorkspace(workspaceId);
				if (!isCurrent()) return;
				beforeOpen?.(sessionId);
				if (isCurrent()) this.openSession(sessionId);
			}
			async forkSession(sessionId) {
				const navigation = AbortSignal.any([this.ctx.layout.beginNavigation(), this.lifetime.signal]);
				const childId = await this.sessions.fork({
					sessionId,
					increaseTitle: true
				});
				if (!navigation.aborted) this.openSession(childId);
			}
			startSession(workspaceId) {
				const workspace = this.workspaces.list.getSnapshot();
				const sessions = this.sessions.list.getSnapshot();
				const current = sessions.current;
				const currentWorkspaceId = current === void 0 ? void 0 : workspace.items.find((item) => item.sessionIds.includes(current))?.workspaceId;
				const recent = workspace.phase === "ready" && sessions.phase === "ready" ? recentWorkspace(workspace.items, sessions.byId) : void 0;
				const target = workspaceId ?? currentWorkspaceId ?? recent;
				if (target === void 0) {
					this.sessions.clear();
					this.ctx.layout.selectPanel(null);
					return;
				}
				this.openWorkspace(target).catch((reason) => {
					console.warn("new session failed:", reason);
				});
			}
			async archiveSession(sessionId) {
				await this.workspaces.archiveSession(sessionId);
			}
			async pickDirectory() {
				const result = await this.directoryPicker.pick();
				if (!result.ok) throw new Error(`directory picker failed: ${result.error.message}`);
				return result.value;
			}
			async listDirectory(path, signal) {
				const result = await this.directoryPicker.list(path, signal);
				if (!result.ok) throw new DirectoryBrowseError(result.error);
				return result.value;
			}
			async createDirectory(path, name) {
				const result = await this.directoryPicker.createDirectory(path, name);
				if (!result.ok) throw new DirectoryBrowseError(result.error);
				return result.value;
			}
			watchNavigation() {
				let initial = "waiting";
				const reconcile = () => {
					if (this.lifetime.signal.aborted) return;
					if (this.clearArchivedCurrent()) return;
					if (initial !== "waiting") return;
					const workspace = this.workspaces.list.getSnapshot();
					const sessions = this.sessions.list.getSnapshot();
					if (workspace.phase !== "ready" || sessions.phase !== "ready") return;
					if (sessions.current !== void 0) {
						initial = "done";
						return;
					}
					const target = recentWorkspace(workspace.items, sessions.byId);
					if (target === void 0) {
						initial = "done";
						return;
					}
					initial = "connecting";
					this.connectWorkspace(target).then((sessionId) => {
						if (this.lifetime.signal.aborted) return;
						if (this.sessions.list.getSnapshot().current === void 0) this.sessions.open(sessionId);
						initial = "done";
					}, (reason) => {
						if (this.lifetime.signal.aborted) return;
						initial = "waiting";
						console.warn("initial workspace selection failed:", reason);
					});
				};
				const disposeWorkspaces = this.workspaces.list.subscribe(reconcile);
				const disposeSessions = this.sessions.list.subscribe(reconcile);
				reconcile();
				return () => {
					this.lifetime.abort();
					disposeSessions();
					disposeWorkspaces();
				};
			}
			/** @returns true when an archived current selection was cleared. */
			clearArchivedCurrent() {
				const current = this.sessions.list.getSnapshot().current;
				if (current === void 0 || !this.workspaces.list.getSnapshot().archivedSessionIds.includes(current)) return false;
				this.sessions.clear();
				return true;
			}
		};
		/** Stable tie-breaking follows Host Workspace order. */
		function recentWorkspace(workspaces, sessions) {
			let selected;
			let selectedTime = Number.NEGATIVE_INFINITY;
			for (const workspace of workspaces) {
				let latest = Number.NEGATIVE_INFINITY;
				for (const sessionId of workspace.sessionIds) {
					const session = sessions[sessionId];
					if (session !== void 0) latest = Math.max(latest, session.updatedAt);
				}
				if (latest === Number.NEGATIVE_INFINITY) latest = Date.parse(workspace.createdAt);
				if (selected === void 0 || latest > selectedTime) {
					selected = workspace.workspaceId;
					selectedTime = latest;
				}
			}
			return selected;
		}
		//#endregion
		//#region lib/types/client/stores.js
		/**
		* The workspace browser's viewing store: the session-list grouping mode,
		* persisted across reloads. Module level exports the factory only (a
		* module-level handle would pin the store identity across plugin reloads);
		* register() receives the factory and the browser derives its PropsStore
		* share from the return type.
		*/
		/** Browser-local order account for the hierarchy-free flat Session list. */
		const FLAT_SESSION_ORDER_KEY = "__flat_session_order__";
		/**
		* Create the workspace browser viewing store handle.
		* @returns the store handle (spec + type + identity + factory in one).
		*/
		function createWorkspaceViewStore() {
			return (0, _deepseek_ai_dsh_client_store.defineStore)({
				init: () => ({
					groupBy: "workspace",
					orderBy: "updated",
					groupExpansion: {},
					sessionOrderByAccount: {},
					sessionUpdatedAtByAccount: {}
				}),
				persist: "dsh.workspace.view.v5",
				actions: {
					setGroupBy: (d, mode) => {
						d.groupBy = mode;
					},
					setOrderBy: (d, mode) => {
						d.orderBy = mode;
					},
					setGroupExpanded: (d, key, expanded) => {
						d.groupExpansion[key] = expanded;
					},
					retainAccountKeys: (d, workspaceKeys) => {
						const retained = new Set(workspaceKeys);
						d.groupExpansion = Object.fromEntries(Object.entries(d.groupExpansion).filter(([key]) => retained.has(key)));
						d.sessionOrderByAccount = Object.fromEntries(Object.entries(d.sessionOrderByAccount).filter(([key]) => retained.has(key)));
						d.sessionUpdatedAtByAccount = Object.fromEntries(Object.entries(d.sessionUpdatedAtByAccount).filter(([key]) => retained.has(key)));
					},
					syncSessionOrderAccount: (d, accountKey, order, updatedAt) => {
						d.sessionOrderByAccount[accountKey] = order;
						d.sessionUpdatedAtByAccount[accountKey] = updatedAt;
					},
					setSessionOrder: (d, accountKey, order) => {
						d.sessionOrderByAccount[accountKey] = order;
					}
				}
			});
		}
		//#endregion
		//#region ../../../node_modules/.pnpm/clsx@2.1.1/node_modules/clsx/dist/clsx.mjs
		function r(e) {
			var t, f, n = "";
			if ("string" == typeof e || "number" == typeof e) n += e;
			else if ("object" == typeof e) if (Array.isArray(e)) {
				var o = e.length;
				for (t = 0; t < o; t++) e[t] && (f = r(e[t])) && (n && (n += " "), n += f);
			} else for (f in e) e[f] && (n && (n += " "), n += f);
			return n;
		}
		function clsx() {
			for (var e, t, f = 0, n = "", o = arguments.length; f < o; f++) (e = arguments[f]) && (t = r(e)) && (n && (n += " "), n += t);
			return n;
		}
		//#endregion
		//#region ../../util/workspace-path/src/index.ts
		/** Whether a path uses a Windows drive or UNC prefix. */
		function isWindowsStylePath(value) {
			return /^[A-Za-z]:[/\\]/.test(value) || value.startsWith("\\\\");
		}
		/**
		* Abbreviate a POSIX home directory for display.
		* @param path - Absolute or already-short display path.
		* @param home - Host account home; absent skips abbreviation.
		* @returns `~` or `~/…` for the POSIX home and its descendants, otherwise `path`.
		*/
		function abbreviateHomePath(path, home) {
			if (home === void 0 || home === "") return path;
			if (isWindowsStylePath(path) || isWindowsStylePath(home)) return path;
			const root = home.replace(/\/+$/, "");
			if (root === "" || root === "/") return path;
			if (path.replace(/\/+$/, "") === root) return "~";
			if (path.startsWith(`${root}/`)) return `~${path.slice(root.length)}`;
			return path;
		}
		/**
		* Read the final non-empty segment of a Workspace path for display.
		* Workspace-label surfaces use this helper instead of deriving another basename.
		* @param path - Workspace directory path using POSIX or Windows separators.
		* @returns the final segment, or an empty string for a separator-only path.
		*/
		function workspaceTitleOf(path) {
			const trimmed = path.replace(/[/\\]+$/, "");
			const separator = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
			return trimmed.slice(separator + 1);
		}
		//#endregion
		//#region lib/types/client/subagent-lineage.js
		/** UI Workspace-owned projection of descendant counts from Session summaries. */
		/**
		* Index uninterrupted subagent descendants under each ancestor.
		* @param summaries - Session summaries keyed by id.
		* @returns descendant totals keyed by possible parent id.
		*/
		function indexSubagentDescendants(summaries) {
			const indexed = /* @__PURE__ */ new Map();
			for (const descendant of Object.values(summaries)) {
				if (descendant.origin !== "subagent") continue;
				const seen = /* @__PURE__ */ new Set();
				let current = descendant;
				while (current?.origin === "subagent" && current.parentId !== void 0 && !seen.has(current.id)) {
					seen.add(current.id);
					const aggregate = indexed.get(current.parentId);
					if (aggregate === void 0) indexed.set(current.parentId, {
						count: 1,
						runningCount: descendant.running ? 1 : 0
					});
					else {
						aggregate.count += 1;
						if (descendant.running) aggregate.runningCount += 1;
					}
					current = summaries[current.parentId];
				}
			}
			return indexed;
		}
		/**
		* Resolve the Workspace browser group that owns one Session.
		* @param workspaces - authoritative Workspace membership.
		* @param sessionId - Session whose browser group is required.
		* @returns owning Workspace id, or {@link UNGROUPED_KEY} when no Workspace accounts for it.
		*/
		function owningGroupKey(workspaces, sessionId) {
			return workspaces.find((workspace) => workspace.sessionIds.includes(sessionId))?.workspaceId ?? "";
		}
		/**
		* Directory display label: basename of the path (both separators accepted).
		* Ungrouped-bucket fallback for surfaces without a workspace title.
		* @param cwd - directory path, or undefined for the ungrouped bucket.
		* @returns basename, the raw cwd when it has no basename, or an empty ungrouped marker.
		*/
		function workspaceLabel(cwd) {
			if (cwd === void 0 || cwd === "") return "";
			const base = workspaceTitleOf(cwd);
			return base !== "" ? base : cwd;
		}
		/** Recency comparator: newest first, id as the deterministic tiebreak (ids are unique per group). */
		function byRecency(a, b) {
			if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt;
			return a.id < b.id ? -1 : 1;
		}
		/**
		* Ordinary sessions are visible; among blank sessions, only the current one
		* is visible. Subagent children use their parent header catalog; archived
		* sessions are visible nowhere, while their accounting slots remain so
		* unarchiving restores position.
		*/
		function sessionVisible(session, current, archived) {
			return session.origin !== "subagent" && !archived.has(session.id) && (!session.blank || session.id === current);
		}
		/**
		* A blank session is the selected Workspace's provisional New Session row;
		* its canonical title never enters search (blank rows are query-excluded)
		* and the renderer localizes its display label.
		*/
		function sessionTitle(session) {
			return session.blank ? "" : session.displayTitle;
		}
		/** The list projection alone owns the best-effort active-Schedule indicator. */
		function hasActiveSchedule(session) {
			return (session.projectionValues?.schedule?.length ?? 0) > 0;
		}
		/** Build one group without projecting session lineage into presentation. */
		function buildGroup(key, workspaceId, cwd, createdAt, label, members, order) {
			const sessions = [...members];
			if (order === "recency") sessions.sort(byRecency);
			return {
				key,
				workspaceId,
				cwd,
				createdAt,
				label,
				sessions
			};
		}
		/** Apply a stored Ungrouped order and append newly loose Sessions by recency. */
		function orderedUngrouped(members, stored) {
			const byId = new Map(members.map((session) => [session.id, session]));
			const included = /* @__PURE__ */ new Set();
			const ordered = [];
			for (const key of stored) {
				const session = byId.get(key);
				if (session === void 0 || included.has(key)) continue;
				ordered.push(session);
				included.add(key);
			}
			for (const session of [...members].sort(byRecency)) {
				if (included.has(session.id)) continue;
				ordered.push(session);
			}
			return ordered;
		}
		/**
		* Group Sessions by Host Workspace: one group per entity in stable Host
		* order, with members resolved from sessionIds in their stored order. Sessions
		* outside every Workspace trail in the browser-local Ungrouped order, which
		* falls back to recency before that order is initialized.
		*/
		function groupByWorkspace(list, workspaces, archived, ungroupedOrder) {
			const groups = [];
			const accounted = /* @__PURE__ */ new Set();
			for (const workspace of workspaces) {
				const members = [];
				for (const id of workspace.sessionIds) {
					const summary = list.byId[id];
					if (summary === void 0) continue;
					accounted.add(id);
					if (!sessionVisible(summary, list.current, archived)) continue;
					members.push(summary);
				}
				groups.push(buildGroup(workspace.workspaceId, workspace.workspaceId, workspace.path, Date.parse(workspace.createdAt), workspace.title, members, "account"));
			}
			const stray = list.ids.map((id) => list.byId[id]).filter((s) => s !== void 0 && !accounted.has(s.id) && sessionVisible(s, list.current, archived));
			if (stray.length > 0) groups.push(buildGroup("", void 0, void 0, void 0, "", ungroupedOrder === void 0 ? stray : orderedUngrouped(stray, ungroupedOrder), ungroupedOrder === void 0 ? "recency" : "account"));
			return groups;
		}
		/** Keep navigation presentation independent from domain-owned interaction objects. */
		function visiblePendingKind(kind) {
			switch (kind) {
				case "approval":
				case "plan-review":
				case "question": return kind;
				default: return;
			}
		}
		function sessionNode(s, descendants, pendingInteractions) {
			const pendingInteraction = visiblePendingKind(pendingInteractions.get(s.id)?.kind);
			return {
				id: s.id,
				title: sessionTitle(s),
				blank: s.blank,
				running: s.running,
				runningSubagentCount: descendants.get(s.id)?.runningCount ?? 0,
				completed: s.completed === true,
				hasActiveSchedule: hasActiveSchedule(s),
				updatedAt: s.updatedAt,
				...s.__betterGitWorktree === void 0 ? {} : { __betterGitWorktree: s.__betterGitWorktree },
				...pendingInteraction === void 0 ? {} : { pendingInteraction }
			};
		}
		/**
		* Derive the workspace browser groups with every session as a top-level row.
		*
		* Every group shows; sessions populate under expanded groups in the selected
		* local order. Blank sessions are excluded except for the selected
		* provisional New Session row; archived sessions are excluded everywhere.
		* Content search lives outside this derivation
		* (see {@link deriveSearchResults}).
		* @param list - sessions list snapshot (`current` feeds containsCurrent).
		* @param workspaces - real workspaces in stable Host order.
		* @param archivedSessionIds - registry-global archive set.
		* @param pendingInteractions - pending UI interactions by Session.
		* @param view - local expansion arrays.
		* @returns group sections in render order.
		*/
		function deriveGroups(list, workspaces, archivedSessionIds, pendingInteractions, view) {
			const archived = new Set(archivedSessionIds);
			const expandedGroups = new Set(view.expandedGroups);
			const descendants = indexSubagentDescendants(list.byId);
			const currentGroup = list.current === void 0 ? void 0 : owningGroupKey(workspaces, list.current);
			const groups = [];
			for (const g of groupByWorkspace(list, workspaces, archived, view.ungroupedOrder)) {
				const expanded = expandedGroups.has(g.key);
				groups.push({
					key: g.key,
					workspaceId: g.workspaceId,
					cwd: g.cwd,
					createdAt: g.createdAt,
					label: g.label,
					sessionCount: g.sessions.length,
					expanded,
					containsCurrent: g.key === currentGroup,
					sessions: expanded ? g.sessions.map((session) => sessionNode(session, descendants, pendingInteractions)) : []
				});
			}
			return groups;
		}
		/**
		* Derive the flat session list ("In one list" mode): every session — fork
		* children included — as a top-level row, strictly newest-first. No grouping,
		* no parent/child adjacency. Content search lives outside this derivation
		* (see {@link deriveSearchResults}).
		* @param list - sessions list snapshot.
		* @param archivedSessionIds - registry-global archive set.
		* @param pendingInteractions - pending UI interactions by Session.
		* @returns flat rows in render order.
		*/
		function deriveFlat(list, archivedSessionIds, pendingInteractions) {
			const archived = new Set(archivedSessionIds);
			const descendants = indexSubagentDescendants(list.byId);
			const rows = [];
			for (const id of list.ids) {
				const s = list.byId[id];
				if (s === void 0 || !sessionVisible(s, list.current, archived)) continue;
				rows.push(s);
			}
			rows.sort(byRecency);
			return rows.map((session) => sessionNode(session, descendants, pendingInteractions));
		}
		/**
		* Merge immediate title/Workspace substring matches with ranked Host content
		* matches. Local rows lead newest-first, content-only rows retain backend
		* order, and duplicate sessions receive the backend snippet in place.
		* @param list - session metadata authority.
		* @param workspaces - Workspace membership and display labels.
		* @param query - caller text; surrounding whitespace is ignored.
		* @param archivedSessionIds - registry-global archive set (members never match).
		* @param pendingInteractions - pending UI interactions by Session.
		* @param content - ranked Host content-search page.
		* @param limit - protocol-owned maximum merged row count.
		* @returns bounded deduplicated flat rows and a refine-query hint bit.
		*/
		function deriveSearchResults(list, workspaces, query, archivedSessionIds, pendingInteractions, content, limit) {
			const q = query.trim().toLowerCase();
			if (q === "") return {
				items: [],
				hasMore: false
			};
			const archived = new Set(archivedSessionIds);
			const descendants = indexSubagentDescendants(list.byId);
			const workspaceBySession = /* @__PURE__ */ new Map();
			for (const workspace of workspaces) for (const sessionId of workspace.sessionIds) if (!workspaceBySession.has(sessionId)) workspaceBySession.set(sessionId, workspace.title);
			const labelOf = (summary) => workspaceBySession.get(summary.id) ?? workspaceLabel(summary.cwd);
			const contentBySession = /* @__PURE__ */ new Map();
			for (const item of content.items) if (!contentBySession.has(item.sessionId)) contentBySession.set(item.sessionId, item);
			const local = [];
			for (const id of list.ids) {
				const summary = list.byId[id];
				if (summary === void 0 || summary.blank || !sessionVisible(summary, list.current, archived)) continue;
				if (sessionTitle(summary).toLowerCase().includes(q) || labelOf(summary).toLowerCase().includes(q)) local.push(summary);
			}
			local.sort(byRecency);
			const ordered = [];
			const included = /* @__PURE__ */ new Set();
			const include = (summary) => {
				if (included.has(summary.id)) return;
				included.add(summary.id);
				ordered.push(summary);
			};
			for (const summary of local) include(summary);
			for (const item of content.items) {
				const summary = list.byId[item.sessionId];
				if (summary !== void 0 && !summary.blank && sessionVisible(summary, list.current, archived)) include(summary);
			}
			return {
				items: ordered.slice(0, limit).map((summary) => {
					const match = contentBySession.get(summary.id);
					const pendingInteraction = visiblePendingKind(pendingInteractions.get(summary.id)?.kind);
					return {
						id: summary.id,
						title: sessionTitle(summary),
						workspace: labelOf(summary),
						running: summary.running,
						runningSubagentCount: descendants.get(summary.id)?.runningCount ?? 0,
						...summary.__betterGitWorktree === void 0 ? {} : { __betterGitWorktree: summary.__betterGitWorktree },
						...pendingInteraction === void 0 ? {} : { pendingInteraction },
						completed: summary.completed === true,
						hasActiveSchedule: hasActiveSchedule(summary),
						...match === void 0 ? {} : { snippet: match.snippet }
					};
				}),
				hasMore: content.hasMore || ordered.length > limit
			};
		}
		//#endregion
		//#region \0dsh-css:/home/runner/work/deepseek-harness/deepseek-harness/packages/client/ui-workspace/src/client/rows/Rows.module.css.mjs
		const css$2 = ".YDXeBa_projectRow,.YDXeBa_sessionRow{cursor:pointer;user-select:none;color:var(--dsw-alias-label-primary);border-radius:8px;align-items:center;gap:6px;padding:0 8px;display:flex}.YDXeBa_projectRow:hover,.YDXeBa_sessionRow:hover,.YDXeBa_sessionRow.YDXeBa_selected{background:var(--dsw-alias-interactive-bg-hover)}.YDXeBa_searchResultRow{box-sizing:border-box;cursor:pointer;text-align:left;width:100%;min-height:48px;color:var(--dsw-alias-label-primary);background:0 0;border:none;border-radius:8px;flex-direction:column;align-items:stretch;padding:4px 8px;display:flex}.YDXeBa_searchResultRow:hover,.YDXeBa_searchResultRow.YDXeBa_selected{background:var(--dsw-alias-interactive-bg-hover)}.YDXeBa_searchResultHeading{align-items:center;min-width:0;display:flex}.YDXeBa_searchResultTitle{text-overflow:ellipsis;white-space:nowrap;flex:0 auto;min-width:0;margin-left:4px;font-size:14px;line-height:20px;overflow:hidden}.YDXeBa_searchResultMeta{align-items:center;gap:6px;min-width:0;margin-left:20px;display:flex}.YDXeBa_searchResultWorkspace,.YDXeBa_searchResultSnippet{text-overflow:ellipsis;white-space:nowrap;font-size:12px;line-height:17px;overflow:hidden}.YDXeBa_searchResultWorkspace{max-width:40%;color:var(--dsw-alias-label-tertiary);flex:none}.YDXeBa_searchResultSnippet{min-width:0;color:var(--dsw-alias-label-secondary);flex:1}.YDXeBa_projectRow{box-sizing:border-box;align-items:center;height:34px}.YDXeBa_projectRow .YDXeBa_rowActions{height:20px}.YDXeBa_sessionRow{height:32px;animation:YDXeBa_row-in .15s var(--ds-ease-in-out);gap:0}.YDXeBa_sessionRow .YDXeBa_title{margin:0 6px 0 4px}.YDXeBa_flatSessionRowWithoutStatus .YDXeBa_title{margin-left:0}@keyframes YDXeBa_row-in{0%{opacity:0}}.YDXeBa_slot{width:16px;height:20px;color:var(--dsw-alias-label-tertiary);flex:none;justify-content:center;align-items:center;display:inline-flex}.YDXeBa_visuallyHidden{clip:rect(0 0 0 0);white-space:nowrap;width:1px;height:1px;position:absolute;overflow:hidden}.YDXeBa_folderActive{color:var(--dsw-alias-state-business-primary)}.YDXeBa_projectRow .YDXeBa_chevron{display:none}.YDXeBa_projectRow:hover .YDXeBa_chevron{display:inline-flex}.YDXeBa_projectRow:hover .YDXeBa_folder{display:none}.YDXeBa_arrow{transition:transform .15s var(--ds-ease-in-out)}.YDXeBa_arrowOpen{transform:rotate(90deg)}.YDXeBa_projectText{flex-direction:column;flex:1;gap:2px;min-width:0;display:flex}.YDXeBa_title{text-overflow:ellipsis;white-space:nowrap;min-width:0;font-size:14px;line-height:20px;overflow:hidden}.YDXeBa_renameInput{border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-button-elevated-fill);min-width:0;color:inherit;border-radius:4px;outline:none;padding:0 2px;font-size:14px;line-height:20px}.YDXeBa_sessionRow .YDXeBa_title{flex:1}.YDXeBa_meta{text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:20px;overflow:hidden}.YDXeBa_time{color:var(--dsw-alias-label-tertiary);flex:none;font-size:12px;line-height:20px}.YDXeBa_scheduleIndicator{width:16px;height:20px;color:var(--dsw-alias-label-tertiary);flex:none;justify-content:center;align-items:center;margin-right:6px;display:inline-flex}.YDXeBa_searchScheduleIndicator{margin-left:4px;margin-right:0}.YDXeBa_dot{flex:none}.YDXeBa_rowActions{flex:none;align-items:center;gap:12px;display:none}.YDXeBa_projectRow:hover .YDXeBa_rowActions,.YDXeBa_sessionRow:hover .YDXeBa_rowActions,.YDXeBa_projectRow.YDXeBa_menuOpen .YDXeBa_rowActions,.YDXeBa_sessionRow.YDXeBa_menuOpen .YDXeBa_rowActions{display:inline-flex}.YDXeBa_sessionRow:hover .YDXeBa_time,.YDXeBa_sessionRow.YDXeBa_menuOpen .YDXeBa_time{display:none}.YDXeBa_projectRow.YDXeBa_menuOpen,.YDXeBa_sessionRow.YDXeBa_menuOpen{background:var(--dsw-alias-interactive-bg-hover)}.YDXeBa_sessionRow.YDXeBa_dropBefore,.YDXeBa_sessionRow.YDXeBa_dropAfter{position:relative}.YDXeBa_sessionRow.YDXeBa_dropBefore:before,.YDXeBa_sessionRow.YDXeBa_dropAfter:after{content:\"\";z-index:1;background:linear-gradient(55deg, transparent calc(50% - 1px), var(--dsw-alias-state-business-primary) calc(50% - 1px) calc(50% + 1px), transparent calc(50% + 1px)) 0 0 / 5px 7px no-repeat, linear-gradient(125deg, transparent calc(50% - 1px), var(--dsw-alias-state-business-primary) calc(50% - 1px) calc(50% + 1px), transparent calc(50% + 1px)) 0 5px / 5px 7px no-repeat, linear-gradient(var(--dsw-alias-state-business-primary) 0 0) 4px 5px / calc(100% - 4px) 2px no-repeat;pointer-events:none;height:12px;position:absolute;left:0;right:4px}.YDXeBa_sessionRow.YDXeBa_dropBefore:before{top:-7px}.YDXeBa_sessionRow.YDXeBa_dropAfter:after{bottom:-7px}.YDXeBa_hoverContent{flex-direction:column;gap:8px;display:flex}.YDXeBa_hoverTitle{color:#fff;overflow-wrap:break-word;font-size:14px;line-height:20px}.YDXeBa_hoverPath{color:#cfd3d6;word-break:break-all;font-size:12px;line-height:16px}.YDXeBa_hoverTime{color:#cfd3d6;font-size:12px;line-height:16px}.YDXeBa_hoverStatus{color:#adb2b8;align-items:center;gap:8px;font-size:12px;line-height:20px;display:flex}.YDXeBa_iconButton{cursor:pointer;width:16px;height:16px;color:var(--dsw-alias-label-tertiary);background:0 0;border:none;border-radius:4px;flex:none;justify-content:center;align-items:center;padding:0;display:inline-flex}.YDXeBa_iconButton:hover{color:var(--dsw-alias-label-primary)}.YDXeBa_chevron{color:var(--dsw-alias-label-caption)}@media (prefers-reduced-motion:reduce){.YDXeBa_sessionRow,.YDXeBa_arrow{transition:none;animation:none}}";
		const tagId$2 = "@deepseek-ai/dsh-client-ui-workspace/Rows.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$2) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@deepseek-ai/dsh-client-ui-workspace";
			tag.dataset.pluginCss = tagId$2;
			tag.textContent = css$2;
			document.head.appendChild(tag);
		}
		var Rows_module_css_default = {
			"arrow": "YDXeBa_arrow",
			"arrowOpen": "YDXeBa_arrowOpen",
			"chevron": "YDXeBa_chevron",
			"dot": "YDXeBa_dot",
			"dropAfter": "YDXeBa_dropAfter",
			"dropBefore": "YDXeBa_dropBefore",
			"flatSessionRowWithoutStatus": "YDXeBa_flatSessionRowWithoutStatus",
			"folder": "YDXeBa_folder",
			"folderActive": "YDXeBa_folderActive",
			"hoverContent": "YDXeBa_hoverContent",
			"hoverPath": "YDXeBa_hoverPath",
			"hoverStatus": "YDXeBa_hoverStatus",
			"hoverTime": "YDXeBa_hoverTime",
			"hoverTitle": "YDXeBa_hoverTitle",
			"iconButton": "YDXeBa_iconButton",
			"menuOpen": "YDXeBa_menuOpen",
			"meta": "YDXeBa_meta",
			"projectRow": "YDXeBa_projectRow",
			"projectText": "YDXeBa_projectText",
			"renameInput": "YDXeBa_renameInput",
			"row-in": "YDXeBa_row-in",
			"rowActions": "YDXeBa_rowActions",
			"scheduleIndicator": "YDXeBa_scheduleIndicator",
			"searchResultHeading": "YDXeBa_searchResultHeading",
			"searchResultMeta": "YDXeBa_searchResultMeta",
			"searchResultRow": "YDXeBa_searchResultRow",
			"searchResultSnippet": "YDXeBa_searchResultSnippet",
			"searchResultTitle": "YDXeBa_searchResultTitle",
			"searchResultWorkspace": "YDXeBa_searchResultWorkspace",
			"searchScheduleIndicator": "YDXeBa_searchScheduleIndicator",
			"selected": "YDXeBa_selected",
			"sessionRow": "YDXeBa_sessionRow",
			"slot": "YDXeBa_slot",
			"time": "YDXeBa_time",
			"title": "YDXeBa_title",
			"visuallyHidden": "YDXeBa_visuallyHidden"
		};
		//#endregion
		//#region lib/types/client/rows/Rows.js
		/**
		* Workspace browser tree row components (figma Cell set 14:3080): pure presentational —
		* all data and callbacks arrive via props. Hover swaps (folder->chevron,
		* time->ellipsis, action buttons) are CSS-only. Row ... menus are visual-only
		* except workspace Rename/Delete and session Rename/Fork/Archive; the session
		* and workspace hover cards are suppressed while a menu is open.
		*/
		/** Row display title: blank rows show the localized New Session label. */
		function displayTitle(node, t) {
			return node.blank ? t("session.new") : node.title;
		}
		/** Localized compact relative time ("刚刚"/"5分钟" in zh, "now"/"5min" in en). */
		function timeLabel(updatedAt, now, t) {
			const { unit, n } = (0, _deepseek_ai_dsh_client_ui_primitives.relativeTime)(updatedAt, now);
			return unit === "now" ? t("time.now") : t(`time.${unit}`, { n });
		}
		/** Hover-card variant: distances wrap in the ago template; the now bucket stays bare (no "now ago"). */
		function hoverTimeLabel(updatedAt, now, t) {
			const { unit, n } = (0, _deepseek_ai_dsh_client_ui_primitives.relativeTime)(updatedAt, now);
			return unit === "now" ? t("time.now") : t("time.ago", { t: t(`time.${unit}`, { n }) });
		}
		/**
		* Absolute creation time through the dictionary's date template (the message
		* clock pattern): `toLocaleString` would follow the browser language, not the
		* app locale, and produce mixed-language text after a switch.
		*/
		function createdLabel(createdAt, t) {
			const d = new Date(createdAt);
			const pad2 = (v) => String(v).padStart(2, "0");
			return t("hover.created", { time: `${t("date.ymd", {
				y: d.getFullYear(),
				m: d.getMonth() + 1,
				d: d.getDate()
			})} ${pad2(d.getHours())}:${pad2(d.getMinutes())}` });
		}
		/** Hover-card body: workspace title, display directory path, absolute creation time. */
		function WorkspaceHoverContent({ label, cwd, createdAt, t }) {
			return (0, react_jsx_runtime.jsxs)("div", {
				className: Rows_module_css_default.hoverContent,
				children: [
					(0, react_jsx_runtime.jsx)("div", {
						className: Rows_module_css_default.hoverTitle,
						children: label
					}),
					(0, react_jsx_runtime.jsx)("div", {
						className: Rows_module_css_default.hoverPath,
						children: cwd
					}),
					(0, react_jsx_runtime.jsx)("div", {
						className: Rows_module_css_default.hoverTime,
						children: createdLabel(createdAt, t)
					})
				]
			});
		}
		/** Pointer-position half of a row (insert line above or below). */
		function rowHalf(e) {
			const rect = e.currentTarget.getBoundingClientRect();
			return e.clientY < rect.top + rect.height / 2 ? "before" : "after";
		}
		/**
		* Project (workspace) header row: folder + title;
		* hover reveals the chevron and create button, and dwelling on a real
		* Workspace shows its hover card (the ungrouped bucket has none).
		* `containsCurrent` arrives on the node (derivation fact, no renderer scan).
		* @param props.group - derived group node.
		* @param props.onToggle - expand/collapse the group.
		* @param props.onCreate - start a frontend Session inside this Workspace.
		* @param props.drag - optional workspace-row drag wiring.
		* @param props.home - host account home for POSIX hover-path abbreviation.
		* @param props.t - the browser root's locale seat.
		* @returns the row element.
		*/
		function ProjectRowItem({ group, onToggle, onCreate, actions, drag, home, t }) {
			const row = group;
			const label = row.workspaceId === void 0 ? t("group.ungrouped") : row.label;
			const active = group.expanded && group.containsCurrent;
			const [menuOpen, setMenuOpen] = (0, react.useState)(false);
			const workspaceMenuItems = [{
				id: "rename",
				label: t("rename"),
				icon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconEditOutline16, {})
			}, {
				id: "delete",
				label: t("delete.workspace"),
				icon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconTrashOutline16, {}),
				danger: true
			}];
			const ownRow = (0, react_jsx_runtime.jsxs)("div", {
				className: clsx(Rows_module_css_default.projectRow, menuOpen && Rows_module_css_default.menuOpen),
				role: "treeitem",
				"aria-expanded": row.expanded,
				onClick: onToggle,
				draggable: drag !== void 0,
				onDragStart: drag === void 0 ? void 0 : (e) => {
					e.dataTransfer.effectAllowed = "move";
					e.dataTransfer.setData("text/plain", row.key);
					drag.start();
				},
				onDragEnd: drag?.end,
				children: [
					(0, react_jsx_runtime.jsx)("span", {
						className: clsx(Rows_module_css_default.slot, Rows_module_css_default.folder, active && Rows_module_css_default.folderActive),
						children: row.expanded ? (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconFolderOpen16, {}) : (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconFolderClose16, {})
					}),
					(0, react_jsx_runtime.jsx)("span", {
						className: clsx(Rows_module_css_default.slot, Rows_module_css_default.chevron),
						children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconTriangleRightFill14, { className: clsx(Rows_module_css_default.arrow, row.expanded && Rows_module_css_default.arrowOpen) })
					}),
					(0, react_jsx_runtime.jsx)("span", {
						className: Rows_module_css_default.projectText,
						children: (0, react_jsx_runtime.jsx)("span", {
							className: Rows_module_css_default.title,
							children: label
						})
					}),
					(0, react_jsx_runtime.jsxs)("span", {
						className: Rows_module_css_default.rowActions,
						children: [actions !== void 0 && (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Menu, {
							open: menuOpen,
							onClose: () => {
								setMenuOpen(false);
							},
							items: workspaceMenuItems,
							onSelect: (id) => {
								setMenuOpen(false);
								/* v8 ignore next -- Menu can emit only the rename and delete rows supplied above. */
								if (id !== "rename" && id !== "delete") return;
								if (id === "rename") actions.rename();
								else actions.delete();
							},
							portal: true,
							closeOnPointerLeave: true,
							anchor: (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: Rows_module_css_default.iconButton,
								"aria-label": t("actions.workspace.aria", { name: label }),
								onClick: (e) => {
									e.stopPropagation();
									setMenuOpen((v) => !v);
								},
								children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconEllipsisOutline16, {})
							})
						}), (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: Rows_module_css_default.iconButton,
							"aria-label": t("actions.newSession.aria", { name: label }),
							onClick: (e) => {
								e.stopPropagation();
								onCreate();
							},
							children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconPlusOutline16, {})
						})]
					})
				]
			});
			if (row.createdAt === void 0) return ownRow;
			return (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.HoverCard, {
				anchor: ownRow,
				content: (0, react_jsx_runtime.jsx)(WorkspaceHoverContent, {
					label: row.label,
					cwd: row.cwd === void 0 ? void 0 : abbreviateHomePath(row.cwd, home),
					createdAt: row.createdAt,
					t
				}),
				disabled: menuOpen,
				copyText: row.cwd,
				copyLabel: t("copy"),
				copiedLabel: t("hover.copied")
			});
		}
		/* v8 ignore next 3 -- closed-union backstop; only reached if the status is forged */
		function assertNever(value) {
			throw new Error(`unknown pending interaction: ${String(value)}`);
		}
		/**
		* Session status presentation; pending interaction is primary and live activity
		* outranks completion reminders.
		*/
		function sessionStatuses(node, t) {
			const subagents = node.runningSubagentCount === 0 ? void 0 : {
				state: "ongoing",
				label: t(node.runningSubagentCount === 1 ? "status.subagentsRunning.one" : "status.subagentsRunning.other", { n: node.runningSubagentCount })
			};
			let pending;
			switch (node.pendingInteraction) {
				case "approval":
					pending = {
						state: "warning",
						label: t("status.waitingApproval")
					};
					break;
				case "plan-review":
					pending = {
						state: "warning",
						label: t("status.planReview")
					};
					break;
				case "question":
					pending = {
						state: "warning",
						label: t("status.waitingAnswer")
					};
					break;
				case void 0: break;
				/* v8 ignore next -- closed PendingInteractionStatus union */
				default: return assertNever(node.pendingInteraction);
			}
			if (pending !== void 0) return subagents === void 0 ? [pending] : [pending, subagents];
			if (node.running) {
				const primary = {
					state: "ongoing",
					label: t("status.running")
				};
				return subagents === void 0 ? [primary] : [primary, subagents];
			}
			if (subagents !== void 0) return [subagents];
			if (node.completed) return [{
				state: "done",
				label: t("status.completed")
			}];
			return [{
				state: "done",
				label: t("status.idle")
			}];
		}
		/** Primary status dot plus every status's screen-reader label, shared by the search and session rows. */
		function SessionStatusDots({ statuses }) {
			return (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.StateDot, { state: statuses[0].state }), statuses.map((status) => (0, react_jsx_runtime.jsx)("span", {
				className: Rows_module_css_default.visuallyHidden,
				children: status.label
			}, status.label))] });
		}
		/** Non-interactive active-Schedule marker; the enclosing row remains the only action. */
		function ActiveScheduleIndicator({ t, search = false }) {
			const label = t("schedule.active");
			return (0, react_jsx_runtime.jsx)("span", {
				className: clsx(Rows_module_css_default.scheduleIndicator, search && Rows_module_css_default.searchScheduleIndicator),
				role: "img",
				"aria-label": label,
				title: label,
				children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconAlarmClockOutline16, {})
			});
		}
		function betterGitWorktreeDecoration(node) {
			const value = node.__betterGitWorktree;
			if (value?.kind !== "better-git-worktree") return void 0;
			return value;
		}
		function BetterGitWorktreeIdentity({ decoration }) {
			return (0, react_jsx_runtime.jsxs)("span", {
				className: "bgw-badge",
				"data-bgw-state": decoration.state,
				"data-bgw-rebase": decoration.needsRebase === true ? "true" : "false",
				title: decoration.tooltip,
				"aria-label": `Worktree ${decoration.label}${decoration.needsRebase === true ? ", needs rebasing" : ""}`,
				children: [(0, react_jsx_runtime.jsx)("span", {
					className: "bgw-icon",
					"aria-hidden": "true",
					children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconBranchOutline16, {})
				}), (0, react_jsx_runtime.jsx)("span", { children: decoration.label })]
			});
		}
		/** Hover-card body: full title, relative time, and every relevant live status. */
		function SessionHoverContent({ node, now, t }) {
			const statuses = sessionStatuses(node, t);
			const bgwHover = betterGitWorktreeDecoration(node);
			return (0, react_jsx_runtime.jsxs)("div", {
				className: Rows_module_css_default.hoverContent,
				children: [
					(0, react_jsx_runtime.jsx)("div", {
						className: Rows_module_css_default.hoverTitle,
						children: displayTitle(node, t)
					}),
					bgwHover !== void 0 && (0, react_jsx_runtime.jsxs)("div", {
						className: Rows_module_css_default.hoverStatus,
						children: [(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconBranchOutline16, {}), (0, react_jsx_runtime.jsx)("span", { children: bgwHover.tooltip })]
					}),
					!node.blank && (0, react_jsx_runtime.jsx)("div", {
						className: Rows_module_css_default.hoverTime,
						children: hoverTimeLabel(node.updatedAt, now, t)
					}),
					statuses.map((status) => (0, react_jsx_runtime.jsxs)("div", {
						className: Rows_module_css_default.hoverStatus,
						children: [(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.StateDot, { state: status.state }), (0, react_jsx_runtime.jsx)("span", { children: status.label })]
					}, status.label))
				]
			});
		}
		/**
		* One flat search result: title, Workspace context, and optional content
		* excerpt. Search navigation opens the session only; it does not address an
		* event inside the conversation.
		* @param props.result - merged local/content search row.
		* @param props.currentId - selected session id.
		* @param props.onOpen - open the selected session.
		* @param props.t - Workspace-browser translation seat.
		* @returns the result button.
		*/
		function SearchResultItem({ result, currentId, onOpen, t }) {
			const selected = result.id === currentId;
			const statuses = sessionStatuses(result, t);
			const primaryStatus = statuses[0];
			const bgwSearchDecoration = betterGitWorktreeDecoration(result);
			return (0, react_jsx_runtime.jsxs)("button", {
				type: "button",
				className: clsx(Rows_module_css_default.searchResultRow, selected && Rows_module_css_default.selected),
				role: "treeitem",
				"aria-selected": selected,
				onClick: () => {
					onOpen(result.id);
				},
				children: [(0, react_jsx_runtime.jsxs)("span", {
					className: Rows_module_css_default.searchResultHeading,
					children: [
						(0, react_jsx_runtime.jsx)("span", {
							className: Rows_module_css_default.slot,
							children: (primaryStatus.state !== "done" || result.completed) && (0, react_jsx_runtime.jsx)(SessionStatusDots, { statuses })
						}),
						bgwSearchDecoration !== void 0 && (0, react_jsx_runtime.jsx)(BetterGitWorktreeIdentity, { decoration: bgwSearchDecoration }),
						(0, react_jsx_runtime.jsx)("span", {
							className: Rows_module_css_default.searchResultTitle,
							children: result.title
						}),
						result.hasActiveSchedule && (0, react_jsx_runtime.jsx)(ActiveScheduleIndicator, {
							t,
							search: true
						})
					]
				}), (0, react_jsx_runtime.jsxs)("span", {
					className: Rows_module_css_default.searchResultMeta,
					children: [(0, react_jsx_runtime.jsx)("span", {
						className: Rows_module_css_default.searchResultWorkspace,
						children: result.workspace || t("group.ungrouped")
					}), result.snippet !== void 0 && (0, react_jsx_runtime.jsx)("span", {
						className: Rows_module_css_default.searchResultSnippet,
						children: result.snippet
					})]
				})]
			});
		}
		/**
		* One top-level 34px session row: status dot (pending user interaction outranks
		* own or descendant activity), title, relative time, and the row actions menu.
		* @param props.node - derived session node.
		* @param props.currentId - selected session id (row highlight).
		* @param props.now - epoch ms for relative-time formatting.
		* @param props.onOpen - open a session by id.
		* @param props.onRename - open the session rename dialog (id + current title).
		* @param props.onFork - fork a session at its last completed turn.
		* @param props.onArchive - archive a session by id.
		* @param props.onReveal - scroll this row into view after search navigation, then acknowledge it.
		* @param props.drag - optional draggable-row wiring.
		* @param props.flat - omit the empty status slot in the hierarchy-free flat list.
		* @param props.t - the browser root's locale seat.
		* @returns the session row.
		*/
		function SessionNodeItem({ node, currentId, now, onOpen, onRename, onFork, onArchive, onReveal, drag, flat = false, t }) {
			const row = node;
			const title = displayTitle(node, t);
			const selected = node.id === currentId;
			const statuses = sessionStatuses(node, t);
			const showStatus = statuses[0].state !== "done" || row.completed;
			const bgwDecoration = betterGitWorktreeDecoration(row);
			const [menuOpen, setMenuOpen] = (0, react.useState)(false);
			const rowRef = (0, react.useRef)(null);
			(0, react.useEffect)(() => {
				if (onReveal === void 0) return;
				rowRef.current?.scrollIntoView({ block: "nearest" });
				onReveal();
			}, [onReveal]);
			const sessionMenuItems = [
				{
					id: "rename",
					label: t("rename"),
					icon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconEditOutline16, {})
				},
				{
					id: "fork",
					label: t("menu.fork"),
					icon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconBranchOutline16, {})
				},
				{
					id: "archive",
					label: t("menu.archiveSession"),
					icon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconArchiveOutline20, { size: 16 })
				}
			];
			return (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.HoverCard, {
				anchor: (0, react_jsx_runtime.jsxs)("div", {
					ref: rowRef,
					className: clsx(Rows_module_css_default.sessionRow, selected && Rows_module_css_default.selected, menuOpen && Rows_module_css_default.menuOpen, flat && !showStatus && Rows_module_css_default.flatSessionRowWithoutStatus, drag?.marker === "before" && Rows_module_css_default.dropBefore, drag?.marker === "after" && Rows_module_css_default.dropAfter),
					role: "treeitem",
					"aria-selected": selected,
					onClick: () => {
						onOpen(node.id);
					},
					draggable: drag !== void 0,
					onDragStart: drag === void 0 ? void 0 : (e) => {
						e.dataTransfer.effectAllowed = "move";
						e.dataTransfer.setData("text/plain", node.id);
						drag.start();
					},
					onDragEnd: drag?.end,
					onDragOver: drag === void 0 ? void 0 : (e) => {
						if (!drag.active) return;
						e.preventDefault();
						e.dataTransfer.dropEffect = "move";
						drag.hover(rowHalf(e));
					},
					onDrop: drag === void 0 ? void 0 : (e) => {
						if (!drag.active) return;
						e.preventDefault();
						drag.drop(rowHalf(e));
					},
					children: [
						(!flat || showStatus) && (0, react_jsx_runtime.jsx)("span", {
							className: Rows_module_css_default.slot,
							children: showStatus && (0, react_jsx_runtime.jsx)(SessionStatusDots, { statuses })
						}),
						bgwDecoration !== void 0 && (0, react_jsx_runtime.jsx)(BetterGitWorktreeIdentity, { decoration: bgwDecoration }),
						(0, react_jsx_runtime.jsx)("span", {
							className: Rows_module_css_default.title,
							children: title
						}),
						row.hasActiveSchedule && (0, react_jsx_runtime.jsx)(ActiveScheduleIndicator, { t }),
						!row.blank && (0, react_jsx_runtime.jsx)("span", {
							className: Rows_module_css_default.time,
							children: timeLabel(row.updatedAt, now, t)
						}),
						!row.blank && (0, react_jsx_runtime.jsx)("span", {
							className: Rows_module_css_default.rowActions,
							children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Menu, {
								open: menuOpen,
								onClose: () => {
									setMenuOpen(false);
								},
								items: sessionMenuItems,
								onSelect: (id) => {
									setMenuOpen(false);
									if (id === "rename") onRename(node.id, row.title);
									if (id === "fork") onFork(node.id);
									if (id === "archive") onArchive(node.id);
								},
								portal: true,
								closeOnPointerLeave: true,
								anchor: (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: Rows_module_css_default.iconButton,
									"aria-label": t("actions.session.aria", { name: title }),
									onClick: (e) => {
										e.stopPropagation();
										setMenuOpen((v) => !v);
									},
									children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconEllipsisOutline16, {})
								})
							})
						})
					]
				}),
				content: (0, react_jsx_runtime.jsx)(SessionHoverContent, {
					node,
					now,
					t
				}),
				disabled: menuOpen || drag?.active === true,
				copyText: row.blank ? void 0 : row.title,
				copyLabel: t("copy"),
				copiedLabel: t("hover.copied")
			});
		}
		//#endregion
		//#region \0dsh-css:/home/runner/work/deepseek-harness/deepseek-harness/packages/client/ui-workspace/src/client/WorkspacePicker.module.css.mjs
		const css$1 = "._G5b-a_modalAction{min-width:72px}._G5b-a_modalError,._G5b-a_menuStatus{margin-top:8px;font-size:12px;line-height:18px}._G5b-a_modalError{color:var(--dsw-alias-state-error-primary)}._G5b-a_menuStatus{color:var(--dsw-alias-label-secondary)}";
		const tagId$1 = "@deepseek-ai/dsh-client-ui-workspace/WorkspacePicker.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$1) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@deepseek-ai/dsh-client-ui-workspace";
			tag.dataset.pluginCss = tagId$1;
			tag.textContent = css$1;
			document.head.appendChild(tag);
		}
		var WorkspacePicker_module_css_default = {
			"menuStatus": "_G5b-a_menuStatus",
			"modalAction": "_G5b-a_modalAction",
			"modalError": "_G5b-a_modalError"
		};
		//#endregion
		//#region lib/types/client/WorkspacePicker.js
		const ADD_WORKSPACE = "::add-workspace";
		/**
		* Render the pick menu plus the adoption error dialog.
		* @param props - owner-controlled flow props.
		* @returns menu + dialog elements.
		*/
		function WorkspacePickFlow({ t, open, anchorRef, useWorkspaces, createWorkspace, useDirectoryFlow, renderDirectoryFlow, onPick, onClose, addOnly = false, side = "bottom", selectedId }) {
			const workspaceSnapshot = useWorkspaces((state) => state);
			const workspaces = workspaceSnapshot.items;
			const getAnchorRect = (0, react.useCallback)(() => anchorRef?.current?.getBoundingClientRect() ?? null, [anchorRef]);
			const [errorOpen, setErrorOpen] = (0, react.useState)(false);
			const [modalError, setModalError] = (0, react.useState)(null);
			const [flowOpen, setFlowOpen] = (0, react.useState)(false);
			const [pickingFolder, setPickingFolder] = (0, react.useState)(false);
			const flowBusy = flowOpen || pickingFolder;
			const flowAvailable = useDirectoryFlow((occupied) => occupied);
			(0, react.useEffect)(() => {
				if (flowOpen && !flowAvailable) setFlowOpen(false);
			}, [flowOpen, flowAvailable]);
			const addEntries = flowAvailable ? [{
				id: ADD_WORKSPACE,
				label: t("menu.addWorkspace"),
				icon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconPlusOutline16, { size: 16 }),
				disabled: flowBusy
			}] : [];
			const pinAdd = !addOnly && workspaces.length > 0;
			const items = pinAdd ? workspaces.map((workspace) => ({
				id: workspace.workspaceId,
				label: workspace.title,
				icon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconFolderClose16, { size: 16 }),
				disabled: flowBusy
			})) : addEntries;
			const menuIsEmpty = items.length === 0;
			const closeModal = () => {
				setErrorOpen(false);
				setModalError(null);
			};
			/** Adopt a picked directory; failures land in the folder-error dialog (Choose again reopens the flow). */
			const adoptDirectory = (path) => createWorkspace({ path }).then((workspace) => {
				setFlowOpen(false);
				onPick(workspace.workspaceId);
			}).catch((reason) => {
				setModalError(reason instanceof Error ? reason.message : String(reason));
				setFlowOpen(false);
				setErrorOpen(true);
			});
			const openDirectoryFlow = (0, react.useCallback)(() => {
				onClose();
				setErrorOpen(false);
				setModalError(null);
				setFlowOpen(true);
			}, [onClose]);
			const listSettled = addOnly || workspaceSnapshot.phase === "ready";
			const addIsTheOnlyEntry = !pinAdd && listSettled && addEntries.length === 1;
			(0, react.useEffect)(() => {
				if (open && addIsTheOnlyEntry && !flowBusy) openDirectoryFlow();
			}, [
				open,
				addIsTheOnlyEntry,
				flowBusy,
				openDirectoryFlow
			]);
			/** Owner side of the flow conversation: adopt keeps the flow open (busy) until the Host answers. */
			const flowOwner = {
				open: flowOpen,
				busy: pickingFolder,
				onPicked: (path) => {
					setPickingFolder(true);
					adoptDirectory(path).finally(() => {
						setPickingFolder(false);
					});
				},
				onCancel: () => {
					setFlowOpen(false);
				},
				onError: (message) => {
					setFlowOpen(false);
					setModalError(message);
					setErrorOpen(true);
				}
			};
			const handleSelect = (id) => {
				if (id === ADD_WORKSPACE) {
					openDirectoryFlow();
					return;
				}
				onPick(id);
			};
			return (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
				(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Menu, {
					open: open && !addIsTheOnlyEntry && !menuIsEmpty,
					anchor: null,
					items,
					...pinAdd ? { footer: addEntries } : {},
					selectedId,
					onSelect: handleSelect,
					onClose,
					side,
					portal: true,
					getAnchorRect
				}),
				open && !addIsTheOnlyEntry && !menuIsEmpty && workspaceSnapshot.phase === "pending" && (0, react_jsx_runtime.jsx)("div", {
					className: WorkspacePicker_module_css_default.menuStatus,
					role: "status",
					children: t("picker.loading")
				}),
				renderDirectoryFlow(flowOwner),
				(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Modal, {
					open: errorOpen,
					onClose: closeModal,
					closeLabel: t("close"),
					title: t("folderError.title"),
					footer: (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
						variant: "outline",
						className: WorkspacePicker_module_css_default.modalAction,
						onClick: closeModal,
						children: t("cancel")
					}), (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
						variant: "primary",
						className: WorkspacePicker_module_css_default.modalAction,
						disabled: !flowAvailable,
						onClick: openDirectoryFlow,
						children: t("folderError.retry")
					})] }),
					children: (0, react_jsx_runtime.jsx)("div", {
						className: WorkspacePicker_module_css_default.modalError,
						role: "alert",
						children: modalError
					})
				})
			] });
		}
		/**
		* The conversation empty-state registration: adapts the owner share to the
		* core flow (all state and semantics live in the flow / the owner).
		* @param props - empty-state slot props (owner share + injected creation callback).
		* @returns the flow element.
		*/
		function WorkspacePicker({ open, anchorRef, useWorkspaces, selectedId, onPick, onClose, createWorkspace, useDirectoryFlow, renderSlot, t }) {
			return (0, react_jsx_runtime.jsx)(WorkspacePickFlow, {
				t,
				open,
				anchorRef,
				useWorkspaces,
				createWorkspace,
				useDirectoryFlow,
				renderDirectoryFlow: (owner) => renderSlot("conversation.hero.workspace.directoryFlow", owner),
				selectedId,
				onPick,
				onClose
			});
		}
		//#endregion
		//#region \0dsh-css:/home/runner/work/deepseek-harness/deepseek-harness/packages/client/ui-workspace/src/client/rows/WorkspaceBrowser.module.css.mjs
		const css = ".bhn1Oq_root{--dsh-session-list-edge-inset:var(--dsh-sidebar-inline-padding);--dsh-session-list-scrollbar-width:8px;--dsh-session-list-scrollbar-offset:2px;box-sizing:border-box;min-height:0;padding-right:var(--dsh-session-list-edge-inset);flex-direction:column;flex:1;display:flex}.bhn1Oq_root.bhn1Oq_rail{padding-right:0}.bhn1Oq_iconButton{corner-shape:round;cursor:pointer;width:28px;height:28px;color:var(--dsw-alias-label-secondary);background:0 0;border:none;border-radius:50%;flex:none;justify-content:center;align-items:center;padding:0;display:inline-flex}.bhn1Oq_iconButton:hover{background:var(--dsw-alias-interactive-bg-hover)}.bhn1Oq_sectionHeader{box-sizing:border-box;height:36px;color:var(--dsw-alias-label-tertiary);border-radius:12px;flex:none;justify-content:flex-end;align-items:center;gap:4px;margin-bottom:4px;padding-left:4px;display:flex;overflow:hidden}.bhn1Oq_root:not(.bhn1Oq_rail) .bhn1Oq_sectionHeader{margin-top:2px;margin-right:-4px}.bhn1Oq_sectionLabel{white-space:nowrap;opacity:1;visibility:visible;min-width:0;max-width:45%;transition:max-width .18s var(--ds-ease-in-out), margin-right .18s var(--ds-ease-in-out), opacity .12s var(--ds-ease-in-out), transform .18s var(--ds-ease-in-out), visibility 0s linear;flex:none;line-height:20px;overflow:hidden}.bhn1Oq_sectionLabelHidden{opacity:0;visibility:hidden;max-width:0;margin-right:-4px;transition-delay:0s,0s,0s,0s,.18s;transform:translate(-4px)}.bhn1Oq_searchSlot{box-sizing:border-box;min-width:0;max-width:28px;transition:max-width .18s var(--ds-ease-in-out), padding-left .18s var(--ds-ease-in-out);flex:1;align-items:center;margin-left:auto;padding-left:0;display:flex}.bhn1Oq_searchSlotExpanded{max-width:100%;padding-left:0}.bhn1Oq_headerActions{opacity:1;visibility:visible;max-width:60px;transition:max-width .18s var(--ds-ease-in-out), opacity .12s var(--ds-ease-in-out), transform .18s var(--ds-ease-in-out), visibility 0s linear;flex:none;align-items:center;gap:4px;display:flex;overflow:hidden}.bhn1Oq_headerActionsHidden{opacity:0;visibility:hidden;pointer-events:none;max-width:0;transition-delay:0s,0s,0s,.18s;transform:translate(4px)}.bhn1Oq_search{box-sizing:border-box;corner-shape:round;cursor:text;width:100%;height:28px;color:var(--dsw-alias-label-secondary);transition:width .18s var(--ds-ease-in-out), padding .18s var(--ds-ease-in-out), border-color .18s var(--ds-ease-in-out), background-color .18s var(--ds-ease-in-out);background:0 0;border:none;border-radius:50%;flex:none;align-items:center;gap:0;margin:0;padding:0;display:flex;overflow:hidden}.bhn1Oq_searchExpanded{border:.5px solid var(--dsw-alias-border-l4);width:calc(100% + 4px);height:30px;color:var(--dsw-alias-label-caption);background:0 0;border-radius:10px;margin-inline:-2px;padding:0 4px 0 0}.bhn1Oq_searchButton{corner-shape:round;cursor:pointer;width:28px;height:28px;color:inherit;background:0 0;border:none;border-radius:50%;flex:none;justify-content:center;align-items:center;padding:0;display:inline-flex}.bhn1Oq_searchExpanded .bhn1Oq_searchButton{width:28px;height:30px}.bhn1Oq_searchButton:hover{background:var(--dsw-alias-interactive-bg-hover)}.bhn1Oq_searchExpanded .bhn1Oq_searchButton:hover{background:0 0}.bhn1Oq_searchInput{opacity:0;pointer-events:none;width:0;min-width:0;color:var(--dsw-alias-label-primary);transition:opacity .12s var(--ds-ease-in-out);background:0 0;border:none;outline:none;flex:1;font-size:13px;line-height:18px}.bhn1Oq_searchExpanded .bhn1Oq_searchInput{opacity:1;pointer-events:auto;margin-left:-2px}.bhn1Oq_searchInput::placeholder{color:var(--dsw-alias-label-tertiary)}.bhn1Oq_clearButton{corner-shape:round;cursor:pointer;width:24px;height:24px;color:var(--dsw-alias-label-secondary);background:0 0;border:none;border-radius:50%;flex:none;justify-content:center;align-items:center;padding:0;display:inline-flex}.bhn1Oq_clearButton:hover{background:var(--dsw-alias-interactive-bg-hover)}.bhn1Oq_rail .bhn1Oq_sectionHeader{justify-content:flex-start;gap:0;margin-bottom:12px;padding-left:0}.bhn1Oq_rail .bhn1Oq_headerActions{max-width:none}.bhn1Oq_rail .bhn1Oq_iconButton{width:36px;height:36px;color:var(--dsw-alias-label-primary)}.bhn1Oq_rail .bhn1Oq_search{background:0 0;border-color:#0000;gap:0;width:36px;height:36px;margin:0 0 12px;padding:0}.bhn1Oq_rail .bhn1Oq_searchButton{width:36px;height:36px;color:var(--dsw-alias-label-primary)}.bhn1Oq_rail .bhn1Oq_searchButton:hover{background:var(--dsw-alias-interactive-bg-hover)}.bhn1Oq_listArea{min-height:0;margin-left:-4px;margin-right:calc(-1 * var(--dsh-session-list-edge-inset));flex-direction:column;flex:1;padding-left:4px;display:flex;overflow:visible}.bhn1Oq_rail .bhn1Oq_listArea{margin-left:0;margin-right:0;padding-left:0}.bhn1Oq_treeBody{flex-direction:column;flex:1;min-height:0;display:flex;position:relative}.bhn1Oq_fade{left:0;right:var(--dsh-session-list-edge-inset);background:linear-gradient(to bottom, transparent, var(--dsw-specific-sidebar-fill));pointer-events:none;height:24px;position:absolute;bottom:0}.bhn1Oq_wide{animation:bhn1Oq_wide-in .2s var(--ds-ease-in-out)}@keyframes bhn1Oq_wide-in{0%{opacity:0}}.bhn1Oq_list{min-height:0;margin-left:-4px;margin-right:var(--dsh-session-list-scrollbar-offset);padding-left:4px;padding-right:calc(var(--dsh-session-list-edge-inset) - var(--dsh-session-list-scrollbar-width) - var(--dsh-session-list-scrollbar-offset));scrollbar-gutter:stable;flex:1;padding-bottom:16px;overflow-y:auto}.bhn1Oq_flatList>*+*,.bhn1Oq_searchTree>[role=treeitem]+[role=treeitem],.bhn1Oq_groupSection>*+*{margin-top:2px}.bhn1Oq_searchStatus,.bhn1Oq_searchWarning{color:var(--dsw-alias-label-tertiary);padding:10px 12px;font-size:12px;line-height:18px}.bhn1Oq_searchWarning{color:var(--dsw-alias-label-secondary)}.bhn1Oq_groupSection{position:relative}.bhn1Oq_groupSection+.bhn1Oq_groupSection{margin-top:4px}.bhn1Oq_listTopDropIndicator,.bhn1Oq_workspaceDropBefore:before,.bhn1Oq_workspaceDropAfter:after{content:\"\";z-index:1;background:linear-gradient(55deg, transparent calc(50% - 1px), var(--dsw-alias-state-business-primary) calc(50% - 1px) calc(50% + 1px), transparent calc(50% + 1px)) 0 0 / 5px 7px no-repeat, linear-gradient(125deg, transparent calc(50% - 1px), var(--dsw-alias-state-business-primary) calc(50% - 1px) calc(50% + 1px), transparent calc(50% + 1px)) 0 5px / 5px 7px no-repeat, linear-gradient(var(--dsw-alias-state-business-primary) 0 0) 4px 5px / calc(100% - 4px) 2px no-repeat;pointer-events:none;height:12px;position:absolute;left:0;right:0}.bhn1Oq_listTopDropIndicator{top:-8px;left:0;right:var(--dsh-session-list-edge-inset)}.bhn1Oq_listTopDropActive>.bhn1Oq_workspaceDropBefore:first-child:before{display:none}.bhn1Oq_workspaceDropBefore:before{top:-8px}.bhn1Oq_workspaceDropAfter:after{bottom:-8px}.bhn1Oq_sessionOverflowButton{cursor:pointer;text-align:left;width:100%;height:28px;color:var(--dsw-alias-label-tertiary);background:0 0;border:none;border-radius:8px;padding:0 12px 0 28px;font-size:12px}.bhn1Oq_groupSection>.bhn1Oq_sessionOverflowButton{margin-top:0}.bhn1Oq_sessionOverflowButton:hover{color:var(--dsw-alias-label-secondary);background:0 0}.bhn1Oq_empty{color:var(--dsw-alias-label-tertiary);padding:16px 12px;font-size:13px}.bhn1Oq_renameInput{box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l4);width:100%;height:44px;color:var(--dsw-alias-label-primary);background:0 0;border-radius:22px;outline:none;padding:7px 14px;font-size:14px;font-weight:400;line-height:22px}.bhn1Oq_renameInput:disabled{color:var(--dsw-alias-label-dimmed)}.bhn1Oq_renameError{color:var(--dsw-alias-state-error-primary);margin-top:8px;font-size:12px;line-height:18px}.bhn1Oq_deleteAction:not(:disabled){color:var(--dsw-alias-state-error-primary)}.bhn1Oq_deleteStatus{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}@media (prefers-reduced-motion:reduce){.bhn1Oq_wide{animation:none}.bhn1Oq_search,.bhn1Oq_sectionLabel,.bhn1Oq_searchSlot,.bhn1Oq_searchInput,.bhn1Oq_headerActions{transition:none}}";
		const tagId = "@deepseek-ai/dsh-client-ui-workspace/WorkspaceBrowser.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@deepseek-ai/dsh-client-ui-workspace";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		var WorkspaceBrowser_module_css_default = {
			"clearButton": "bhn1Oq_clearButton",
			"deleteAction": "bhn1Oq_deleteAction",
			"deleteStatus": "bhn1Oq_deleteStatus",
			"empty": "bhn1Oq_empty",
			"fade": "bhn1Oq_fade",
			"flatList": "bhn1Oq_flatList",
			"groupSection": "bhn1Oq_groupSection",
			"headerActions": "bhn1Oq_headerActions",
			"headerActionsHidden": "bhn1Oq_headerActionsHidden",
			"iconButton": "bhn1Oq_iconButton",
			"list": "bhn1Oq_list",
			"listArea": "bhn1Oq_listArea",
			"listTopDropActive": "bhn1Oq_listTopDropActive",
			"listTopDropIndicator": "bhn1Oq_listTopDropIndicator",
			"rail": "bhn1Oq_rail",
			"renameError": "bhn1Oq_renameError",
			"renameInput": "bhn1Oq_renameInput",
			"root": "bhn1Oq_root",
			"search": "bhn1Oq_search",
			"searchButton": "bhn1Oq_searchButton",
			"searchExpanded": "bhn1Oq_searchExpanded",
			"searchInput": "bhn1Oq_searchInput",
			"searchSlot": "bhn1Oq_searchSlot",
			"searchSlotExpanded": "bhn1Oq_searchSlotExpanded",
			"searchStatus": "bhn1Oq_searchStatus",
			"searchTree": "bhn1Oq_searchTree",
			"searchWarning": "bhn1Oq_searchWarning",
			"sectionHeader": "bhn1Oq_sectionHeader",
			"sectionLabel": "bhn1Oq_sectionLabel",
			"sectionLabelHidden": "bhn1Oq_sectionLabelHidden",
			"sessionOverflowButton": "bhn1Oq_sessionOverflowButton",
			"treeBody": "bhn1Oq_treeBody",
			"wide": "bhn1Oq_wide",
			"wide-in": "bhn1Oq_wide-in",
			"workspaceDropAfter": "bhn1Oq_workspaceDropAfter",
			"workspaceDropBefore": "bhn1Oq_workspaceDropBefore"
		};
		//#endregion
		//#region lib/types/client/rows/WorkspaceBrowser.js
		/**
		* The workspace/session browsing region filling the sidebar shell's
		* `sidebar.workspaces` hole: section header (title + view options + add
		* workspace), search, the grouped tree or flat list, and the workspace
		* dialogs. Wide state renders the full browser; rail state renders the two
		* region icons (search / add workspace) as 36px controls on the shell's shared
		* rail entry path, each requesting expansion through the owner share. Adding
		* is the header button's one action, so it raises the directory flow with no
		* menu in between; the flow and its error dialog live in WorkspacePicker
		* (same package — direct composition, no slot between them).
		*/
		/**
		* Column slide length (--ds-transition-duration-slow): rail-search focus waits it out —
		* focus() forces a synchronous layout and would jank the slide.
		*/
		const EXPAND_SLIDE_MS = 300;
		/** Pause between the latest keystroke and a Host content-search request. */
		const SEARCH_DEBOUNCE_MS = 250;
		/** `session.search` wire bound, measured in JavaScript UTF-16 code units. */
		const SEARCH_QUERY_MAX_CODE_UNITS = 500;
		/** Session rows visible per Workspace before the local overflow control. */
		const COLLAPSED_SESSION_LIMIT = 5;
		/** Fold one Workspace without charging its provisional New Session against the ordinary-row limit. */
		function collapsedSessionRows(sessions) {
			let ordinaryCount = 0;
			const rows = sessions.filter((session) => {
				if (session.blank) return true;
				if (ordinaryCount >= COLLAPSED_SESSION_LIMIT) return false;
				ordinaryCount += 1;
				return true;
			});
			return {
				rows,
				hiddenCount: sessions.length - rows.length
			};
		}
		/** Keep controlled input and RPC payload inside the session.search wire contract. */
		function sanitizeSearchQuery(value) {
			const withoutNul = value.replaceAll("\0", "");
			if (withoutNul.length <= SEARCH_QUERY_MAX_CODE_UNITS) return withoutNul;
			let end = SEARCH_QUERY_MAX_CODE_UNITS;
			const last = withoutNul.charCodeAt(end - 1);
			const next = withoutNul.charCodeAt(end);
			if (last >= 55296 && last <= 56319 && next >= 56320 && next <= 57343) end--;
			return withoutNul.slice(0, end);
		}
		/** Immutable membership toggle for the local expand-all array. */
		function toggled(list, key) {
			return list.includes(key) ? list.filter((k) => k !== key) : [...list, key];
		}
		/**
		* Accept the native drag at document level while a row drag is active: row
		* hover still owns the insertion marker, and releasing outside the list must
		* not be rendered as a rejected drop before dragend commits that last marker.
		*/
		function useNativeDragAcceptance(active) {
			(0, react.useEffect)(() => {
				if (!active) return;
				const acceptDrag = (event) => {
					event.preventDefault();
					if (event.dataTransfer !== null) event.dataTransfer.dropEffect = "move";
				};
				const acceptDrop = (event) => {
					event.preventDefault();
				};
				document.addEventListener("dragover", acceptDrag);
				document.addEventListener("drop", acceptDrop);
				return () => {
					document.removeEventListener("dragover", acceptDrag);
					document.removeEventListener("drop", acceptDrop);
				};
			}, [active]);
		}
		/** Reconcile a stored view order with the Workspace's current session account. */
		function reconciledSessionOrder(sessionIds, stored) {
			if (stored === void 0) return [...sessionIds];
			const byId = new Map(sessionIds.map((id) => [id, id]));
			const ordered = [];
			const included = /* @__PURE__ */ new Set();
			for (const key of stored) {
				const id = byId.get(key);
				if (id === void 0 || included.has(key)) continue;
				ordered.push(id);
				included.add(key);
			}
			for (const id of sessionIds) {
				if (included.has(id)) continue;
				ordered.push(id);
			}
			return ordered;
		}
		/** Newest update first with stable Session identity as the tie-break. */
		function compareSessionRecency(a, b, byId) {
			const aUpdatedAt = byId[a]?.updatedAt ?? Number.NEGATIVE_INFINITY;
			const bUpdatedAt = byId[b]?.updatedAt ?? Number.NEGATIVE_INFINITY;
			if (aUpdatedAt !== bUpdatedAt) return bUpdatedAt - aUpdatedAt;
			return a < b ? -1 : 1;
		}
		/** Reconcile one editable order account and apply its activity-promotion policy. */
		function nextSessionOrderAccount({ sessionIds, previousOrder, previousUpdatedAt, list, orderBy, sortByRecency }) {
			let order = reconciledSessionOrder(sessionIds, previousOrder);
			if (sortByRecency) order.sort((a, b) => compareSessionRecency(a, b, list.byId));
			else if (orderBy === "updated") {
				const promoted = sessionIds.filter((id) => {
					const session = list.byId[id];
					return session !== void 0 && (previousUpdatedAt[id] === void 0 || session.updatedAt > previousUpdatedAt[id]);
				}).sort((a, b) => compareSessionRecency(a, b, list.byId));
				if (promoted.length > 0) {
					const promotedIds = new Set(promoted);
					order = [...promoted, ...order.filter((id) => !promotedIds.has(id))];
				}
			}
			const updatedAt = {};
			for (const id of sessionIds) {
				const session = list.byId[id];
				if (session !== void 0) updatedAt[id] = session.updatedAt;
			}
			const orderChanged = previousOrder === void 0 || order.length !== previousOrder.length || order.some((id, index) => id !== previousOrder[index]);
			const timestampsChanged = Object.keys(updatedAt).length !== Object.keys(previousUpdatedAt).length || Object.entries(updatedAt).some(([id, timestamp]) => previousUpdatedAt[id] !== timestamp);
			return {
				order,
				updatedAt,
				changed: orderChanged || timestampsChanged
			};
		}
		/** Grouping and ordering menu; own open state so it resets with the wide chrome. */
		function ViewOptionsMenu({ groupBy, orderBy, onGroupPick, onOrderPick, t }) {
			const [open, setOpen] = (0, react.useState)(false);
			return (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Menu, {
				open,
				onClose: () => {
					setOpen(false);
				},
				items: [
					{
						type: "label",
						id: "group-by",
						text: t("groupBy.label")
					},
					{
						id: "workspace",
						label: t("groupBy.workspace")
					},
					{
						id: "flat",
						label: t("groupBy.flat")
					},
					{
						type: "separator",
						id: "order-by-separator"
					},
					{
						type: "label",
						id: "order-by",
						text: t("orderBy.label")
					},
					{
						id: "manual",
						label: t("orderBy.manual")
					},
					{
						id: "updated",
						label: t("orderBy.updated")
					}
				],
				selectedIds: [groupBy, orderBy],
				onSelect: (id) => {
					if (id === "workspace" || id === "flat") onGroupPick(id);
					else if (id === "manual" || id === "updated") onOrderPick(id);
					setOpen(false);
				},
				align: "end",
				dense: true,
				portal: true,
				anchor: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
					label: t("viewOptions.label"),
					side: "bottom",
					delayMs: 500,
					children: (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: clsx(WorkspaceBrowser_module_css_default.iconButton, WorkspaceBrowser_module_css_default.wide),
						"aria-label": t("viewOptions.label"),
						onClick: () => {
							setOpen((v) => !v);
						},
						children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconPersonalizationOutline16, {})
					})
				})
			});
		}
		/** Resolve an insertion side from the full rendered workspace group. */
		function workspaceGroupHalf(e) {
			const rect = e.currentTarget.getBoundingClientRect();
			return e.clientY < rect.top + rect.height / 2 ? "before" : "after";
		}
		/** The scrolling session tree; unmounting drops the sessions subscription and expand-all state. */
		function SessionTree({ useSessions, useSessionPendingInteraction, startSession, open, forkSession, workspaces, archivedSessionIds, workspaceReady, usePanelInfo, onRenameRequest, onDeleteRequest, onSessionRename, onSessionArchive, insertWorkspaceBefore, insertSessionBefore, orderBy, groupExpansion, setGroupExpanded, sessionOrderByAccount, sessionUpdatedAtByAccount, syncSessionOrderAccount, setSessionOrder, home, t, revealSessionId, onSessionRevealed }) {
			const panelActive = usePanelInfo((info) => info.activePanelId !== null);
			const list = useSessions((s) => s);
			const pendingInteractions = useSessionPendingInteraction((s) => s);
			const current = panelActive ? void 0 : list.current;
			const revealGroup = revealSessionId === void 0 || !workspaceReady ? void 0 : owningGroupKey(workspaces, revealSessionId);
			const [expandedSessionGroups, setExpandedSessionGroups] = (0, react.useState)([]);
			const [drag, setDrag] = (0, react.useState)(null);
			const sessionDropCommitted = (0, react.useRef)(false);
			const [workspaceDrag, setWorkspaceDrag] = (0, react.useState)(null);
			const workspaceDropCommitted = (0, react.useRef)(false);
			const previousOrderBy = (0, react.useRef)(orderBy);
			useNativeDragAcceptance(drag !== null || workspaceDrag !== null);
			const currentGroup = current === void 0 || !workspaceReady ? void 0 : owningGroupKey(workspaces, current);
			(0, react.useEffect)(() => {
				if (current === void 0 || currentGroup === void 0 || Object.hasOwn(groupExpansion, currentGroup)) return;
				setGroupExpanded(currentGroup, true);
			}, [
				current,
				currentGroup,
				setGroupExpanded,
				groupExpansion
			]);
			const expandedGroups = (0, react.useMemo)(() => Object.entries(groupExpansion).filter(([, expanded]) => expanded).map(([key]) => key), [groupExpansion]);
			const ungroupedSessionIds = (0, react.useMemo)(() => {
				const accounted = new Set(workspaces.flatMap((workspace) => workspace.sessionIds));
				return list.ids.filter((id) => list.byId[id] !== void 0 && !accounted.has(id));
			}, [list, workspaces]);
			(0, react.useEffect)(() => {
				if (list.phase !== "ready") return;
				const switchedToUpdated = previousOrderBy.current !== "updated" && orderBy === "updated";
				previousOrderBy.current = orderBy;
				const accounts = [...workspaces.map((workspace) => ({
					key: workspace.workspaceId,
					sessionIds: workspace.sessionIds.filter((id) => list.byId[id] !== void 0)
				})), {
					key: "",
					sessionIds: ungroupedSessionIds
				}];
				for (const { key, sessionIds } of accounts) {
					const previousOrder = sessionOrderByAccount[key];
					const next = nextSessionOrderAccount({
						sessionIds,
						previousOrder,
						previousUpdatedAt: sessionUpdatedAtByAccount[key] ?? {},
						list,
						orderBy,
						sortByRecency: orderBy === "updated" && (previousOrder === void 0 || switchedToUpdated)
					});
					if (next.changed) syncSessionOrderAccount(key, next.order.map((id) => id), next.updatedAt);
				}
			}, [
				list,
				orderBy,
				sessionOrderByAccount,
				sessionUpdatedAtByAccount,
				syncSessionOrderAccount,
				ungroupedSessionIds,
				workspaces
			]);
			const orderedWorkspaces = (0, react.useMemo)(() => {
				return workspaces.map((workspace) => {
					const stored = sessionOrderByAccount[workspace.workspaceId];
					const sessionIds = reconciledSessionOrder(workspace.sessionIds, stored);
					return {
						...workspace,
						sessionIds
					};
				});
			}, [sessionOrderByAccount, workspaces]);
			const orderedUngroupedSessionIds = (0, react.useMemo)(() => reconciledSessionOrder(ungroupedSessionIds, sessionOrderByAccount[""]), [sessionOrderByAccount, ungroupedSessionIds]);
			const groups = (0, react.useMemo)(() => deriveGroups(list, orderedWorkspaces, archivedSessionIds, pendingInteractions, {
				expandedGroups,
				...sessionOrderByAccount[""] === void 0 ? {} : { ungroupedOrder: sessionOrderByAccount[""] }
			}), [
				list,
				orderedWorkspaces,
				archivedSessionIds,
				pendingInteractions,
				expandedGroups,
				sessionOrderByAccount
			]);
			(0, react.useEffect)(() => {
				if (revealGroup === void 0 || groupExpansion[revealGroup] === true) return;
				setGroupExpanded(revealGroup, true);
			}, [
				groupExpansion,
				revealGroup,
				setGroupExpanded
			]);
			(0, react.useEffect)(() => {
				if (revealSessionId === void 0 || revealGroup === void 0) return;
				const group = groups.find((candidate) => candidate.key === revealGroup);
				if (group === void 0 || !group.expanded || !group.sessions.some((row) => row.id === revealSessionId)) return;
				if (collapsedSessionRows(group.sessions).rows.some((row) => row.id === revealSessionId)) return;
				setExpandedSessionGroups((keys) => keys.includes(revealGroup) ? keys : [...keys, revealGroup]);
			}, [
				groups,
				revealGroup,
				revealSessionId
			]);
			const now = Date.now();
			const commitSessionDrag = (activeDrag, over) => {
				if (sessionDropCommitted.current) return;
				sessionDropCommitted.current = true;
				setDrag(null);
				const group = groups.find((candidate) => candidate.key === activeDrag.accountKey);
				if (group === void 0) return;
				const sessionsExpanded = expandedSessionGroups.includes(group.key);
				const renderedSessions = sessionsExpanded ? group.sessions : collapsedSessionRows(group.sessions).rows;
				const targetIndex = renderedSessions.findIndex((session) => session.id === over.id);
				if (targetIndex === -1) return;
				const sourceIndex = renderedSessions.findIndex((session) => session.id === activeDrag.sessionId);
				if (over.id === activeDrag.sessionId) return;
				const withoutSource = renderedSessions.filter((session) => session.id !== activeDrag.sessionId);
				const targetWithoutSourceIndex = withoutSource.findIndex((session) => session.id === over.id);
				if (targetWithoutSourceIndex === -1) return;
				const visibleInsertAt = over.half === "before" ? targetWithoutSourceIndex : targetWithoutSourceIndex + 1;
				if (sourceIndex !== -1 && visibleInsertAt === sourceIndex) return;
				const accountSessionIds = activeDrag.accountKey === "" ? orderedUngroupedSessionIds : orderedWorkspaces.find((workspace) => workspace.workspaceId === activeDrag.accountKey)?.sessionIds;
				if (accountSessionIds === void 0) return;
				const nextOrder = accountSessionIds.filter((id) => id !== activeDrag.sessionId);
				let anchor;
				if (sessionsExpanded) anchor = over.half === "before" ? over.id : renderedSessions[targetIndex + 1]?.id;
				else {
					const previousVisible = withoutSource[visibleInsertAt - 1]?.id;
					if (previousVisible === void 0) anchor = nextOrder[0];
					else {
						const previousIndex = nextOrder.indexOf(previousVisible);
						if (previousIndex === -1) return;
						anchor = nextOrder[previousIndex + 1];
					}
				}
				const insertAt = anchor === void 0 ? nextOrder.length : nextOrder.indexOf(anchor);
				nextOrder.splice(insertAt === -1 ? nextOrder.length : insertAt, 0, activeDrag.sessionId);
				if (!sessionsExpanded && sourceIndex !== -1) {
					const nodes = new Map(group.sessions.map((node) => [node.id, node]));
					if (!collapsedSessionRows(nextOrder.flatMap((id) => {
						const node = nodes.get(id);
						return node === void 0 ? [] : [node];
					})).rows.some((node) => node.id === activeDrag.sessionId)) return;
				}
				setSessionOrder(activeDrag.accountKey, nextOrder.map((id) => id));
				if (orderBy === "updated" || activeDrag.accountKey === "") return;
				insertSessionBefore(activeDrag.accountKey, activeDrag.sessionId, anchor).catch((reason) => {
					console.warn("session reorder rejected:", reason);
				});
			};
			const commitWorkspaceDrag = (activeDrag, over) => {
				if (workspaceDropCommitted.current) return;
				workspaceDropCommitted.current = true;
				setWorkspaceDrag(null);
				const rowIndex = workspaces.findIndex((workspace) => workspace.workspaceId === over.id);
				if (rowIndex === -1) return;
				const anchor = over.half === "before" ? over.id : workspaces[rowIndex + 1]?.workspaceId;
				if (anchor === activeDrag.workspaceId) return;
				const sourceIndex = workspaces.findIndex((workspace) => workspace.workspaceId === activeDrag.workspaceId);
				const anchorIndex = anchor === void 0 ? workspaces.length : workspaces.findIndex((workspace) => workspace.workspaceId === anchor);
				if (sourceIndex !== -1 && (anchorIndex === sourceIndex || anchorIndex === sourceIndex + 1)) return;
				insertWorkspaceBefore(activeDrag.workspaceId, anchor).catch((reason) => {
					console.warn("workspace reorder rejected:", reason);
				});
			};
			const workspaceDropAtListStart = groups[0]?.workspaceId !== void 0 && workspaceDrag?.over?.id === groups[0].workspaceId && workspaceDrag.over.half === "before";
			return (0, react_jsx_runtime.jsxs)("div", {
				className: clsx(WorkspaceBrowser_module_css_default.treeBody, WorkspaceBrowser_module_css_default.wide),
				children: [
					workspaceDropAtListStart && (0, react_jsx_runtime.jsx)("span", {
						className: WorkspaceBrowser_module_css_default.listTopDropIndicator,
						"aria-hidden": "true"
					}),
					(0, react_jsx_runtime.jsxs)("div", {
						className: clsx(WorkspaceBrowser_module_css_default.list, workspaceDropAtListStart && WorkspaceBrowser_module_css_default.listTopDropActive),
						role: "tree",
						"aria-label": t("section.sessions"),
						children: [groups.length === 0 && (0, react_jsx_runtime.jsx)("div", {
							className: WorkspaceBrowser_module_css_default.empty,
							children: t("empty.none")
						}), groups.map((group) => {
							const workspaceId = group.workspaceId;
							const collapsed = collapsedSessionRows(group.sessions);
							const sessionsExpanded = expandedSessionGroups.includes(group.key);
							const workspaceMarker = workspaceId !== void 0 && workspaceDrag?.over?.id === workspaceId ? workspaceDrag.over.half : null;
							const workspaceDragProps = workspaceId === void 0 ? void 0 : {
								start: () => {
									workspaceDropCommitted.current = false;
									setWorkspaceDrag({
										workspaceId,
										over: null
									});
								},
								end: () => {
									if (workspaceDrag?.over !== null && workspaceDrag?.over !== void 0) commitWorkspaceDrag(workspaceDrag, workspaceDrag.over);
									else setWorkspaceDrag(null);
									workspaceDropCommitted.current = false;
								}
							};
							const hoverWorkspace = workspaceId === void 0 ? void 0 : (half) => {
								setWorkspaceDrag((active) => active === null ? active : {
									...active,
									over: {
										id: workspaceId,
										half
									}
								});
							};
							const dropWorkspace = workspaceId === void 0 ? void 0 : (half) => {
								if (workspaceDrag === null) return;
								commitWorkspaceDrag(workspaceDrag, {
									id: workspaceId,
									half
								});
							};
							return (0, react_jsx_runtime.jsxs)("div", {
								className: clsx(WorkspaceBrowser_module_css_default.groupSection, workspaceMarker === "before" && WorkspaceBrowser_module_css_default.workspaceDropBefore, workspaceMarker === "after" && WorkspaceBrowser_module_css_default.workspaceDropAfter),
								onDragOver: workspaceDrag === null || hoverWorkspace === void 0 ? void 0 : (e) => {
									e.preventDefault();
									e.dataTransfer.dropEffect = "move";
									hoverWorkspace(workspaceGroupHalf(e));
								},
								onDrop: workspaceDrag === null || dropWorkspace === void 0 ? void 0 : (e) => {
									e.preventDefault();
									dropWorkspace(workspaceGroupHalf(e));
								},
								children: [
									(0, react_jsx_runtime.jsx)(ProjectRowItem, {
										group,
										home,
										t,
										onToggle: () => {
											if (group.expanded) setExpandedSessionGroups((keys) => keys.filter((key) => key !== group.key));
											setGroupExpanded(group.key, !group.expanded);
										},
										onCreate: () => {
											if (group.workspaceId !== void 0) {
												setGroupExpanded(group.key, true);
												startSession(group.workspaceId);
											}
										},
										drag: workspaceDragProps,
										actions: group.workspaceId === void 0 ? void 0 : {
											rename: () => {
												/* v8 ignore next -- narrowing guard: the actions object exists only for real-workspace groups. */
												if (group.workspaceId !== void 0) onRenameRequest(group.workspaceId, group.label);
											},
											delete: () => {
												/* v8 ignore next -- narrowing guard: the actions object exists only for real-workspace groups. */
												if (group.workspaceId !== void 0) onDeleteRequest(group.workspaceId, group.label);
											}
										}
									}),
									(sessionsExpanded ? group.sessions : collapsed.rows).map((node) => {
										const sameGroupDrag = drag !== null && drag.accountKey === group.key;
										const dragProps = {
											start: () => {
												sessionDropCommitted.current = false;
												setDrag({
													accountKey: group.key,
													sessionId: node.id,
													over: null
												});
											},
											active: sameGroupDrag,
											marker: sameGroupDrag && drag.over?.id === node.id ? drag.over.half : null,
											hover: (half) => {
												/* v8 ignore next -- narrowing guard: Rows gates hover on `active`, which is false while the drag state is null. */
												setDrag((d) => d === null ? d : {
													...d,
													over: {
														id: node.id,
														half
													}
												});
											},
											drop: (half) => {
												/* v8 ignore next -- narrowing guard: Rows gates drop on `active`, which is false while the drag state is null. */
												if (drag === null) return;
												commitSessionDrag(drag, {
													id: node.id,
													half
												});
											},
											end: () => {
												if (drag?.over !== null && drag?.over !== void 0) commitSessionDrag(drag, drag.over);
												else setDrag(null);
												sessionDropCommitted.current = false;
											}
										};
										return (0, react_jsx_runtime.jsx)(SessionNodeItem, {
											node,
											currentId: current,
											now,
											onOpen: open,
											onRename: onSessionRename,
											onFork: forkSession,
											onArchive: onSessionArchive,
											onReveal: node.id === revealSessionId && group.key === revealGroup ? () => {
												onSessionRevealed(node.id);
											} : void 0,
											drag: dragProps,
											t
										}, node.id);
									}),
									collapsed.hiddenCount > 0 && (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: WorkspaceBrowser_module_css_default.sessionOverflowButton,
										"aria-expanded": sessionsExpanded,
										onClick: () => {
											setExpandedSessionGroups((keys) => toggled(keys, group.key));
										},
										children: sessionsExpanded ? t("sessions.collapse") : t("sessions.expand", { n: collapsed.hiddenCount })
									})
								]
							}, group.key);
						})]
					}),
					(0, react_jsx_runtime.jsx)("span", { className: WorkspaceBrowser_module_css_default.fade })
				]
			});
		}
		/** The flat "In one list" body: every session is one draggable top-level row. */
		function FlatList({ useSessions, useSessionPendingInteraction, open, forkSession, onSessionRename, onSessionArchive, archivedSessionIds, usePanelInfo, orderBy, sessionOrderByAccount, sessionUpdatedAtByAccount, syncSessionOrderAccount, setSessionOrder, revealSessionId, onSessionRevealed, t }) {
			const panelActive = usePanelInfo((info) => info.activePanelId !== null);
			const list = useSessions((s) => s);
			const pendingInteractions = useSessionPendingInteraction((s) => s);
			const baseRows = (0, react.useMemo)(() => deriveFlat(list, archivedSessionIds, pendingInteractions), [
				list,
				archivedSessionIds,
				pendingInteractions
			]);
			const sessionIds = (0, react.useMemo)(() => baseRows.map((row) => row.id), [baseRows]);
			const previousOrderBy = (0, react.useRef)(orderBy);
			(0, react.useEffect)(() => {
				if (list.phase !== "ready") return;
				const previousOrder = sessionOrderByAccount[FLAT_SESSION_ORDER_KEY];
				const previousUpdatedAt = sessionUpdatedAtByAccount["__flat_session_order__"] ?? {};
				const switchedToUpdated = previousOrderBy.current !== "updated" && orderBy === "updated";
				previousOrderBy.current = orderBy;
				const next = nextSessionOrderAccount({
					sessionIds,
					previousOrder,
					previousUpdatedAt,
					list,
					orderBy,
					sortByRecency: orderBy === "updated" && (previousOrder === void 0 || switchedToUpdated)
				});
				if (next.changed) syncSessionOrderAccount(FLAT_SESSION_ORDER_KEY, next.order.map((id) => id), next.updatedAt);
			}, [
				list,
				orderBy,
				sessionOrderByAccount,
				sessionUpdatedAtByAccount,
				sessionIds,
				syncSessionOrderAccount
			]);
			const rows = (0, react.useMemo)(() => {
				const byId = new Map(baseRows.map((row) => [row.id, row]));
				return reconciledSessionOrder(sessionIds, sessionOrderByAccount[FLAT_SESSION_ORDER_KEY]).flatMap((id) => {
					const row = byId.get(id);
					return row === void 0 ? [] : [row];
				});
			}, [
				baseRows,
				sessionOrderByAccount,
				sessionIds
			]);
			const [drag, setDrag] = (0, react.useState)(null);
			const dropCommitted = (0, react.useRef)(false);
			useNativeDragAcceptance(drag !== null);
			const commitDrag = (activeDrag, over) => {
				if (dropCommitted.current) return;
				dropCommitted.current = true;
				setDrag(null);
				const targetIndex = rows.findIndex((row) => row.id === over.id);
				if (targetIndex === -1) return;
				const anchor = over.half === "before" ? over.id : rows[targetIndex + 1]?.id;
				if (anchor === activeDrag.sessionId) return;
				const sourceIndex = rows.findIndex((row) => row.id === activeDrag.sessionId);
				const anchorIndex = anchor === void 0 ? rows.length : rows.findIndex((row) => row.id === anchor);
				if (sourceIndex !== -1 && (anchorIndex === sourceIndex || anchorIndex === sourceIndex + 1)) return;
				const nextOrder = rows.map((row) => row.id).filter((id) => id !== activeDrag.sessionId);
				const insertAt = anchor === void 0 ? nextOrder.length : nextOrder.indexOf(anchor);
				nextOrder.splice(insertAt === -1 ? nextOrder.length : insertAt, 0, activeDrag.sessionId);
				setSessionOrder(FLAT_SESSION_ORDER_KEY, nextOrder.map((id) => id));
			};
			const now = Date.now();
			return (0, react_jsx_runtime.jsxs)("div", {
				className: clsx(WorkspaceBrowser_module_css_default.treeBody, WorkspaceBrowser_module_css_default.wide),
				children: [(0, react_jsx_runtime.jsxs)("div", {
					className: clsx(WorkspaceBrowser_module_css_default.list, WorkspaceBrowser_module_css_default.flatList),
					role: "tree",
					"aria-label": t("section.sessions"),
					children: [rows.length === 0 && (0, react_jsx_runtime.jsx)("div", {
						className: WorkspaceBrowser_module_css_default.empty,
						children: t("empty.none")
					}), rows.map((node) => {
						const active = drag !== null;
						return (0, react_jsx_runtime.jsx)(SessionNodeItem, {
							node,
							currentId: panelActive ? void 0 : list.current,
							now,
							onOpen: open,
							onRename: onSessionRename,
							onFork: forkSession,
							onArchive: onSessionArchive,
							onReveal: node.id === revealSessionId ? () => {
								onSessionRevealed(node.id);
							} : void 0,
							flat: true,
							drag: {
								start: () => {
									dropCommitted.current = false;
									setDrag({
										accountKey: FLAT_SESSION_ORDER_KEY,
										sessionId: node.id,
										over: null
									});
								},
								active,
								marker: active && drag.over?.id === node.id ? drag.over.half : null,
								hover: (half) => {
									setDrag((current) => current === null ? current : {
										...current,
										over: {
											id: node.id,
											half
										}
									});
								},
								drop: (half) => {
									if (drag !== null) commitDrag(drag, {
										id: node.id,
										half
									});
								},
								end: () => {
									if (drag?.over !== null && drag?.over !== void 0) commitDrag(drag, drag.over);
									else setDrag(null);
									dropCommitted.current = false;
								}
							},
							t
						}, node.id);
					})]
				}), (0, react_jsx_runtime.jsx)("span", { className: WorkspaceBrowser_module_css_default.fade })]
			});
		}
		/** Flat search body: local metadata matches plus the current Host result page. */
		function SearchResults({ useSessions, useSessionPendingInteraction, open, workspaces, archivedSessionIds, query, remote, resultLimit, usePanelInfo, t }) {
			const panelActive = usePanelInfo((info) => info.activePanelId !== null);
			const list = useSessions((s) => s);
			const pendingInteractions = useSessionPendingInteraction((s) => s);
			const currentRemote = remote.query === query ? remote : {
				query,
				status: "loading",
				items: [],
				hasMore: false
			};
			const results = (0, react.useMemo)(() => deriveSearchResults(list, workspaces, query, archivedSessionIds, pendingInteractions, currentRemote, resultLimit), [
				list,
				workspaces,
				query,
				archivedSessionIds,
				pendingInteractions,
				currentRemote,
				resultLimit
			]);
			const pending = currentRemote.status === "loading";
			const failed = currentRemote.status === "error";
			return (0, react_jsx_runtime.jsxs)("div", {
				className: clsx(WorkspaceBrowser_module_css_default.treeBody, WorkspaceBrowser_module_css_default.wide),
				children: [(0, react_jsx_runtime.jsxs)("div", {
					className: WorkspaceBrowser_module_css_default.list,
					children: [
						(0, react_jsx_runtime.jsx)("div", {
							className: WorkspaceBrowser_module_css_default.searchTree,
							role: "tree",
							"aria-label": t("search.results.aria"),
							children: results.items.map((result) => (0, react_jsx_runtime.jsx)(SearchResultItem, {
								result,
								currentId: panelActive ? void 0 : list.current,
								onOpen: open,
								t
							}, result.id))
						}),
						pending && (0, react_jsx_runtime.jsx)("div", {
							className: WorkspaceBrowser_module_css_default.searchStatus,
							role: "status",
							children: t("search.pending")
						}),
						failed && (0, react_jsx_runtime.jsx)("div", {
							className: WorkspaceBrowser_module_css_default.searchWarning,
							role: "status",
							children: t("search.unavailable")
						}),
						!pending && results.items.length === 0 && (0, react_jsx_runtime.jsx)("div", {
							className: WorkspaceBrowser_module_css_default.empty,
							children: t("search.noMatches")
						}),
						results.hasMore && (0, react_jsx_runtime.jsx)("div", {
							className: WorkspaceBrowser_module_css_default.searchStatus,
							children: t("search.hasMore", { n: resultLimit })
						})
					]
				}), (0, react_jsx_runtime.jsx)("span", { className: WorkspaceBrowser_module_css_default.fade })]
			});
		}
		/**
		* Render the browsing region.
		* @param props - composed slot props (shell owner share + store + injected actions).
		* @returns the region element tree.
		*/
		function WorkspaceBrowser({ wide, usePanelInfo, expandSidebar, useSessions, useSessionPendingInteraction, useWorkspaces, useStore, actions, startSession, open, renameSession, forkSession, renameWorkspace, deleteWorkspace, insertWorkspaceBefore, archiveSession, insertSessionBefore, createWorkspace, searchSessions, searchResultLimit, useDirectoryFlow, useHostInfo, renderSlot, t }) {
			const home = useHostInfo((info) => info.home);
			const workspaces = useWorkspaces((state) => state.items);
			const workspacePhase = useWorkspaces((state) => state.phase);
			const workspaceStreamState = useWorkspaces((state) => state.state);
			const archivedSessionIds = useWorkspaces((state) => state.archivedSessionIds);
			const directoryFlowAvailable = useDirectoryFlow((occupied) => occupied);
			const groupBy = useStore((s) => s.groupBy);
			const orderBy = useStore((s) => s.orderBy);
			const groupExpansion = useStore((s) => s.groupExpansion);
			const sessionOrderByAccount = useStore((s) => s.sessionOrderByAccount);
			const sessionUpdatedAtByAccount = useStore((s) => s.sessionUpdatedAtByAccount);
			const currentBlankSessionId = useSessions((state) => {
				const current = state.current;
				return current !== void 0 && state.byId[current]?.blank === true ? current : void 0;
			});
			const currentBlankAccount = currentBlankSessionId === void 0 || workspacePhase !== "ready" ? void 0 : owningGroupKey(workspaces, currentBlankSessionId);
			const promotedBlank = (0, react.useRef)(void 0);
			(0, react.useEffect)(() => {
				if (currentBlankSessionId === void 0 || currentBlankAccount === void 0) {
					promotedBlank.current = void 0;
					return;
				}
				const promoted = promotedBlank.current;
				if (promoted !== void 0 && promoted.sessionId === currentBlankSessionId && promoted.accountKey === currentBlankAccount) return;
				promotedBlank.current = {
					sessionId: currentBlankSessionId,
					accountKey: currentBlankAccount
				};
				for (const accountKey of new Set([currentBlankAccount, FLAT_SESSION_ORDER_KEY])) {
					const previous = sessionOrderByAccount[accountKey] ?? [];
					actions.setSessionOrder(accountKey, [currentBlankSessionId, ...previous.filter((id) => id !== currentBlankSessionId)]);
				}
			}, [
				actions.setSessionOrder,
				currentBlankAccount,
				currentBlankSessionId,
				sessionOrderByAccount
			]);
			(0, react.useEffect)(() => {
				if (workspacePhase !== "ready") return;
				actions.retainAccountKeys([
					"",
					FLAT_SESSION_ORDER_KEY,
					...workspaces.map((workspace) => workspace.workspaceId)
				]);
			}, [
				actions.retainAccountKeys,
				workspacePhase,
				workspaces
			]);
			const [query, setQuery] = (0, react.useState)("");
			const [searchExpanded, setSearchExpanded] = (0, react.useState)(false);
			const [revealSessionId, setRevealSessionId] = (0, react.useState)(void 0);
			const normalizedQuery = sanitizeSearchQuery(query).trim();
			const [remoteSearch, setRemoteSearch] = (0, react.useState)({
				query: "",
				status: "idle",
				items: [],
				hasMore: false
			});
			const searchRoot = (0, react.useRef)(null);
			const searchInput = (0, react.useRef)(null);
			const [wsPickerOpen, setWsPickerOpen] = (0, react.useState)(false);
			const wsPlusRef = (0, react.useRef)(null);
			const composingRef = (0, react.useRef)(false);
			const openSearchResult = (sessionId) => {
				setRevealSessionId(sessionId);
				setQuery("");
				setSearchExpanded(false);
				open(sessionId);
			};
			const acknowledgeSessionReveal = (sessionId) => {
				setRevealSessionId((current) => current === sessionId ? void 0 : current);
			};
			(0, react.useEffect)(() => {
				if (normalizedQuery !== "") setRevealSessionId(void 0);
			}, [normalizedQuery]);
			const [searchOnExpand, setSearchOnExpand] = (0, react.useState)(false);
			(0, react.useEffect)(() => {
				if (wide && searchOnExpand) {
					const timer = window.setTimeout(() => {
						searchInput.current?.focus({ preventScroll: true });
						setSearchOnExpand(false);
					}, EXPAND_SLIDE_MS);
					return () => {
						window.clearTimeout(timer);
					};
				}
			}, [wide, searchOnExpand]);
			(0, react.useEffect)(() => {
				if (!wide || !searchExpanded || searchOnExpand) return;
				searchInput.current?.focus({ preventScroll: true });
			}, [
				wide,
				searchExpanded,
				searchOnExpand
			]);
			(0, react.useEffect)(() => {
				if (!wide || !searchExpanded || searchOnExpand) return;
				const onClick = (event) => {
					if (!(event.target instanceof Node) || searchRoot.current?.contains(event.target) === true) return;
					searchInput.current?.blur();
					if (normalizedQuery !== "") return;
					setSearchExpanded(false);
				};
				document.addEventListener("click", onClick);
				return () => {
					document.removeEventListener("click", onClick);
				};
			}, [
				normalizedQuery,
				wide,
				searchExpanded,
				searchOnExpand
			]);
			(0, react.useEffect)(() => {
				if (normalizedQuery === "") {
					setRemoteSearch({
						query: "",
						status: "idle",
						items: [],
						hasMore: false
					});
					return;
				}
				const controller = new AbortController();
				setRemoteSearch({
					query: normalizedQuery,
					status: "loading",
					items: [],
					hasMore: false
				});
				const timer = window.setTimeout(() => {
					searchSessions(normalizedQuery, controller.signal).then((result) => {
						if (controller.signal.aborted) return;
						setRemoteSearch({
							query: normalizedQuery,
							status: "ready",
							items: result.items,
							hasMore: result.hasMore
						});
					}).catch(() => {
						if (controller.signal.aborted) return;
						setRemoteSearch({
							query: normalizedQuery,
							status: "error",
							items: [],
							hasMore: false
						});
					});
				}, SEARCH_DEBOUNCE_MS);
				return () => {
					window.clearTimeout(timer);
					controller.abort();
				};
			}, [normalizedQuery, searchSessions]);
			const [renameTarget, setRenameTarget] = (0, react.useState)(null);
			const [renameDraft, setRenameDraft] = (0, react.useState)("");
			const [renaming, setRenaming] = (0, react.useState)(false);
			const [renameError, setRenameError] = (0, react.useState)(null);
			const renameTrimmed = renameDraft.trim();
			const renameDuplicate = renameTarget !== null && renameTrimmed !== "" && renameTrimmed !== renameTarget.currentTitle && workspaces.some((w) => w.title === renameTrimmed);
			const renameBlocked = renaming || renameTrimmed === "" || renameTarget === null || renameTrimmed === renameTarget.currentTitle || renameDuplicate;
			const closeRename = () => {
				if (renaming) return;
				setRenameTarget(null);
				setRenameError(null);
			};
			const confirmRename = () => {
				if (renameBlocked) return;
				setRenaming(true);
				setRenameError(null);
				renameWorkspace(renameTarget.workspaceId, renameTrimmed).then(() => {
					setRenaming(false);
					setRenameTarget(null);
				}).catch((reason) => {
					setRenaming(false);
					setRenameError(reason instanceof Error ? reason.message : String(reason));
				});
			};
			const [sessionRenameTarget, setSessionRenameTarget] = (0, react.useState)(null);
			const [sessionRenameDraft, setSessionRenameDraft] = (0, react.useState)("");
			const [sessionRenaming, setSessionRenaming] = (0, react.useState)(false);
			const [sessionRenameError, setSessionRenameError] = (0, react.useState)(null);
			const sessionRenameTrimmed = sessionRenameDraft.trim();
			const sessionRenameBlocked = sessionRenaming || sessionRenameTrimmed === "" || sessionRenameTarget === null;
			const closeSessionRename = () => {
				if (sessionRenaming) return;
				setSessionRenameTarget(null);
				setSessionRenameError(null);
			};
			const confirmSessionRename = () => {
				if (sessionRenameBlocked) return;
				setSessionRenaming(true);
				setSessionRenameError(null);
				renameSession(sessionRenameTarget.sessionId, sessionRenameTrimmed).then(() => {
					setSessionRenaming(false);
					setSessionRenameTarget(null);
				}).catch((reason) => {
					setSessionRenaming(false);
					setSessionRenameError(reason instanceof Error ? reason.message : String(reason));
				});
			};
			const onSessionRename = (sessionId, currentTitle) => {
				setSessionRenameTarget({
					sessionId,
					currentTitle
				});
				setSessionRenameDraft(currentTitle);
				setSessionRenameError(null);
			};
			const onSessionArchive = (sessionId) => {
				archiveSession(sessionId).catch((reason) => {
					console.warn("session archive rejected:", reason);
				});
			};
			const [deleteTarget, setDeleteTarget] = (0, react.useState)(null);
			const [deleting, setDeleting] = (0, react.useState)(false);
			const [deleteCommittedId, setDeleteCommittedId] = (0, react.useState)(null);
			const [deleteError, setDeleteError] = (0, react.useState)(null);
			(0, react.useEffect)(() => {
				if (deleteCommittedId === null || workspaces.some((workspace) => workspace.workspaceId === deleteCommittedId)) return;
				setDeleting(false);
				setDeleteCommittedId(null);
				setDeleteTarget(null);
			}, [deleteCommittedId, workspaces]);
			const closeDelete = () => {
				if (deleting) return;
				setDeleteTarget(null);
				setDeleteError(null);
			};
			const confirmDelete = () => {
				/* v8 ignore next -- the Modal is absent without a target and its button is disabled while deleting. */
				if (deleting || deleteTarget === null) return;
				setDeleting(true);
				setDeleteCommittedId(null);
				setDeleteError(null);
				deleteWorkspace(deleteTarget.workspaceId).then(() => {
					setDeleteCommittedId(deleteTarget.workspaceId);
				}).catch((reason) => {
					setDeleting(false);
					setDeleteError(reason instanceof Error ? reason.message : String(reason));
				});
			};
			return (0, react_jsx_runtime.jsxs)("div", {
				className: clsx(WorkspaceBrowser_module_css_default.root, !wide && WorkspaceBrowser_module_css_default.rail),
				children: [
					(0, react_jsx_runtime.jsxs)("div", {
						className: WorkspaceBrowser_module_css_default.sectionHeader,
						children: [
							wide && (0, react_jsx_runtime.jsx)("span", {
								className: clsx(WorkspaceBrowser_module_css_default.sectionLabel, WorkspaceBrowser_module_css_default.wide, searchExpanded && WorkspaceBrowser_module_css_default.sectionLabelHidden),
								children: groupBy === "flat" ? t("section.sessions") : t("section.workspaces")
							}),
							wide && (0, react_jsx_runtime.jsx)("div", {
								className: clsx(WorkspaceBrowser_module_css_default.searchSlot, searchExpanded && WorkspaceBrowser_module_css_default.searchSlotExpanded),
								children: (0, react_jsx_runtime.jsxs)("div", {
									ref: searchRoot,
									className: clsx(WorkspaceBrowser_module_css_default.search, searchExpanded && WorkspaceBrowser_module_css_default.searchExpanded),
									onClick: () => {
										setWsPickerOpen(false);
										setSearchExpanded(true);
										searchInput.current?.focus();
									},
									children: [
										(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
											label: t("search"),
											side: "bottom",
											delayMs: 500,
											disabled: searchExpanded,
											children: (0, react_jsx_runtime.jsx)("button", {
												type: "button",
												className: WorkspaceBrowser_module_css_default.searchButton,
												"aria-label": t("search.sessions.aria"),
												"aria-expanded": searchExpanded,
												onClick: () => {
													setWsPickerOpen(false);
													setSearchExpanded(true);
												},
												children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconSearchOutline16, { size: searchExpanded ? 11 : 14 })
											})
										}),
										(0, react_jsx_runtime.jsx)("input", {
											ref: searchInput,
											className: WorkspaceBrowser_module_css_default.searchInput,
											type: "text",
											placeholder: t("search.placeholder"),
											maxLength: SEARCH_QUERY_MAX_CODE_UNITS,
											value: query,
											tabIndex: searchExpanded ? 0 : -1,
											onChange: (e) => {
												setQuery(sanitizeSearchQuery(e.target.value));
											},
											onKeyDown: (e) => {
												if (e.key !== "Escape") return;
												setQuery("");
												setSearchExpanded(false);
											}
										}),
										searchExpanded && (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											className: WorkspaceBrowser_module_css_default.clearButton,
											"aria-label": t("search.clear"),
											onClick: (e) => {
												e.stopPropagation();
												setQuery("");
												setSearchExpanded(false);
											},
											children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconCloseFill14, {})
										})
									]
								})
							}),
							(0, react_jsx_runtime.jsxs)("div", {
								className: clsx(WorkspaceBrowser_module_css_default.headerActions, wide && searchExpanded && WorkspaceBrowser_module_css_default.headerActionsHidden),
								children: [wide && (0, react_jsx_runtime.jsx)(ViewOptionsMenu, {
									groupBy,
									orderBy,
									onGroupPick: (mode) => {
										actions.setGroupBy(mode);
									},
									onOrderPick: (mode) => {
										actions.setOrderBy(mode);
									},
									t
								}), directoryFlowAvailable && (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
									label: t("workspace.add"),
									side: "bottom",
									delayMs: 500,
									children: (0, react_jsx_runtime.jsx)("button", {
										ref: wsPlusRef,
										type: "button",
										className: WorkspaceBrowser_module_css_default.iconButton,
										"aria-label": t("workspace.add"),
										onClick: () => {
											setWsPickerOpen((v) => !v);
										},
										children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconProjectAddOutline16, { size: wide ? 16 : 18 })
									})
								})]
							}),
							(0, react_jsx_runtime.jsx)(WorkspacePickFlow, {
								t,
								open: wsPickerOpen,
								anchorRef: wsPlusRef,
								useWorkspaces,
								createWorkspace,
								useDirectoryFlow,
								renderDirectoryFlow: (owner) => renderSlot("sidebar.workspaces.directoryFlow", owner),
								addOnly: true,
								side: "right",
								onPick: (workspaceId) => {
									setWsPickerOpen(false);
									startSession(workspaceId);
								},
								onClose: () => {
									setWsPickerOpen(false);
								}
							})
						]
					}),
					!wide && (0, react_jsx_runtime.jsx)("div", {
						className: WorkspaceBrowser_module_css_default.search,
						children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
							label: t("search"),
							children: (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: WorkspaceBrowser_module_css_default.searchButton,
								"aria-label": t("search.sessions.aria"),
								onClick: () => {
									setSearchExpanded(true);
									setSearchOnExpand(true);
									expandSidebar();
								},
								children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconSearchOutline16, { size: 18 })
							})
						})
					}),
					(0, react_jsx_runtime.jsx)("div", {
						className: WorkspaceBrowser_module_css_default.listArea,
						children: wide && (normalizedQuery !== "" ? (0, react_jsx_runtime.jsx)(SearchResults, {
							usePanelInfo,
							useSessions,
							useSessionPendingInteraction,
							open: openSearchResult,
							workspaces,
							archivedSessionIds,
							query: normalizedQuery,
							remote: remoteSearch,
							resultLimit: searchResultLimit,
							t
						}) : groupBy === "flat" ? (0, react_jsx_runtime.jsx)(FlatList, {
							usePanelInfo,
							useSessions,
							useSessionPendingInteraction,
							open,
							forkSession,
							onSessionRename,
							onSessionArchive,
							archivedSessionIds,
							orderBy,
							sessionOrderByAccount,
							sessionUpdatedAtByAccount,
							syncSessionOrderAccount: actions.syncSessionOrderAccount,
							setSessionOrder: actions.setSessionOrder,
							revealSessionId,
							onSessionRevealed: acknowledgeSessionReveal,
							t
						}) : (0, react_jsx_runtime.jsx)(SessionTree, {
							usePanelInfo,
							useSessions,
							useSessionPendingInteraction,
							onSessionRename,
							onSessionArchive,
							forkSession,
							workspaces,
							workspaceReady: workspacePhase === "ready" && workspaceStreamState !== "loading",
							groupExpansion,
							setGroupExpanded: actions.setGroupExpanded,
							sessionOrderByAccount,
							sessionUpdatedAtByAccount,
							syncSessionOrderAccount: actions.syncSessionOrderAccount,
							setSessionOrder: actions.setSessionOrder,
							archivedSessionIds,
							startSession,
							open,
							insertWorkspaceBefore,
							insertSessionBefore,
							orderBy,
							revealSessionId,
							onSessionRevealed: acknowledgeSessionReveal,
							home,
							t,
							onRenameRequest: (workspaceId, currentTitle) => {
								setRenameTarget({
									workspaceId,
									currentTitle
								});
								setRenameDraft(currentTitle);
								setRenameError(null);
							},
							onDeleteRequest: (workspaceId, title) => {
								setDeleteTarget({
									workspaceId,
									title
								});
								setDeleteError(null);
							}
						}))
					}),
					(0, react_jsx_runtime.jsxs)(_deepseek_ai_dsh_client_ui_primitives.Modal, {
						open: renameTarget !== null,
						onClose: closeRename,
						closeLabel: t("close"),
						title: t("rename.workspace.title"),
						footer: (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							variant: "outline",
							disabled: renaming,
							onClick: closeRename,
							children: t("cancel")
						}), (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							variant: "primary",
							disabled: renameBlocked,
							onClick: confirmRename,
							children: t("rename")
						})] }),
						children: [
							(0, react_jsx_runtime.jsx)("input", {
								className: WorkspaceBrowser_module_css_default.renameInput,
								value: renameDraft,
								"aria-label": t("field.workspaceName"),
								autoFocus: true,
								disabled: renaming,
								onFocus: (e) => {
									e.target.select();
								},
								onChange: (e) => {
									setRenameDraft(e.target.value);
									setRenameError(null);
								},
								onCompositionStart: () => {
									composingRef.current = true;
								},
								onCompositionEnd: () => {
									composingRef.current = false;
								},
								onKeyDown: (e) => {
									if (e.key === "Enter" && !composingRef.current) {
										e.preventDefault();
										confirmRename();
									}
								}
							}),
							renameDuplicate && (0, react_jsx_runtime.jsx)("div", {
								className: WorkspaceBrowser_module_css_default.renameError,
								role: "alert",
								children: t("conflict.named", { name: renameTrimmed })
							}),
							renameError !== null && (0, react_jsx_runtime.jsx)("div", {
								className: WorkspaceBrowser_module_css_default.renameError,
								role: "alert",
								children: renameError
							})
						]
					}),
					(0, react_jsx_runtime.jsxs)(_deepseek_ai_dsh_client_ui_primitives.Modal, {
						open: sessionRenameTarget !== null,
						onClose: closeSessionRename,
						closeLabel: t("close"),
						title: t("rename.session.title"),
						footer: (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							variant: "outline",
							disabled: sessionRenaming,
							onClick: closeSessionRename,
							children: t("cancel")
						}), (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							variant: "primary",
							disabled: sessionRenameBlocked,
							onClick: confirmSessionRename,
							children: t("rename")
						})] }),
						children: [(0, react_jsx_runtime.jsx)("input", {
							className: WorkspaceBrowser_module_css_default.renameInput,
							value: sessionRenameDraft,
							"aria-label": t("field.sessionName"),
							autoFocus: true,
							disabled: sessionRenaming,
							onFocus: (e) => {
								e.target.select();
							},
							onChange: (e) => {
								setSessionRenameDraft(e.target.value);
								setSessionRenameError(null);
							},
							onCompositionStart: () => {
								composingRef.current = true;
							},
							onCompositionEnd: () => {
								composingRef.current = false;
							},
							onKeyDown: (e) => {
								if (e.key === "Enter" && !composingRef.current) {
									e.preventDefault();
									confirmSessionRename();
								}
							}
						}), sessionRenameError !== null && (0, react_jsx_runtime.jsx)("div", {
							className: WorkspaceBrowser_module_css_default.renameError,
							role: "alert",
							children: sessionRenameError
						})]
					}),
					(0, react_jsx_runtime.jsxs)(_deepseek_ai_dsh_client_ui_primitives.Modal, {
						open: deleteTarget !== null,
						onClose: closeDelete,
						closeLabel: t("close"),
						title: t("delete.workspace"),
						...deleteTarget === null ? {} : { description: t("delete.desc", { name: deleteTarget.title }) },
						footer: (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							variant: "outline",
							disabled: deleting,
							onClick: closeDelete,
							children: t("cancel")
						}), (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							variant: "outline",
							className: WorkspaceBrowser_module_css_default.deleteAction,
							disabled: deleting,
							onClick: confirmDelete,
							children: t("delete.workspace")
						})] }),
						children: [deleting && (0, react_jsx_runtime.jsx)("div", {
							className: WorkspaceBrowser_module_css_default.deleteStatus,
							role: "status",
							children: t("delete.pending")
						}), deleteError !== null && (0, react_jsx_runtime.jsx)("div", {
							className: WorkspaceBrowser_module_css_default.renameError,
							role: "alert",
							children: deleteError
						})]
					})
				]
			});
		}
		//#endregion
		//#region lib/types/client/locales.js
		/**
		* `workspace` namespace dictionaries: the browsing region (section header,
		* search, tree rows, dialogs) and the pick/add flow. Runtime failure
		* messages (wire error strings) pass through untranslated by policy.
		*/
		/** Simplified Chinese dictionary (the key-set source of truth). */
		const zh = {
			"group.ungrouped": "未分组",
			"session.new": "新会话",
			"section.workspaces": "工作区",
			"section.sessions": "会话",
			"viewOptions.label": "视图选项",
			"groupBy.label": "分组方式",
			"groupBy.workspace": "按工作区",
			"groupBy.flat": "单列表",
			"orderBy.label": "排序方式",
			"orderBy.manual": "手动排序",
			"orderBy.updated": "最近更新",
			"sessions.expand": "展开其余 {n} 个会话",
			"sessions.collapse": "收起",
			"empty.none": "暂无会话",
			"empty.noMatches": "无匹配结果",
			"workspace.add": "添加工作区",
			"search.sessions.aria": "搜索会话",
			"search.placeholder": "搜索会话…",
			"search.clear": "清除搜索",
			"search.results.aria": "搜索结果",
			"search.pending": "正在搜索会话历史…",
			"search.unavailable": "内容搜索暂不可用，仅显示名称匹配。",
			"search.noMatches": "无匹配会话",
			"search.hasMore": "仅显示前 {n} 条结果，请缩小搜索范围。",
			"menu.addWorkspace": "添加工作区…",
			"picker.loading": "正在加载工作区…",
			"conflict.named": "已存在名为“{name}”的工作区。",
			"folderError.title": "无法打开文件夹",
			"folderError.retry": "重新选择",
			"rename": "重命名",
			"rename.workspace.title": "重命名工作区",
			"rename.session.title": "重命名会话",
			"field.workspaceName": "工作区名称",
			"field.sessionName": "会话名称",
			"delete.workspace": "删除工作区",
			"delete.desc": "将把“{name}”从工作区列表中移除。文件夹与会话记录会保留，其会话将显示在“未分组”下。",
			"delete.pending": "正在删除工作区…",
			"menu.fork": "分叉会话",
			"menu.archiveSession": "归档会话",
			"sessions.count.one": "{n} 个会话",
			"sessions.count.other": "{n} 个会话",
			"actions.workspace.aria": "工作区“{name}”的操作",
			"actions.session.aria": "会话“{name}”的操作",
			"actions.newSession.aria": "在“{name}”中新建会话",
			"status.running": "进行中",
			"status.subagentsRunning.one": "{n} 个子代理运行中",
			"status.subagentsRunning.other": "{n} 个子代理运行中",
			"status.idle": "空闲",
			"status.waitingApproval": "等待审批",
			"status.planReview": "计划待审",
			"status.waitingAnswer": "等待回答",
			"status.completed": "已完成",
			"schedule.active": "有活动定时任务",
			"hover.created": "创建于 {time}",
			"hover.copied": "已复制",
			"date.ymd": "{y}年{m}月{d}日",
			"time.now": "刚刚",
			"time.minutes": "{n}分钟",
			"time.hours": "{n}小时",
			"time.days": "{n}天",
			"time.months": "{n}个月",
			"time.years": "{n}年",
			"time.ago": "{t}前"
		};
		/** English dictionary, checked complete against the zh key set. */
		const en = {
			"group.ungrouped": "Ungrouped",
			"session.new": "New Session",
			"section.workspaces": "Workspaces",
			"section.sessions": "Sessions",
			"viewOptions.label": "View options",
			"groupBy.label": "Group by",
			"groupBy.workspace": "WorkSpace",
			"groupBy.flat": "In one list",
			"orderBy.label": "Order by",
			"orderBy.manual": "Manual",
			"orderBy.updated": "Last updated",
			"sessions.expand": "Show {n} more sessions",
			"sessions.collapse": "Show less",
			"empty.none": "No sessions yet",
			"empty.noMatches": "No matches",
			"workspace.add": "Add workspace",
			"search.sessions.aria": "Search sessions",
			"search.placeholder": "Search sessions...",
			"search.clear": "Clear search",
			"search.results.aria": "Search results",
			"search.pending": "Searching session history…",
			"search.unavailable": "Content search is temporarily unavailable. Showing name matches.",
			"search.noMatches": "No matching sessions",
			"search.hasMore": "Showing the first {n} results. Narrow your search.",
			"menu.addWorkspace": "Add workspace…",
			"picker.loading": "Loading workspaces…",
			"conflict.named": "A workspace named “{name}” already exists.",
			"folderError.title": "Couldn’t open folder",
			"folderError.retry": "Choose again",
			"rename": "Rename",
			"rename.workspace.title": "Rename workspace",
			"rename.session.title": "Rename session",
			"field.workspaceName": "Workspace name",
			"field.sessionName": "Session name",
			"delete.workspace": "Delete workspace",
			"delete.desc": "This removes “{name}” from the workspace list. The folder and session logs will be kept. Its sessions will appear under Ungrouped.",
			"delete.pending": "Deleting workspace…",
			"menu.fork": "Fork session",
			"menu.archiveSession": "Archive session",
			"sessions.count.one": "{n} session",
			"sessions.count.other": "{n} sessions",
			"actions.workspace.aria": "Workspace actions for {name}",
			"actions.session.aria": "Session actions for {name}",
			"actions.newSession.aria": "New session in {name}",
			"status.running": "Running",
			"status.subagentsRunning.one": "{n} subagent running",
			"status.subagentsRunning.other": "{n} subagents running",
			"status.idle": "Idle",
			"status.waitingApproval": "Waiting for approval",
			"status.planReview": "Plan awaiting review",
			"status.waitingAnswer": "Waiting for answer",
			"status.completed": "Completed",
			"schedule.active": "Has active scheduled task",
			"hover.created": "Created {time}",
			"hover.copied": "Copied",
			"date.ymd": "{y}-{m}-{d}",
			"time.now": "now",
			"time.minutes": "{n}min",
			"time.hours": "{n}h",
			"time.days": "{n}d",
			"time.months": "{n}mo",
			"time.years": "{n}y",
			"time.ago": "{t} ago"
		};
		//#endregion
		//#region lib/types/client/index.js
		/** Dictionary namespace owned by this plugin. */
		const NS = "workspace";
		/**
		* Required services (cordis fiber inject). The target slots are declared by
		* the ui-sidebar / ui-conversation applies, whose activation order relative
		* to this one is NOT constrained: dsh.client.inject edges are informational
		* (loading/prefetch metadata, never apply sequencing) and neither owner
		* provides a waitable service. apply therefore depends on each slot
		* declaration through `slots.inject()` instead of assuming order.
		*/
		const inject = [
			"slots",
			"sessions",
			"workspaces",
			"locale",
			"remote",
			"remote.directoryPicker",
			"layout"
		];
		/**
		* Register the browser and picker once their slot declarations are on the
		* ledger. Inject factories return plain callbacks; data reads use the
		* framework's global hooks.
		* @param ctx - client root context.
		*/
		function apply(ctx) {
			const sessions = ctx.get("sessions");
			const workspaces = ctx.get("workspaces");
			const uiWorkspace = new UiWorkspaceService(ctx, ctx.remote.directoryPicker, workspaces, sessions);
			ctx.slots.provideRoot({ hooks: { workspaces: workspaces.list } });
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "ui-workspace: dictionaries");
			const searchSessions = async (query, signal) => {
				const result = await sessions.search(query, signal);
				if (!result.ok) throw new Error(result.error.message);
				return result.value;
			};
			const flowSource = (hole) => ({
				getSnapshot: () => ctx.slots.entries(hole).length > 0,
				subscribe: (listener) => ctx.slots.subscribe(hole, listener)
			});
			const browserFlowSource = flowSource("sidebar.workspaces.directoryFlow");
			const hostInfo = {
				getSnapshot: () => ctx.remote.$host,
				subscribe: (listener) => ctx.on("connection/reset", listener)
			};
			const pickerFlowSource = flowSource("conversation.hero.workspace.directoryFlow");
			const openSession = (sessionId) => {
				uiWorkspace.openSession(sessionId);
			};
			const browserInjected = () => ({
				startSession: (workspaceId) => {
					uiWorkspace.startSession(workspaceId);
				},
				open: openSession,
				searchSessions,
				searchResultLimit: sessions.searchResultLimit,
				renameSession: async (sessionId, title) => {
					const session = sessions.binding(sessionId)?.session;
					if (session === void 0) throw new Error(`unknown session "${sessionId}"`);
					const result = await session.rename(title);
					if (!result.ok) throw new Error(result.error.message);
				},
				forkSession: (sessionId) => {
					uiWorkspace.forkSession(sessionId).catch(() => {});
				},
				renameWorkspace: async (workspaceId, title) => {
					await workspaces.rename(workspaceId, title);
				},
				deleteWorkspace: async (workspaceId) => {
					await workspaces.delete(workspaceId);
				},
				insertWorkspaceBefore: async (workspaceId, beforeWorkspaceId) => {
					await workspaces.insertBefore(workspaceId, beforeWorkspaceId);
				},
				archiveSession: async (sessionId) => {
					await uiWorkspace.archiveSession(sessionId);
				},
				insertSessionBefore: async (workspaceId, sessionId, beforeSessionId) => {
					await workspaces.insertSessionBefore(workspaceId, sessionId, beforeSessionId);
				},
				createWorkspace: (input) => workspaces.create(input),
				hooks: {
					directoryFlow: browserFlowSource,
					hostInfo
				}
			});
			const pickerInjected = () => ({
				createWorkspace: (input) => workspaces.create(input),
				hooks: { directoryFlow: pickerFlowSource }
			});
			ctx.slots.inject("sidebar.workspaces", () => ctx.slots.register({
				name: "sidebar.workspaces",
				children: { "sidebar.workspaces.directoryFlow": {
					kind: "single",
					scope: "root"
				} },
				store: createWorkspaceViewStore(),
				inject: browserInjected,
				locale: NS
			}, WorkspaceBrowser));
			ctx.slots.inject("conversation.hero.workspace", () => ctx.slots.register({
				name: "conversation.hero.workspace",
				children: { "conversation.hero.workspace.directoryFlow": {
					kind: "single",
					scope: "root"
				} },
				inject: pickerInjected,
				locale: NS
			}, WorkspacePicker));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
		})();
		var officialApply = officialWorkspace.apply;
		var officialInject = officialWorkspace.inject;

		// ════════════════════════════════════════════════════════════════════
		// 2. styles
		// ════════════════════════════════════════════════════════════════════
		var RPC_PATH = "/betterGitWorktree";
		var CSS =
			":root{--bgw-progressing:#1d4ed8;--bgw-progressing-bg:rgba(59,130,246,.12);--bgw-progressing-line:rgba(59,130,246,.35);"
			+ "--bgw-done:#15803d;--bgw-done-bg:rgba(34,160,74,.12);--bgw-done-line:rgba(34,160,74,.35);"
			+ "--bgw-sync:#0f766e;--bgw-sync-bg:rgba(15,118,110,.12);--bgw-sync-line:rgba(15,118,110,.35);"
			+ "--bgw-behind:#b45309;--bgw-behind-bg:rgba(180,83,9,.12);--bgw-behind-line:rgba(180,83,9,.35)}"
			+ ".bgw-badge{display:inline-flex;align-items:center;gap:3px;flex:none;border-radius:6px;padding:1px 5px;margin-right:2px;font:600 10px/14px Inter,sans-serif;letter-spacing:.01em;white-space:nowrap;box-sizing:border-box;border:1px solid transparent}"
			+ ".bgw-badge .bgw-icon{display:inline-flex;width:12px;height:12px;flex:none}"
			+ ".bgw-badge .bgw-icon svg{width:12px;height:12px}"
			+ ".bgw-badge[data-bgw-state=progressing]{color:var(--bgw-progressing);background:var(--bgw-progressing-bg);border-color:var(--bgw-progressing-line)}"
			+ ".bgw-badge[data-bgw-state=up_to_date],.bgw-badge[data-bgw-state=in_sync]{color:var(--bgw-done);background:var(--bgw-done-bg);border-color:var(--bgw-done-line)}"
			+ ".bgw-badge[data-bgw-state=behind]{color:var(--bgw-behind);background:var(--bgw-behind-bg);border-color:var(--bgw-behind-line)}"
			+ ".bgw-badge[data-bgw-state=unknown]{color:var(--dsw-alias-label-secondary,#666);background:rgba(120,120,120,.12);border-color:rgba(120,120,120,.3)}"
			+ ".bgw-badge[data-bgw-rebase=true]{box-shadow:0 0 0 2px rgba(234,179,8,.55),0 0 9px 2px rgba(234,179,8,.45);animation:bgw-rebase-pulse 2.2s ease-in-out infinite}"
			+ ".bgw-badge[data-bgw-rebase=true]::after{content:'rebase';font:600 9px/12px Inter,sans-serif;color:#a16207;text-transform:uppercase;letter-spacing:.04em}"
			+ "@keyframes bgw-rebase-pulse{0%,100%{box-shadow:0 0 0 2px rgba(234,179,8,.5),0 0 5px 1px rgba(234,179,8,.35)}50%{box-shadow:0 0 0 3px rgba(234,179,8,.7),0 0 12px 3px rgba(234,179,8,.55)}}"
			+ "@media (prefers-color-scheme:dark){.bgw-badge[data-bgw-state=progressing]{color:#93c5fd}.bgw-badge[data-bgw-state=up_to_date],.bgw-badge[data-bgw-state=in_sync]{color:#86efac}.bgw-badge[data-bgw-state=behind]{color:#fcd34d}.bgw-badge[data-bgw-rebase=true]::after{color:#fde047}}"
			// The header pill carries the same status colour as the sidebar badge.
			+ ".bgw-header-action{background:transparent}"
			+ ".bgw-header-action[data-bgw-state=progressing]{color:var(--bgw-progressing)}"
			+ ".bgw-header-action[data-bgw-state=up_to_date],.bgw-header-action[data-bgw-state=in_sync]{color:var(--bgw-done)}"
			+ ".bgw-header-action[data-bgw-state=behind]{color:var(--bgw-behind)}"
			+ ".bgw-header-action[data-bgw-state=unknown]{color:var(--dsw-alias-label-secondary,#444)}"
			+ ".bgw-header-action .bgw-pill-name{font-weight:600}"
			+ ".bgw-presession{display:inline-flex;align-items:center;gap:6px;flex:none}"
			+ ".bgw-presession-label{font:500 12px/16px Inter,sans-serif;color:var(--dsw-alias-label-secondary,#666);cursor:default;user-select:none}"
			+ ".bgw-modal-actions{display:flex;gap:8px;justify-content:flex-end;align-items:center}"
			+ ".bgw-menu-summary{display:flex;flex-direction:column;gap:2px;max-width:280px;white-space:normal;font:400 11px/15px Inter,sans-serif;color:var(--dsw-alias-label-secondary,#666)}"
			+ ".bgw-menu-summary strong{font:600 12px/16px Inter,sans-serif;color:var(--dsw-alias-label-primary,#222)}"
			+ ".bgw-menu-error{color:var(--dsw-alias-state-error-primary,#c00)}"
			+ ".bgw-menu-notice{color:var(--bgw-done)}"
			+ ".bgw-panel{display:flex;flex-direction:column;gap:10px;padding:10px 12px;height:100%;overflow:auto;font:400 12px/18px Inter,sans-serif;color:var(--dsw-alias-label-primary,#333)}"
			+ ".bgw-panel h4{margin:0;font:600 12px/18px Inter,sans-serif;color:var(--dsw-alias-label-primary,#222)}"
			+ ".bgw-panel .bgw-note{color:var(--dsw-alias-label-secondary,#666)}"
			+ ".bgw-panel .bgw-warn{color:#a16207;font-weight:600}"
			+ ".bgw-panel pre{margin:0;padding:8px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,#f6f6f6);overflow:auto;font:400 11px/16px ui-monospace,monospace}"
			+ ".bgw-panel-head{display:flex;align-items:center;justify-content:space-between;gap:8px}"
			+ ".bgw-row{display:flex;gap:6px;align-items:baseline;font:400 11px/16px ui-monospace,monospace}"
			+ ".bgw-row .bgw-code{color:var(--dsw-alias-label-secondary,#777);flex:none}";

		function installStyles() {
			var style = document.createElement("style");
			style.dataset.dshBetterGitWorktree = "true";
			style.textContent = CSS;
			document.head.append(style);
			return function () {
				style.remove();
			};
		}

		// ════════════════════════════════════════════════════════════════════
		// 3. host transport + status store
		// ════════════════════════════════════════════════════════════════════
		function rpc(endpoint, payload) {
			return fetch(RPC_PATH + "/" + encodeURIComponent(endpoint), {
				method: "POST",
				headers: { "content-type": "application/json" },
				credentials: "same-origin",
				body: JSON.stringify(payload === undefined ? {} : payload),
			}).then(function (response) {
				if (!response.ok) throw new Error("HTTP " + response.status + " from " + endpoint);
				return response.json();
			});
		}

		var STATE_LABELS = {
			progressing: "Progressing",
			behind: "Behind",
			up_to_date: "Up To Date",
			in_sync: "In Sync",
			unknown: "Unknown",
		};

		function stateLabel(state) {
			return STATE_LABELS[state] || STATE_LABELS.unknown;
		}

		/** What to call a checkout on screen: its pet name, else its branch. */
		function checkoutName(entry) {
			if (entry === undefined || entry === null) return undefined;
			if (typeof entry.petName === "string" && entry.petName !== "") return entry.petName;
			if (typeof entry.branch === "string" && entry.branch !== "") return entry.branch;
			return undefined;
		}

		function decorationOf(entry) {
			if (entry === undefined || entry === null) return undefined;
			if (entry.missing === true || entry.state === "unknown") {
				return {
					kind: "better-git-worktree",
					state: "unknown",
					label: entry.missing === true ? "Missing" : "Unknown",
					needsRebase: false,
					tooltip: entry.tooltip || "The managed worktree no longer exists on disk.",
				};
			}
			var state = typeof entry.state === "string" ? entry.state : "unknown";
			return {
				kind: "better-git-worktree",
				state: state,
				label: stateLabel(state),
				needsRebase: entry.needsRebase === true,
				tooltip: entry.tooltip || "",
			};
		}

		function createStatusStore() {
			var listeners = new Set();
			// `entries` are the managed worktrees (sidebar badges); `tracked` is a
			// status read for the session on screen, which need not be a worktree
			// session at all — the header pill describes any checkout.
			var state = { decorations: {}, entries: [], current: {}, at: 0, error: null, ready: false };
			var tracked = null;
			function emit() {
				for (var listener of Array.from(listeners)) {
					try {
						listener();
					} catch (error) {
						console.error("[better-git-worktree] status listener failed", error);
					}
				}
			}
			return {
				get: function () {
					return state;
				},
				entryFor: function (sessionId) {
					for (var entry of state.entries) {
						if (entry && (entry.sessionId === sessionId || entry.targetSessionId === sessionId)) return entry;
					}
					return state.current[sessionId];
				},
				/** Ask for this session's checkout status on every refresh. */
				track: function (sessionId) {
					if (tracked === sessionId) return;
					tracked = typeof sessionId === "string" ? sessionId : null;
					if (tracked !== null) void this.refresh(true);
				},
				subscribe: function (listener) {
					listeners.add(listener);
					return function () {
						listeners.delete(listener);
					};
				},
				refresh: function (force) {
					var current = tracked === null ? Promise.resolve() : rpc("status", { sessionId: tracked, force: force === true })
						.then(function (result) {
							if (result && result.ok === true && result.value && result.value.status) {
								var status = result.value.status;
								if (tracked !== null) state.current[tracked] = status;
							}
						})
						.catch(function () {});
					return Promise.all([current, rpc("snapshot", force === true ? {} : {}).then(function (result) {
							if (result && result.ok === true) {
								var decorations = {};
								var entries = result.value.worktrees || [];
								for (var entry of entries) {
									if (!entry || typeof entry.sessionId !== "string") continue;
									var decoration = decorationOf(entry);
									decorations[entry.sessionId] = decoration;
									// A converted session keeps its record under the source
									// id; the session actually living in the worktree is
									// `targetSessionId`.
									if (typeof entry.targetSessionId === "string") decorations[entry.targetSessionId] = decoration;
								}
								state = Object.assign({}, state, {
									decorations: decorations,
									entries: entries,
									at: result.value.at,
									error: null,
									ready: true,
								});
							} else {
								state = Object.assign({}, state, {
									error: (result && result.error && result.error.message) || "snapshot failed",
									ready: true,
								});
							}
						})
						.catch(function (error) {
							state = Object.assign({}, state, { error: String((error && error.message) || error), ready: true });
						})]).then(emit);
				},
			};
		}

		var statusStore = createStatusStore();

		function useStatusVersion() {
			var pair = React.useState(0);
			var setVersion = pair[1];
			React.useEffect(function () {
				return statusStore.subscribe(function () {
					setVersion(function (value) {
						return value + 1;
					});
				});
			}, []);
			return pair[0];
		}

		/**
		 * Archiving a worktree session is a two-part decision — hide the session,
		 * and decide what happens to the working copy on disk — so the archive
		 * call is intercepted and answered by a dialog instead of running
		 * straight through.
		 */
		var archivePrompt = {
			pending: null,
			listeners: new Set(),
			subscribe: function (listener) {
				this.listeners.add(listener);
				var self = this;
				return function () {
					self.listeners.delete(listener);
				};
			},
			emit: function () {
				for (var listener of Array.from(this.listeners)) listener();
			},
			open: function (sessionId, proceed) {
				this.pending = { sessionId: sessionId, proceed: proceed };
				this.emit();
			},
			close: function () {
				this.pending = null;
				this.emit();
			},
		};

		/**
		 * Always returns a promise: the official Browser chains `.catch()` onto
		 * whatever the archive call returns, so answering with `undefined` while
		 * the dialog is open throws inside its own handler.
		 */
		function requestArchive(sessionId, proceed) {
			var entry = typeof sessionId === "string" ? statusStore.entryFor(sessionId) : undefined;
			if (entry === undefined || entry.missing === true) return Promise.resolve(proceed(sessionId));
			return new Promise(function (resolve, reject) {
				archivePrompt.open(sessionId, function (id) {
					Promise.resolve(proceed(id)).then(resolve, reject);
				});
			});
		}

		// ════════════════════════════════════════════════════════════════════
		// 4. projection of the worktree decoration into the session list
		// ════════════════════════════════════════════════════════════════════
		// The badge renderer itself lives in the seam helpers patched into the
		// inlined official bundle (see scripts/build-client.mjs); this half only
		// pins the decoration onto the session summaries the Browser reads.
		/**
		 * Rewrite the workspace list so a worktree session appears under the
		 * project it was branched from instead of as its own top-level workspace.
		 *
		 * The Host registers the working copy as a real Workspace (it has to: a
		 * session's cwd must be an accounted Workspace path), and that Workspace
		 * owns the session. For the sidebar, the worktree Workspace is an
		 * implementation detail — it is dropped from the list and its sessions are
		 * re-parented onto the Workspace whose path is the repository root.
		 */
		function projectWorkspaceState(state, entries) {
			if (state === undefined || state === null || !Array.isArray(state.items) || entries.length === 0) return state;
			const sourceByRoot = new Map();
			for (const entry of entries) {
				if (entry && typeof entry.managedRoot === "string" && typeof entry.repoRoot === "string") {
					sourceByRoot.set(entry.managedRoot, entry.repoRoot);
				}
			}
			if (sourceByRoot.size === 0) return state;
			const workspaceByPath = new Map(state.items.map((workspace) => [workspace.path, workspace]));
			/** Walk up an arbitrarily deep chain of nested worktrees to the visible project. */
			const visibleSourceOf = (workspace) => {
				const seen = new Set([workspace.path]);
				let current = workspace;
				for (let depth = 0; depth < 16; depth += 1) {
					const repoRoot = sourceByRoot.get(current.path);
					if (repoRoot === undefined || seen.has(repoRoot)) return undefined;
					const candidate = workspaceByPath.get(repoRoot);
					if (candidate === undefined) return undefined;
					if (!sourceByRoot.has(candidate.path)) return candidate;
					seen.add(repoRoot);
					current = candidate;
				}
				return undefined;
			};
			const hidden = [];
			const sourceIds = new Set();
			for (const workspace of state.items) {
				if (!sourceByRoot.has(workspace.path)) continue;
				if (visibleSourceOf(workspace) === undefined) continue;
				hidden.push(workspace);
				sourceIds.add(workspace.workspaceId);
			}
			if (hidden.length === 0) return state;
			const relocatedBySource = new Map();
			for (const workspace of hidden) {
				const source = visibleSourceOf(workspace);
				if (source === undefined) continue;
				const bucket = relocatedBySource.get(source.workspaceId) ?? [];
				for (const sessionId of workspace.sessionIds) if (!bucket.includes(sessionId)) bucket.push(sessionId);
				relocatedBySource.set(source.workspaceId, bucket);
			}
			const items = [];
			for (const workspace of state.items) {
				if (sourceIds.has(workspace.workspaceId)) continue;
				const relocated = relocatedBySource.get(workspace.workspaceId);
				items.push(relocated === undefined
					? workspace
					: Object.assign({}, workspace, { sessionIds: [...relocated, ...workspace.sessionIds.filter((id) => !relocated.includes(id))] }));
			}
			// The archive set is the harness's, not this plugin's: never filter it,
			// or archiving a worktree session would look like a no-op.
			return Object.assign({}, state, { items });
		}

		function projectSessionState(state, decorations) {
			if (state === undefined || state === null || state.byId === undefined) return state;
			var ids = Object.keys(decorations);
			if (ids.length === 0) return state;
			var byId = Object.assign({}, state.byId);
			var changed = false;
			for (var sessionId of ids) {
				var summary = byId[sessionId];
				if (summary === undefined) continue;
				byId[sessionId] = Object.assign({}, summary, { __betterGitWorktree: decorations[sessionId] });
				changed = true;
			}
			return changed ? Object.assign({}, state, { byId: byId }) : state;
		}

		function makeBrowserWrapper(officialBrowser) {
			return function BetterGitWorktreeWorkspaceBrowser(props) {
				useStatusVersion();
				var useSessions = props.useSessions;
				var useWorkspaces = props.useWorkspaces;
				var sessionState =
					typeof useSessions === "function"
						? useSessions(function (state) {
								return state;
							})
						: undefined;
				var workspaceState =
					typeof useWorkspaces === "function"
						? useWorkspaces(function (state) {
								return state;
							})
						: undefined;
				var at = statusStore.get().at;
				var decorations = statusStore.get().decorations;
				var entries = statusStore.get().entries;
				var projected = React.useMemo(
					function () {
						return projectSessionState(sessionState, decorations);
					},
					[sessionState, at, decorations],
				);
				var projectedWorkspaces = React.useMemo(
					function () {
						return projectWorkspaceState(workspaceState, entries);
					},
					[workspaceState, at, entries],
				);
				var useProjectedSessions = React.useMemo(
					function () {
						return function (selector) {
							return selector(projected === undefined ? sessionState : projected);
						};
					},
					[projected, sessionState],
				);
				var useProjectedWorkspaces = React.useMemo(
					function () {
						return function (selector) {
							return selector(projectedWorkspaces === undefined ? workspaceState : projectedWorkspaces);
						};
					},
					[projectedWorkspaces, workspaceState],
				);
				var nextProps = Object.assign({}, props);
				if (typeof useSessions === "function") nextProps.useSessions = useProjectedSessions;
				if (typeof useWorkspaces === "function") nextProps.useWorkspaces = useProjectedWorkspaces;
				return React.createElement(officialBrowser, nextProps);
			};
		}

		/**
		 * Apply the inlined official Workspace client, replacing only its Browser
		 * component. Everything else — the declaration tree, the WorkspacePicker,
		 * the locale dictionaries, the view store, directory flow — is untouched.
		 */
		function mountDecoratedWorkspaceBrowser(ctx) {
			var proxySlots = new Proxy(ctx.slots, {
				get: function (target, key, receiver) {
					if (key === "register") {
						return function (descriptor, component) {
							if (descriptor && descriptor.name === "sidebar.workspaces") {
								var injectProps = descriptor.inject;
								var guarded = descriptor;
								if (typeof injectProps === "function") {
									guarded = Object.assign({}, descriptor, {
										inject: function () {
											var injected = injectProps.apply(null, arguments) || {};
											if (typeof injected.archiveSession !== "function") return injected;
											return Object.assign({}, injected, {
												archiveSession: function (sessionId) {
													return requestArchive(sessionId, injected.archiveSession);
												},
											});
										},
									});
								}
								return target.register(guarded, makeBrowserWrapper(component));
							}
							return target.register(descriptor, component);
						};
					}
					return Reflect.get(target, key, receiver);
				},
			});
			var proxyCtx = new Proxy(ctx, {
				get: function (target, key, receiver) {
					if (key === "slots") return proxySlots;
					return Reflect.get(target, key, receiver);
				},
			});
			officialApply(proxyCtx);
			// The header's own menus reach the service directly rather than the
			// Browser props, so guard that entry point too.
			var service = typeof ctx.get === "function" ? ctx.get("uiWorkspace") : undefined;
			if (service !== undefined && typeof service.archiveSession === "function") {
				var originalArchive = service.archiveSession.bind(service);
				service.archiveSession = function (sessionId) {
					return requestArchive(sessionId, originalArchive);
				};
				ctx.effect(function () {
					return function () {
						delete service.archiveSession;
					};
				}, "dsh-better-git-worktree: archive interception");
			}
		}

		// ════════════════════════════════════════════════════════════════════
		// 5. archive prompt: decide the working copy's fate before hiding
		// ════════════════════════════════════════════════════════════════════
		function useArchivePromptVersion() {
			var pair = React.useState(0);
			var setVersion = pair[1];
			React.useEffect(function () {
				return archivePrompt.subscribe(function () {
					setVersion(function (value) {
						return value + 1;
					});
				});
			}, []);
			return pair[0];
		}

		function ArchiveWorktreePrompt(props) {
			var services = props.services;
			useArchivePromptVersion();
			var pair = React.useState({ busy: null, error: null });
			var state = pair[0];
			var setState = pair[1];
			var pending = archivePrompt.pending;
			if (pending === null) return null;
			var entry = statusStore.entryFor(pending.sessionId) || {};
			var dirty = typeof entry.dirty === "number" ? entry.dirty : 0;
			var unpushed = typeof entry.aheadUpstream === "number" ? entry.aheadUpstream : (entry.aheadBase || 0);

			var close = function () {
				if (state.busy !== null) return;
				setState({ busy: null, error: null });
				archivePrompt.close();
			};
			var archiveOnly = function () {
				var request = pending;
				setState({ busy: null, error: null });
				archivePrompt.close();
				void request.proceed(request.sessionId);
			};
			// Closing without choosing settles the intercepted archive call so the
			// caller's promise chain does not hang.
			var settleOnClose = function () {
				var request = pending;
				archivePrompt.close();
				if (request !== null) void request.proceed;
			};
			var removeThenArchive = async function () {
				var request = pending;
				setState({ busy: "remove", error: null });
				try {
					var result = await rpc("remove", { sessionId: request.sessionId });
					if (!result || result.ok !== true) {
						throw new Error((result && result.error && result.error.message) || "the worktree could not be removed");
					}
					// The Host retires the dead Workspace registration with the copy.
					await statusStore.refresh(true);
					setState({ busy: null, error: null });
					archivePrompt.close();
					await request.proceed(request.sessionId);
				} catch (error) {
					setState({ busy: null, error: String((error && error.message) || error) });
				}
			};

			return jsxRuntime.jsx(primitives.Modal, {
				open: true,
				onClose: close,
				title: "Remove this session's worktree?",
				closeLabel: "Cancel",
				description: "This session works in a git worktree. Archiving it hides the session; the working copy on disk is a separate decision.",
				children: jsxRuntime.jsxs("div", {
					className: "bgw-panel",
					style: { padding: 0, height: "auto", gap: "6px" },
					children: [
						jsxRuntime.jsxs("div", { children: [jsxRuntime.jsx("strong", { children: "Worktree: " }), entry.managedRoot || "(unknown)"] }),
						entry.branch ? jsxRuntime.jsxs("div", { children: [jsxRuntime.jsx("strong", { children: "Branch: " }), entry.branch] }) : null,
						dirty > 0
							? jsxRuntime.jsxs("div", { className: "bgw-warn", children: [String(dirty), " uncommitted path(s) will be lost with it."] })
							: jsxRuntime.jsx("div", { className: "bgw-note", children: "The working copy is clean." }),
						unpushed > 0
							? jsxRuntime.jsxs("div", { className: "bgw-warn", children: [String(unpushed), " commit(s) are not pushed anywhere; removing the copy discards them."] })
							: null,
						state.error !== null ? jsxRuntime.jsx("div", { className: "bgw-menu-error", children: state.error }) : null,
					],
				}),
				footer: jsxRuntime.jsxs("span", {
					className: "bgw-modal-actions",
					children: [
						jsxRuntime.jsx(primitives.Button, { variant: "ghost", disabled: state.busy !== null, onClick: close, children: "Cancel" }),
						jsxRuntime.jsx(primitives.Button, { variant: "outline", disabled: state.busy !== null, onClick: archiveOnly, children: "Keep" }),
						jsxRuntime.jsx(primitives.Button, {
							variant: "primary",
							disabled: state.busy !== null,
							onClick: function () {
								void removeThenArchive();
							},
							children: state.busy === "remove" ? "Removing…" : "Remove",
						}),
					],
				}),
			});
		}

		// ════════════════════════════════════════════════════════════════════
		// 6. shared client plumbing
		// ════════════════════════════════════════════════════════════════════
		/**
		 * Service handles for this plugin.
		 *
		 * Resolved lazily and cached on first success: `uiWorkspace` is provided
		 * by this plugin's own apply (so it does not exist yet when apply starts)
		 * and the conversation service belongs to a sibling subtree, which is why
		 * it is reached through a session scope below rather than from here.
		 */
		function servicesOf(ctx) {
			const found = {};
			const read = (name) => {
				if (found[name] === undefined) {
					const value = typeof ctx.get === "function" ? ctx.get(name) : undefined;
					if (value !== undefined) found[name] = value;
				}
				return found[name];
			};
			return {
				get locale() { return read("locale"); },
				get workspaces() { return read("workspaces"); },
				get sessions() { return read("sessions"); },
				get conversation() { return read("conversation"); },
				get uiWorkspace() { return read("uiWorkspace"); },
				get betterSidebar() { return read("betterSidebar"); },
			};
		}

		/** The conversation input facade for one session, reached the way the harness itself reaches it. */
		function inputFacadeFor(services, sessionId, binding) {
			const agentCtx = binding !== undefined && binding.ctx !== undefined
				? binding.ctx
				: services.sessions !== undefined && typeof services.sessions.scope === "function"
					? services.sessions.scope(sessionId)
					: undefined;
			if (agentCtx === undefined) return undefined;
			const conversation = typeof agentCtx.get === "function" ? agentCtx.get("conversation") : undefined;
			const facade = conversation !== undefined ? conversation : services.conversation;
			if (facade === undefined || facade.input === undefined) return undefined;
			try {
				return facade.input.for(agentCtx);
			} catch (error) {
				console.warn("[better-git-worktree] could not reach the target composer", error);
				return undefined;
			}
		}

		function navigateToSession(services, sessionId) {
			if (services.uiWorkspace && typeof services.uiWorkspace.openSession === "function") {
				services.uiWorkspace.openSession(sessionId);
				return;
			}
			if (services.sessions && typeof services.sessions.open === "function") {
				services.sessions.open(sessionId);
				return;
			}
			throw new Error("this harness build exposes no session navigation surface");
		}

		function bindingFor(services, sessionId) {
			return services.sessions && typeof services.sessions.binding === "function"
				? services.sessions.binding(sessionId)
				: undefined;
		}

		function readDraft(input) {
			if (input === undefined || input === null) return { draft: "", attachmentIds: [], phase: "plain" };
			return {
				draft: typeof input.draft === "string" ? input.draft : "",
				attachmentIds: input.attachmentIds || input.imageIds || [],
				phase: typeof input.phase === "string" ? input.phase : "plain",
			};
		}

		function inputActionsOf(inputActions) {
			var actions = inputActions || {};
			var addAttachments = actions.addAttachments || actions.addImages;
			var removeAttachment = actions.removeAttachment || actions.removeImage;
			return {
				setDraft: function (text) {
					if (typeof actions.setDraft === "function") actions.setDraft(text);
				},
				addAttachments: function (ids) {
					return typeof addAttachments === "function" ? addAttachments.call(actions, ids) === true : false;
				},
				removeAttachment: function (id) {
					if (typeof removeAttachment === "function") removeAttachment.call(actions, id);
				},
			};
		}

		function openSidebarTab(services, seed, sessionId) {
			var sidebar = services.betterSidebar;
			if (sidebar === undefined || typeof sidebar.openTab !== "function") return false;
			try {
				sidebar.openTab(seed, { sessionId: sessionId });
				return true;
			} catch (error) {
				console.warn("[better-git-worktree] could not open the sidebar tab", error);
				return false;
			}
		}

		/**
		 * Create the Worktree-rooted Session for a prepared worktree and hand the
		 * current draft over to it. Mirrors the harness's own new-session flow:
		 * register the managed root as a Workspace, create the Session there, move
		 * the draft, navigate, then retire the blank source Session.
		 */
		async function activateWorktreeSession(services, options) {
			var managedRoot = options.managedRoot;
			var targetSessionId = options.targetSessionId;
			var draft = options.draft;
			var workspace = await services.workspaces.create({ path: managedRoot });
			if (workspace.path !== managedRoot) {
				throw new Error("the harness registered the worktree at " + workspace.path + " instead of " + managedRoot);
			}
			var created = await services.sessions.create({ workspaceId: workspace.workspaceId, sessionId: targetSessionId });
			if (created !== targetSessionId) {
				throw new Error("the harness created session " + created + " instead of " + targetSessionId);
			}
			var handoff = function (binding) {
				const facade = inputFacadeFor(services, targetSessionId, binding);
				if (facade === undefined) {
					// Nothing was moved: leave the original draft exactly where it
					// is rather than clearing the prompt the user just wrote.
					throw new Error(
						"the session was created, but its composer could not be reached, so the draft stayed in the original session",
					);
				}
				var targetInput = inputActionsOf(facade);
				targetInput.setDraft(draft.draft);
				if (draft.attachmentIds.length > 0) targetInput.addAttachments(draft.attachmentIds);
				navigateToSession(services, targetSessionId);
				if (options.clearSourceInput !== undefined) {
					// Only now that the target holds the draft.
					options.clearSourceInput.setDraft("");
					for (var id of draft.attachmentIds) options.clearSourceInput.removeAttachment(id);
				}
			};
			if (services.sessions !== undefined && typeof services.sessions.using === "function") {
				await services.sessions.using(targetSessionId, { source: "controllerOperation" }, function (reference) {
					handoff(reference.binding);
				});
			} else {
				handoff(bindingFor(services, targetSessionId));
			}
			if (options.archiveSourceSessionId !== undefined && services.workspaces !== undefined
				&& typeof services.workspaces.archiveSession === "function") {
				try {
					await services.workspaces.archiveSession(options.archiveSourceSessionId);
				} catch (error) {
					/* the target handoff already owns the draft; archiving is cosmetic */
				}
			}
			// The registry record is keyed by the session it was created for —
			// which is the target only in the pre-session flow; a converted
			// session keeps its own id as the key.
			void rpc("activate", { sessionId: options.recordSessionId || targetSessionId });
			return { workspaceId: workspace.workspaceId, sessionId: targetSessionId };
		}

		function newSessionId() {
			var uuid =
				typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
					? crypto.randomUUID()
					: String(Date.now()) + "-" + Math.random().toString(16).slice(2);
			return "session-" + uuid;
		}

		// ════════════════════════════════════════════════════════════════════
		// 6. composer Worktree switch (blank sessions)
		// ════════════════════════════════════════════════════════════════════
		function WorktreeSwitch(props) {
			var services = props.services;
			var sessionId = props.sessionId;
			useStatusVersion();
			var session = props.useSession(function (state) {
				return state;
			});
			var hasActiveTarget = props.useConversation(function (state) {
				return state.activeTargets !== undefined && state.activeTargets.size > 0;
			});
			var input = readDraft(props.useInput(function (state) {
				return state;
			}));
			var pair = React.useState({ open: false, busy: false, error: null });
			var state = pair[0];
			var setState = pair[1];

			var blank =
				session !== undefined &&
				!hasActiveTarget &&
				(!session.blank && !session.awaitingFirstTurn ? false : session.running !== true && session.promptAttempted !== true);
			// Once the session lives in a worktree the switch is a statement of
			// fact, not an action: it reads ON and refuses input.
			var entry = statusStore.entryFor(sessionId);
			var inWorktree = entry !== undefined && entry.missing !== true;

			if (session === undefined || !blank) return null;

			var open = function () {
				setState({ open: true, busy: false, error: null });
			};
			var close = function () {
				setState({ open: false, busy: false, error: null });
			};
			var confirm = async function () {
				setState({ open: true, busy: true, error: null });
				var targetSessionId = newSessionId();
				try {
					var prepared = await rpc("prepare", { sourceSessionId: sessionId, targetSessionId: targetSessionId });
					if (!prepared || prepared.ok !== true) {
						throw new Error((prepared && prepared.error && prepared.error.message) || "the worktree could not be created");
					}
					var worktree = prepared.value.worktree;
					await activateWorktreeSession(services, {
						managedRoot: worktree.managedRoot,
						targetSessionId: targetSessionId,
						draft: input,
						clearSourceInput: inputActionsOf(props.inputActions),
						archiveSourceSessionId: sessionId,
					});
					void statusStore.refresh(true);
					setState({ open: false, busy: false, error: null });
				} catch (error) {
					setState({ open: true, busy: false, error: String((error && error.message) || error) });
				}
			};

			return jsxRuntime.jsxs("span", {
				className: "bgw-presession",
				children: [
					jsxRuntime.jsx(primitives.Switch, {
						checked: inWorktree,
						disabled: inWorktree || state.busy,
						label: "Worktree",
						title: inWorktree
							? "This session works in a git worktree" + (entry && entry.managedRoot ? ": " + entry.managedRoot : "")
							: "Start this session in a new git worktree",
						onChange: open,
					}),
					jsxRuntime.jsx("span", { className: "bgw-presession-label", children: "Worktree" }),
					jsxRuntime.jsx(primitives.Modal, {
						open: state.open,
						onClose: close,
						title: "Start in a git worktree",
						closeLabel: "Cancel",
						description:
							"A new branch and worktree are created for this repository, and this session continues there permanently. The original checkout is left untouched.",
						children: state.error !== null
							? jsxRuntime.jsx("p", { className: "bgw-menu-error", children: state.error })
							: jsxRuntime.jsx("p", {
									className: "bgw-note",
									children:
										input.draft.trim() === "" && input.attachmentIds.length === 0
											? "Your draft moves to the worktree session."
											: "The current draft and attachments move to the worktree session.",
								}),
						footer: jsxRuntime.jsxs("span", {
							className: "bgw-modal-actions",
							children: [
								jsxRuntime.jsx(primitives.Button, { variant: "outline", disabled: state.busy, onClick: close, children: "Cancel" }),
								jsxRuntime.jsx(primitives.Button, {
									variant: "primary",
									disabled: state.busy,
									onClick: function () {
										void confirm();
									},
									children: state.busy ? "Creating…" : "Create worktree and switch",
								}),
							],
						}),
					}),
				],
			});
		}

		// ════════════════════════════════════════════════════════════════════
		// 7. branch-vs-default-build review panel
		// ════════════════════════════════════════════════════════════════════
		function BranchReviewPanel(props) {
			var sessionId = props.sessionId;
			var pair = React.useState({ loading: true, data: null, error: null });
			var state = pair[0];
			var setState = pair[1];
			var revisionPair = React.useState(0);
			var revision = revisionPair[0];
			var setRevision = revisionPair[1];
			React.useEffect(function () {
				var alive = true;
				setState(function (current) { return Object.assign({}, current, { loading: true, error: null }); });
				rpc("branchReview", { sessionId: sessionId })
					.then(function (result) {
						if (!alive) return;
						if (result && result.ok === true) setState({ loading: false, data: result.value, error: null });
						else setState({ loading: false, data: null, error: (result && result.error && result.error.message) || "review failed" });
					})
					.catch(function (error) {
						if (alive) setState({ loading: false, data: null, error: String((error && error.message) || error) });
					});
				return function () {
					alive = false;
				};
			}, [sessionId, revision]);

			var head = jsxRuntime.jsxs("div", {
				className: "bgw-panel-head",
				children: [
					jsxRuntime.jsx("h4", { children: "Branch review" }),
					jsxRuntime.jsx(primitives.Button, {
						variant: "ghost",
						size: "sm",
						icon: jsxRuntime.jsx(primitives.IconRefreshOutline16, {}),
						disabled: state.loading,
						onClick: function () {
							setRevision(function (value) { return value + 1; });
						},
						children: state.loading ? "Refreshing…" : "Refresh",
					}),
				],
			});

			if (state.loading && state.data === null) {
				return jsxRuntime.jsxs("div", { className: "bgw-panel", children: [head, "Loading branch comparison…"] });
			}
			if (state.error !== null) {
				return jsxRuntime.jsxs("div", {
					className: "bgw-panel",
					children: [head, jsxRuntime.jsx("div", { className: "bgw-menu-error", children: state.error })],
				});
			}
			var data = state.data || {};
			var review = data.review || {};
			var status = data.status || {};
			var behind = status.behindBase || 0;
			return jsxRuntime.jsxs("div", {
				className: "bgw-panel",
				children: [
					head,
					jsxRuntime.jsxs("div", {
						children: [
							jsxRuntime.jsxs("h4", { children: ["Comparing against ", review.baseRef || "the default branch"] }),
							jsxRuntime.jsxs("div", {
								className: "bgw-note",
								children: [
									"Branch ",
									status.branch || "(detached)",
									" · ",
									String(status.aheadBase === undefined ? 0 : status.aheadBase),
									" commit(s) ahead · ",
									String(behind),
									" behind",
								],
							}),
						],
					}),
					behind > 0
						? jsxRuntime.jsxs("div", {
								className: "bgw-warn",
								children: [
									"Needs rebasing: ",
									review.baseRef || "the default branch",
									" has ",
									String(behind),
									" commit(s) this branch does not have.",
								],
							})
						: jsxRuntime.jsx("div", { className: "bgw-note", children: review.note || "" }),
					jsxRuntime.jsx("h4", { children: "Commits on this branch" }),
					(review.commits || []).length === 0
						? jsxRuntime.jsx("div", { className: "bgw-note", children: "No commits beyond the merge base." })
						: jsxRuntime.jsx("div", {
								children: (review.commits || []).map(function (commit) {
									return jsxRuntime.jsxs(
										"div",
										{ className: "bgw-row", children: [jsxRuntime.jsx("span", { className: "bgw-code", children: commit.oid }), jsxRuntime.jsx("span", { children: commit.subject })] },
										commit.oid,
									);
								}),
							}),
					jsxRuntime.jsx("h4", { children: "Changed files" }),
					(review.files || []).length === 0
						? jsxRuntime.jsx("div", { className: "bgw-note", children: "No file changes against the merge base." })
						: jsxRuntime.jsx("div", {
								children: (review.files || []).map(function (file) {
									return jsxRuntime.jsxs(
										"div",
										{ className: "bgw-row", children: [jsxRuntime.jsx("span", { className: "bgw-code", children: file.status }), jsxRuntime.jsx("span", { children: file.path })] },
										file.status + ":" + file.path,
									);
								}),
							}),
					jsxRuntime.jsx("h4", { children: "Diffstat" }),
					jsxRuntime.jsx("pre", { children: review.diffstat || "(empty)" }),
				],
			});
		}

		// ════════════════════════════════════════════════════════════════════
		// 8. session-header Worktree menu
		// ════════════════════════════════════════════════════════════════════
		function WorktreeActionsMenu(props) {
			var services = props.services;
			var sessionId = props.sessionId;
			useStatusVersion();
			// The pill describes whichever checkout this session runs in; the
			// status store is asked for that session's status on every refresh.
			React.useEffect(function () {
				statusStore.track(sessionId);
			}, [sessionId]);
			var pair = React.useState({ open: false, busy: null, error: null, notice: null, reviewOpen: false });
			var state = pair[0];
			var setState = pair[1];
			var entry = statusStore.entryFor(sessionId);
			var isWorktree = entry !== undefined && typeof entry.managedRoot === "string";
			var stateName = entry !== undefined && typeof entry.state === "string" ? entry.state : "unknown";
			var name = checkoutName(entry);
			var title = (name === undefined ? "No repository" : name) + " - " + stateLabel(stateName);
			var decoration = entry === undefined ? undefined : decorationOf(entry);

			var patch = function (fields) {
				setState(function (current) {
					return Object.assign({}, current, fields);
				});
			};

			var run = async function (id, task) {
				patch({ busy: id, error: null, notice: null });
				try {
					await task();
					await statusStore.refresh(true);
					patch({ busy: null, error: null });
				} catch (error) {
					patch({ busy: null, error: String((error && error.message) || error) });
				}
			};

			var gitChanges = function () {
				patch({ open: false });
				if (!openSidebarTab(services, { type: "git" }, sessionId)) {
					patch({ reviewOpen: true, error: null });
				}
			};

			var branchReview = function () {
				patch({ open: false });
				if (!openSidebarTab(services, { type: "git-worktree-review", title: "Branch review" }, sessionId)) {
					patch({ reviewOpen: true, error: null });
				}
			};

			var convertNow = function () {
				void run("convert", async function () {
					var result = await rpc("convert", { sessionId: sessionId });
					if (!result || result.ok !== true) {
						throw new Error((result && result.error && result.error.message) || "the conversion failed");
					}
					await activateWorktreeSession(services, {
						managedRoot: result.value.worktree.managedRoot,
						targetSessionId: result.value.targetSessionId,
						draft: { draft: "", attachmentIds: [] },
						archiveSourceSessionId: result.value.conversationCarried ? sessionId : undefined,
					});
					void statusStore.refresh(true);
				});
			};

			var items = [];
			items.push({
				id: "summary",
				disabled: true,
				label: jsxRuntime.jsxs("span", {
					className: "bgw-menu-summary",
					children: [
						jsxRuntime.jsx("strong", { children: title }),
						entry === undefined
							? jsxRuntime.jsx("span", { children: "No git checkout is attached to this session yet." })
							: jsxRuntime.jsx("span", { children: entry.path || entry.managedRoot || "" }),
						entry !== undefined && entry.branch !== undefined
							? jsxRuntime.jsxs("span", { children: ["Branch ", entry.branch, entry.baseRef ? " vs " + entry.baseRef : ""] })
							: null,
						state.notice !== null ? jsxRuntime.jsx("span", { className: "bgw-menu-notice", children: state.notice }) : null,
						state.error !== null ? jsxRuntime.jsx("span", { className: "bgw-menu-error", children: state.error }) : null,
					],
				}),
			});
			items.push({ type: "separator", id: "summary-separator" });
			items.push({ id: "changes", label: "Git Changes", icon: jsxRuntime.jsx(primitives.IconSearchOutline16, {}) });
			items.push({
				id: "branch",
				label: entry !== undefined && entry.baseRef !== undefined ? "Review branch vs " + entry.baseRef : "Review branch vs origin",
				icon: jsxRuntime.jsx(primitives.IconBranchOutline16, {}),
			});
			items.push({
				id: "fetch",
				label: state.busy === "fetch" ? "Running git fetch…" : "git fetch",
				icon: jsxRuntime.jsx(primitives.IconRefreshOutline16, {}),
				disabled: state.busy !== null,
			});
			if (isWorktree) {
				items.push({
					id: "copyPath",
					label: "Copy worktree path",
					icon: jsxRuntime.jsx(primitives.IconCopyOutline16, {}),
					disabled: state.busy !== null,
				});
				items.push({
					id: "open",
					label: "Open worktree folder",
					icon: jsxRuntime.jsx(primitives.IconFolderOpenOutline16, {}),
					disabled: state.busy !== null,
				});
			} else {
				items.push({
					id: "convert",
					label: state.busy === "convert" ? "Moving into a worktree…" : "Move this session into a worktree",
					icon: jsxRuntime.jsx(primitives.IconBranchOutline16, {}),
					disabled: state.busy !== null,
				});
			}

			return jsxRuntime.jsxs(React.Fragment, {
				children: [
					jsxRuntime.jsx(primitives.Menu, {
						open: state.open,
						align: "end",
						portal: true,
						compact: true,
						items: items,
						onClose: function () {
							patch({ open: false });
						},
						onSelect: function (id) {
							if (id === "changes") gitChanges();
							if (id === "branch") branchReview();
							if (id === "fetch") void run("fetch", async function () { await rpc("fetch", { sessionId: sessionId }); });
							if (id === "copyPath") {
								patch({ open: false, notice: null, error: null });
								var target = entry !== undefined ? entry.managedRoot : undefined;
								if (typeof target === "string" && typeof navigator !== "undefined" && navigator.clipboard !== undefined) {
									navigator.clipboard.writeText(target).then(
										function () { patch({ notice: "Path copied" }); },
										function (error) { patch({ error: "Could not copy the path: " + String((error && error.message) || error) }); },
									);
								} else {
									patch({ error: "Clipboard access is unavailable here." });
								}
							}
							if (id === "open") {
								void run("open", async function () {
									var result = await rpc("open", { sessionId: sessionId });
									if (!result || result.ok !== true) {
										throw new Error((result && result.error && result.error.message) || "the folder could not be opened");
									}
								});
							}
							if (id === "convert") {
								patch({ open: false });
								convertNow();
							}
						},
						anchor: React.createElement(primitives.Button, {
							variant: "toolbar",
							size: "sm",
							className: "bgw-header-action",
							icon: jsxRuntime.jsx(primitives.IconBranchOutline16, {}),
							"data-bgw-state": stateName,
							"aria-haspopup": "menu",
							"aria-expanded": state.open,
							"aria-label": "Checkout actions: " + title,
							title: decoration !== undefined ? decoration.tooltip : "Git actions for this session's checkout",
							onClick: function () {
								patch({ open: !state.open });
							},
						},
							jsxRuntime.jsx("span", { className: "bgw-pill-name", children: title }),
							jsxRuntime.jsx(primitives.IconChevronDownOutline14, {})),
					}),
					jsxRuntime.jsx(primitives.Modal, {
						open: state.reviewOpen,
						onClose: function () {
							patch({ reviewOpen: false });
						},
						title: "Branch review",
						closeLabel: "Close",
						children: jsxRuntime.jsx(BranchReviewPanel, { sessionId: sessionId }),
					}),
				],
			});
		}

		// ════════════════════════════════════════════════════════════════════
		// 9. activation of Host-created worktree sessions
		// ════════════════════════════════════════════════════════════════════
		/**
		 * The `worktree_convert` tool creates the worktree AND the continuation
		 * session Host-side (only the Host can seed a session). Opening it is a
		 * client action, so the store performs the activation exactly once per
		 * record and then marks it done.
		 */
		function activationWatcher(ctx) {
			var services = servicesOf(ctx);
			var inFlight = new Set();
			return statusStore.subscribe(function () {
				for (var entry of statusStore.get().entries) {
					if (entry === undefined || entry.activated !== false) continue;
					if (typeof entry.targetSessionId !== "string" || typeof entry.managedRoot !== "string") continue;
					if (inFlight.has(entry.targetSessionId)) continue;
					inFlight.add(entry.targetSessionId);
					activateWorktreeSession(services, {
						managedRoot: entry.managedRoot,
						targetSessionId: entry.targetSessionId,
						recordSessionId: entry.sessionId,
						draft: { draft: "", attachmentIds: [] },
						archiveSourceSessionId: entry.conversationCarried === true ? entry.sessionId : undefined,
					})
						.then(function () {
							void statusStore.refresh(true);
						})
						.catch(function (error) {
							console.warn("[better-git-worktree] could not open the worktree session", error && error.message ? error.message : error);
							inFlight.delete(entry.targetSessionId);
						});
				}
			});
		}

		// ════════════════════════════════════════════════════════════════════
		// 10. plugin face
		// ════════════════════════════════════════════════════════════════════
		exports.inject = officialInject;

		exports.apply = function apply(ctx) {
			var services = servicesOf(ctx);
			ctx.effect(function () { return installStyles(); }, "dsh-better-git-worktree: styles");

			// The official Workspace Browser, decorated. This must run before the
			// surfaces below so the sidebar exists for them to sit beside.
			mountDecoratedWorkspaceBrowser(ctx);

			void statusStore.refresh(true);
			var pollTimer = setInterval(function () {
				void statusStore.refresh(true);
			}, 10000);
			ctx.effect(function () {
				return function () {
					clearInterval(pollTimer);
				};
			}, "dsh-better-git-worktree: status polling");
			ctx.effect(function () { return activationWatcher(ctx); }, "dsh-better-git-worktree: activation watcher");

			ctx.slots.inject("conversation.input.left", function () {
				return ctx.slots.register(
					{ name: "conversation.input.left", id: "better-git-worktree-switch", order: 40 },
					function WorktreeSwitchSlot(props) {
						return React.createElement(WorktreeSwitch, Object.assign({}, props, { services: services }));
					},
				);
			});

			ctx.slots.inject("shell.overlay", function () {
				return ctx.slots.register(
					{ name: "shell.overlay", id: "better-git-worktree-archive-prompt", order: 5 },
					function ArchivePromptSlot(props) {
						return React.createElement(ArchiveWorktreePrompt, Object.assign({}, props, { services: services }));
					},
				);
			});

			ctx.slots.inject("conversation.session.header.actions", function () {
				return ctx.slots.register(
					{ name: "conversation.session.header.actions", id: "better-git-worktree-actions", order: 30 },
					function WorktreeActionsSlot(props) {
						return React.createElement(WorktreeActionsMenu, Object.assign({}, props, { services: services }));
					},
				);
			});

			// Optional: a real sidebar panel via dsh-better-sidebar. Without it the
			// same content renders in the menu's modal instead.
			var sidebar = services.betterSidebar;
			if (sidebar !== undefined && typeof sidebar.registerTab === "function") {
				try {
					var disposeTab = sidebar.registerTab({
						id: "git-worktree-review",
						title: "Worktree branch",
						description: "Commits and files on this worktree branch compared with the default branch on origin",
						icon: jsxRuntime.jsx(primitives.IconBranchOutline16, {}),
						order: 45,
						single: true,
						component: function WorktreeReviewTab(props) {
							var sessionId = props.scope && props.scope.sessionId;
							if (typeof sessionId !== "string") return null;
							return React.createElement(BranchReviewPanel, { sessionId: sessionId });
						},
					});
					if (typeof disposeTab === "function") ctx.effect(function () { return disposeTab; }, "dsh-better-git-worktree: sidebar tab");
				} catch (error) {
					console.warn("[better-git-worktree] could not register the sidebar tab", error);
				}
			}
		};

		return module.exports;
	},
});
