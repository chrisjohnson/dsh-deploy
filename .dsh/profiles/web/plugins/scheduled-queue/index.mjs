// scheduled-queue: durable Host half of the composer's scheduled-send feature.
//
// Owns the central queue file at $DSH_HOME/storages/scheduled-queue.json, a
// 5-second scanner, and delivery of due items:
//
//   - forceSteer items   -> agent.steer(message)      (interrupts the current turn)
//   - ordinary items     -> agent.inbox.append('next-turn', message)
//
// The client half (client.mjs, mounted by the same row via this package's
// dsh.client declaration) reaches this Host through the same handler via two
// authenticated transports:
//
//   1. exact Fetch routes under the /api fence (the dsh-context idiom -
//      connection.fetch.register):
//        POST /api/scheduledQueue/<endpoint>
//      Serves authenticated shell probes (raw JSON body or the
//      client-request envelope) and returns 200 with the result.
//
//   2. the private /scheduledQueue connection channel
//      (connection.rpc.handle):
//        POST /scheduledQueue/<endpoint>
//      The URL the browser client posts to; it speaks the
//      client-request/server-response envelope.
//
// Queue items are { id, messageId, sessionId, text, minutes, forceSteer,
// dueAt, createdAt }. An item whose due time has passed but whose agent is
// gone (session not live) or whose delivery throws stays in the queue and is
// retried on the next scan. Delivery removes the item and persists.

import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

const CHANNEL = "/scheduledQueue";
const API_BASE = "/api/scheduledQueue";
const SCAN_INTERVAL_MS = 5000;
const ENDPOINTS = ["schedule", "list", "remove", "sendNow", "edit"];
const PLUGIN_NAME = "dsh-scheduled-queue";

// Shape mirrors the working local plugins in this profile
// (semantic-loop-kicker.mjs: default-exported object with `inject` +
// `apply(ctx, config)`). Cordis will not call apply until every injected
// service is available in this context.
export default {
	inject: ["agents", "fs", "timer", "connection"],
	apply(ctx, config = {}) {
		try {
			const log = ctx.logger(PLUGIN_NAME);
			// Inject is declared above, so a service still missing here is a
			// real misconfiguration: name it loudly and bail - never a silent
			// no-op.
			const services = {
				agents: ctx.get("agents"),
				fs: ctx.get("fs"),
				timer: ctx.get("timer"),
				connection: ctx.get("connection"),
			};
			const missing = Object.keys(services).filter((name) => !services[name]);
			if (missing.length > 0) {
				const msg =
					`[X] ${PLUGIN_NAME}: inject declared but still missing after bind: ` +
					`${missing.join(", ")} - profile composition misconfiguration, feature stays off`;
				console.error(msg);
				try {
					log.error(msg);
				} catch {}
				return;
			}
			const { agents, fs, timer, connection } = services;

			const HOME = (process.env.DSH_HOME || "").trim() || join(homedir(), ".dsh");
			const FILE = join(HOME, "storages", "scheduled-queue.json");
			const POLICY = { mode: "danger-full-access", workspaceRoot: HOME };

			let queue = [];
			let fileTarget = null;

			function load() {
				if (!fileTarget) return Promise.resolve(null);
				return fs
					.readText(fileTarget)
					.then((text) => {
						try {
							return JSON.parse(text);
						} catch {
							return [];
						}
					})
					.catch(() => null);
			}

			function persist() {
				if (!fileTarget) return Promise.resolve();
				return fs.writeText(fileTarget, JSON.stringify(queue, null, 2), undefined, undefined, POLICY).then(
					() => {},
					(err) => console.error(`[dsh-scheduled-queue] persist failed: ${err && err.message ? err.message : String(err)}`),
				);
			}

			function deliver(item) {
				const agent = agents.get(item.sessionId);
				if (!agent) return false;
				const message = {
					id: item.messageId,
					role: "user",
					content: [{ type: "text", text: item.text }],
					source: { kind: "user" },
				};
				try {
					if (item.forceSteer) {
						if (typeof agent.steer !== "function") return false;
						agent.steer(message);
						return true;
					}
					if (agent.inbox && typeof agent.inbox.append === "function") {
						agent.inbox.append("next-turn", message);
						return true;
					}
					return false;
				} catch (err) {
					console.error(`[dsh-scheduled-queue] deliver failed: ${err && err.message ? err.message : String(err)}`);
					return false;
				}
			}

			function scan() {
				const now = Date.now();
				const due = queue.filter((it) => it.dueAt <= now);
				if (!due.length) return;
				// Due + deliverable items are removed; due but undeliverable items stay.
				queue = queue.filter((it) => !(it.dueAt <= now && deliver(it)));
				persist();
			}

			const publicItem = (it) => ({
				id: it.id,
				sessionId: it.sessionId,
				text: it.text,
				minutes: it.minutes,
				forceSteer: it.forceSteer,
				dueAt: it.dueAt,
			});
			const fail = (code, message) => ({ ok: false, error: { code, message, details: {} } });

			// Shared endpoint handler: schedule | list | remove | sendNow | edit.
			// Returns the connection RPC result shape: { ok, value } on success
			// or { ok: false, error: { code, message, details } } on failure.
			const handler = async (endpoint, payload) => {
				try {
					const p = payload && typeof payload === "object" ? payload : {};
					switch (endpoint) {
						case "schedule": {
							const minutes = Math.max(1, Math.round(Number(p.minutes) || 1));
							const now = Date.now();
							const item = {
								id: randomUUID(),
								messageId: randomUUID(),
								sessionId: String(p.sessionId || ""),
								text: String(p.text || ""),
								minutes,
								forceSteer: !!p.forceSteer,
								dueAt: now + minutes * 60000,
								createdAt: now,
							};
							if (!item.sessionId || !item.text.trim()) {
								return fail("bad-request", "schedule needs a sessionId and non-empty message text");
							}
							queue.push(item);
							await persist();
							return { ok: true, value: { id: item.id, dueAt: item.dueAt, queue: queue.map(publicItem) } };
						}
						case "list":
							return { ok: true, value: { queue: queue.map(publicItem) } };
						case "remove": {
							const before = queue.length;
							queue = queue.filter((it) => it.id !== p.id);
							await persist();
							return { ok: true, value: { removed: queue.length < before, queue: queue.map(publicItem) } };
						}
						case "sendNow": {
							const item = queue.find((it) => it.id === p.id);
							if (!item) return fail("not-found", "no scheduled message with that id");
							queue = queue.filter((it) => it.id !== item.id);
							await persist();
							const delivered = deliver(item);
							return { ok: true, value: { delivered, queue: queue.map(publicItem) } };
						}
						case "edit": {
							const item = queue.find((it) => it.id === p.id);
							if (!item) return fail("not-found", "no scheduled message with that id");
							const minutes =
								p.minutes !== undefined ? Math.max(1, Math.round(Number(p.minutes) || item.minutes)) : item.minutes;
							item.text = p.text !== undefined ? String(p.text) : item.text;
							item.minutes = minutes;
							item.forceSteer = p.forceSteer !== undefined ? !!p.forceSteer : item.forceSteer;
							item.dueAt = Date.now() + minutes * 60000;
							await persist();
							return { ok: true, value: { queue: queue.map(publicItem) } };
						}
						default:
							return fail("unknown-endpoint", `unknown endpoint ${endpoint}`);
					}
				} catch (err) {
					return fail("internal", err && err.message ? err.message : String(err));
				}
			};

			// --- transport 1: exact Fetch routes under the /api fence.
			// Mirrors dsh-context (connection.fetch.register): the route is
			// consulted by the shared /api handler before the interceptor, so
			// an unauthenticated probe gets 401 (mounted) instead of 404.
			// Accepts a raw JSON payload or the client-request envelope the
			// browser client sends; for envelopes it answers with the matching
			// server-response envelope (same rpcId, result = handler output).
			const apiFetch = (endpoint) => async (request) => {
				let body;
				try {
					body = await request.json();
				} catch {
					body = {};
				}
				const envelope =
					body && typeof body === "object" && body.type === "client-request" && typeof body.rpcId === "string"
						? body
						: null;
				const result = await handler(endpoint, envelope ? envelope.payload : body);
				const response = envelope ? { type: "server-response", rpcId: envelope.rpcId, result } : result;
				return Response.json(response, { headers: { "cache-control": "no-store" } });
			};
			ctx.effect(
				() => {
					const disposes = [];
					for (const endpoint of ENDPOINTS) {
						try {
							disposes.push(
								connection.fetch.register({
									path: `${API_BASE}/${endpoint}`,
									methods: ["POST"],
									requestBody: "buffered",
									fetch: apiFetch(endpoint),
								}),
							);
						} catch (err) {
							const msg = `[X] ${PLUGIN_NAME}: fetch route ${API_BASE}/${endpoint} failed: ${err && err.message ? err.message : String(err)}`;
							console.error(msg);
							try {
								log.error(msg);
							} catch {}
						}
					}
					return () => {
						for (const dispose of disposes) {
							try {
								if (typeof dispose === "function") dispose();
							} catch {}
						}
					};
				},
				`${PLUGIN_NAME}: /api/scheduledQueue fetch routes`,
			);

			// --- transport 2: the private channel the browser client posts to
			// (client.mjs: connection.rpc.call("/scheduledQueue", endpoint, payload)).
			// rpc.handle returns the effect disposer; the outer effect RETURNS
			// it (never calls it at mount) so the route lives until this row
			// unmounts.
			try {
				const disposeChannel = connection.rpc.handle(CHANNEL, (endpoint, payload, signal) => handler(endpoint, payload));
				ctx.effect(
					() => (typeof disposeChannel === "function" ? disposeChannel : undefined),
					`${PLUGIN_NAME}: ${CHANNEL} channel`,
				);
			} catch (err) {
				const msg =
					`[X] ${PLUGIN_NAME}: rpc.handle(${CHANNEL}) threw - the browser-client channel is off, ` +
					`/api routes stay up: ${err && err.message ? err.message : String(err)}`;
				console.error(msg);
				try {
					log.error(msg);
				} catch {}
			}

			// --- 5-second delivery scanner; the effect RETURNS the interval's
			// disposer so the timer is cleared when the row unmounts.
			ctx.effect(
				() => {
					const stop = timer.interval(scan, SCAN_INTERVAL_MS);
					return () => {
						if (typeof stop === "function") stop();
					};
				},
				`${PLUGIN_NAME}: 5s delivery scan`,
			);

			// Positive proof-of-life line for the boot journal.
			const up =
				`[A] ${PLUGIN_NAME} applied: file=${FILE} scanner=${SCAN_INTERVAL_MS}ms ` +
				`transports=${API_BASE}+${CHANNEL} endpoints=${ENDPOINTS.join(",")}`;
			console.log(up);
			try {
				log.info(up);
			} catch {}

			// --- file init (queue survives restarts)
			fs.resolve(FILE)
				.then((t) => {
					fileTarget = t;
					return load();
				})
				.then((saved) => {
					if (Array.isArray(saved)) {
						queue = saved.filter((it) => it && typeof it === "object" && it.id && it.sessionId);
					}
					console.log(`[A] ${PLUGIN_NAME} queue file ready: ${FILE} (${queue.length} item(s) restored)`);
				})
				.catch((err) => {
					const msg = `[X] ${PLUGIN_NAME} file init failed, in-memory only: ${err && err.message ? err.message : String(err)}`;
					console.error(msg);
					try {
						log.error(msg);
					} catch {}
				});
		} catch (err) {
			const msg = `[X] ${PLUGIN_NAME} apply failed: ${err && err.stack ? err.stack : String(err)}`;
			console.error(msg);
			try {
				ctx.logger(PLUGIN_NAME).error(msg);
			} catch {}
		}
	},
};
