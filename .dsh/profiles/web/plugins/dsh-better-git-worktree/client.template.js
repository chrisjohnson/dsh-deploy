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
/*__OFFICIAL_WORKSPACE_BODY__*/
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
					for (var entry of state.entries) if (entry && entry.sessionId === sessionId) return entry;
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
									if (entry && typeof entry.sessionId === "string") {
										decorations[entry.sessionId] = decorationOf(entry);
									}
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
