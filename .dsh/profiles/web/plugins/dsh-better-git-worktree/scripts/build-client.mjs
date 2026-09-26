// Generate client.js: the plugin's browser bundle, with the official Workspace
// client inlined and decorated.
//
// Why inlining: the sidebar browsing region is a `single` slot, and the child
// slot it declares (`sidebar.workspaces.directoryFlow`) can only be rendered by
// the entry that declared it. A wrapper entry therefore cannot sit beside the
// official one — it has to *be* it. That is the same conclusion dsh-git-worktree
// reaches; this script only avoids their build-time virtual-module machinery by
// generating a plain, dependency-free bundle here.
//
// The seams below are exact-string patches against
// @deepseek-ai/dsh-client-ui-workspace's shipped client. They fail closed: a
// version whose generated shape drifted produces an error naming the seam, not a
// silently undecorated sidebar.
//
// Usage: node scripts/build-client.mjs [--check]

import { createHash } from 'node:crypto';
import { Script } from 'node:vm';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = join(here, '..');
const require = createRequire(import.meta.url);

const SUPPORTED_VERSIONS = ['0.1.5-rc.2', '0.1.2-rc.1'];

function replaceExactlyOnce(source, needle, replacement, label) {
  const first = source.indexOf(needle);
  if (first < 0) throw new Error(`seam "${label}" not found: the official Workspace client changed shape`);
  if (source.indexOf(needle, first + 1) !== -1) throw new Error(`seam "${label}" is not unique`);
  return source.slice(0, first) + replacement + source.slice(first + needle.length);
}

const HELPERS = `		function betterGitWorktreeDecoration(node) {
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
				"aria-label": \`Worktree \${decoration.label}\${decoration.needsRebase === true ? ", needs rebasing" : ""}\`,
				children: [(0, react_jsx_runtime.jsx)("span", {
					className: "bgw-icon",
					"aria-hidden": "true",
					children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconBranchOutline16, {})
				}), (0, react_jsx_runtime.jsx)("span", { children: decoration.label })]
			});
		}
`;

/**
 * Thread `__betterGitWorktree` from the projected Session summaries into the rows
 * the official Browser renders, and render the badge in the session row, the
 * search result row, and the hover card.
 */
export function decorateOfficialWorkspaceClient(source) {
  let derived = source;
  derived = replaceExactlyOnce(
    derived,
    '\t\t\t\tupdatedAt: s.updatedAt,\n\t\t\t\t...pendingInteraction === void 0 ? {} : { pendingInteraction }',
    '\t\t\t\tupdatedAt: s.updatedAt,\n\t\t\t\t...s.__betterGitWorktree === void 0 ? {} : { __betterGitWorktree: s.__betterGitWorktree },\n\t\t\t\t...pendingInteraction === void 0 ? {} : { pendingInteraction }',
    'session node projection',
  );
  derived = replaceExactlyOnce(
    derived,
    '\t\t\t\t\t\trunningSubagentCount: descendants.get(summary.id)?.runningCount ?? 0,\n\t\t\t\t\t\t...pendingInteraction === void 0 ? {} : { pendingInteraction },',
    '\t\t\t\t\t\trunningSubagentCount: descendants.get(summary.id)?.runningCount ?? 0,\n\t\t\t\t\t\t...summary.__betterGitWorktree === void 0 ? {} : { __betterGitWorktree: summary.__betterGitWorktree },\n\t\t\t\t\t\t...pendingInteraction === void 0 ? {} : { pendingInteraction },',
    'search result projection',
  );
  derived = replaceExactlyOnce(
    derived,
    '\t\t/** Hover-card body: full title, relative time, and every relevant live status. */\n\t\tfunction SessionHoverContent',
    `${HELPERS}\t\t/** Hover-card body: full title, relative time, and every relevant live status. */\n\t\tfunction SessionHoverContent`,
    'decoration helpers',
  );
  derived = replaceExactlyOnce(
    derived,
    '\t\t\tconst statuses = sessionStatuses(node, t);\n\t\t\treturn (0, react_jsx_runtime.jsxs)("div", {\n\t\t\t\tclassName: Rows_module_css_default.hoverContent,',
    '\t\t\tconst statuses = sessionStatuses(node, t);\n\t\t\tconst bgwHover = betterGitWorktreeDecoration(node);\n\t\t\treturn (0, react_jsx_runtime.jsxs)("div", {\n\t\t\t\tclassName: Rows_module_css_default.hoverContent,',
    'hover content',
  );
  derived = replaceExactlyOnce(
    derived,
    '\t\t\t\t\t\tchildren: displayTitle(node, t)\n\t\t\t\t\t}),\n\t\t\t\t\t!node.blank',
    '\t\t\t\t\t\tchildren: displayTitle(node, t)\n\t\t\t\t\t}),\n\t\t\t\t\tbgwHover !== void 0 && (0, react_jsx_runtime.jsxs)("div", {\n\t\t\t\t\t\tclassName: Rows_module_css_default.hoverStatus,\n\t\t\t\t\t\tchildren: [(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconBranchOutline16, {}), (0, react_jsx_runtime.jsx)("span", { children: bgwHover.tooltip })]\n\t\t\t\t\t}),\n\t\t\t\t\t!node.blank',
    'hover status line',
  );
  derived = replaceExactlyOnce(
    derived,
    '\t\t\tconst showStatus = statuses[0].state !== "done" || row.completed;\n\t\t\tconst [menuOpen, setMenuOpen]',
    '\t\t\tconst showStatus = statuses[0].state !== "done" || row.completed;\n\t\t\tconst bgwDecoration = betterGitWorktreeDecoration(row);\n\t\t\tconst [menuOpen, setMenuOpen]',
    'session row decoration',
  );
  derived = replaceExactlyOnce(
    derived,
    '\t\t\t\t\t\t(!flat || showStatus) && (0, react_jsx_runtime.jsx)("span", {\n\t\t\t\t\t\t\tclassName: Rows_module_css_default.slot,\n\t\t\t\t\t\t\tchildren: showStatus && (0, react_jsx_runtime.jsx)(SessionStatusDots, { statuses })\n\t\t\t\t\t\t}),',
    '\t\t\t\t\t\t(!flat || showStatus) && (0, react_jsx_runtime.jsx)("span", {\n\t\t\t\t\t\t\tclassName: Rows_module_css_default.slot,\n\t\t\t\t\t\t\tchildren: showStatus && (0, react_jsx_runtime.jsx)(SessionStatusDots, { statuses })\n\t\t\t\t\t\t}),\n\t\t\t\t\t\tbgwDecoration !== void 0 && (0, react_jsx_runtime.jsx)(BetterGitWorktreeIdentity, { decoration: bgwDecoration }),',
    'session row badge',
  );
  derived = replaceExactlyOnce(
    derived,
    '\t\t\tconst primaryStatus = statuses[0];\n\t\t\treturn (0, react_jsx_runtime.jsxs)("button", {\n\t\t\t\ttype: "button",\n\t\t\t\tclassName: clsx(Rows_module_css_default.searchResultRow, selected && Rows_module_css_default.selected),',
    '\t\t\tconst primaryStatus = statuses[0];\n\t\t\tconst bgwSearchDecoration = betterGitWorktreeDecoration(result);\n\t\t\treturn (0, react_jsx_runtime.jsxs)("button", {\n\t\t\t\ttype: "button",\n\t\t\t\tclassName: clsx(Rows_module_css_default.searchResultRow, selected && Rows_module_css_default.selected),',
    'search row decoration',
  );
  derived = replaceExactlyOnce(
    derived,
    '\t\t\t\t\t\tchildren: (primaryStatus.state !== "done" || result.completed) && (0, react_jsx_runtime.jsx)(SessionStatusDots, { statuses })\n\t\t\t\t\t\t}),\n\t\t\t\t\t\t(0, react_jsx_runtime.jsx)("span", {\n\t\t\t\t\t\t\tclassName: Rows_module_css_default.searchResultTitle,',
    '\t\t\t\t\t\tchildren: (primaryStatus.state !== "done" || result.completed) && (0, react_jsx_runtime.jsx)(SessionStatusDots, { statuses })\n\t\t\t\t\t\t}),\n\t\t\t\t\t\tbgwSearchDecoration !== void 0 && (0, react_jsx_runtime.jsx)(BetterGitWorktreeIdentity, { decoration: bgwSearchDecoration }),\n\t\t\t\t\t\t(0, react_jsx_runtime.jsx)("span", {\n\t\t\t\t\t\t\tclassName: Rows_module_css_default.searchResultTitle,',
    'search row badge',
  );
  return derived;
}

/** Extract the inner factory body of a `__ModuleLoader__.load({...})` bundle. */
export function extractFactoryBody(source) {
  const token = 'factory: (require) => {';
  const start = source.indexOf(token);
  if (start < 0) throw new Error('could not find the module factory in the official Workspace client');
  const end = source.lastIndexOf('\n\t}\n});');
  if (end < 0 || end <= start) throw new Error('could not find the end of the official Workspace client factory');
  return source.slice(start + token.length, end);
}

function main() {
  const check = process.argv.includes('--check');
  const packageJsonPath = require.resolve('@deepseek-ai/dsh-client-ui-workspace/package.json');
  const version = JSON.parse(readFileSync(packageJsonPath, 'utf8')).version;
  if (!SUPPORTED_VERSIONS.includes(version)) {
    throw new Error(
      `@deepseek-ai/dsh-client-ui-workspace ${version} is not a verified seam target (known: ${SUPPORTED_VERSIONS.join(', ')}). `
        + 'Review the new client bundle and update scripts/build-client.mjs before regenerating client.js.',
    );
  }
  const clientPath = require.resolve('@deepseek-ai/dsh-client-ui-workspace/client');
  const official = readFileSync(clientPath, 'utf8');
  const decorated = decorateOfficialWorkspaceClient(official);
  const body = extractFactoryBody(decorated);

  const template = readFileSync(join(pluginRoot, 'client.template.js'), 'utf8');
  const marker = '/*__OFFICIAL_WORKSPACE_BODY__*/';
  if (!template.includes(marker)) throw new Error(`client.template.js lost its ${marker} marker`);
  const output = template.replace(marker, body);
  if (output.includes(marker)) throw new Error('the official body placeholder was not replaced exactly once');

  // The bundle is served verbatim to the browser, so a syntax error is a blank
  // app rather than a build failure — parse it here instead.
  try {
    new Script(output, { filename: 'client.js' });
  } catch (error) {
    throw new Error(`the generated bundle does not parse: ${error instanceof Error ? error.message : String(error)}`);
  }

  const target = join(pluginRoot, 'client.js');
  const current = (() => {
    try {
      return readFileSync(target, 'utf8');
    } catch {
      return undefined;
    }
  })();
  const digest = createHash('sha256').update(output).digest('hex').slice(0, 12);
  if (check) {
    if (current !== output) throw new Error(`client.js is stale; regenerate it (expected content ${digest})`);
    console.log(`client.js is up to date (${digest})`);
    return;
  }
  if (current === output) {
    console.log(`client.js already current (${digest})`);
    return;
  }
  writeFileSync(target, output, 'utf8');
  console.log(
    `wrote client.js (${digest}) — official @deepseek-ai/dsh-client-ui-workspace@${version} inlined, ${output.length} bytes`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (error) {
    console.error(`build-client: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
