import * as vscode from 'vscode';
import { ACTIVE_KEY } from './prefabTree';

// Tracks open panels by source file so re-invoking the command on the same
// file reveals the existing tab instead of opening a duplicate.
const openPanels = new Map<string, vscode.WebviewPanel>();

function getNonce(): string {
	let text = '';
	const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	for (let i = 0; i < 32; i++) {
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return text;
}

export function showPrefabView(context: vscode.ExtensionContext, uri: vscode.Uri, fileName: string, data: unknown): void {
	const key = uri.toString();
	const existing = openPanels.get(key);
	if (existing) {
		existing.reveal(vscode.ViewColumn.Beside);
		return;
	}

	const panel = vscode.window.createWebviewPanel(
		'ccPrefabView',
		`Prefab: ${fileName}`,
		vscode.ViewColumn.Beside,
		{
			enableScripts: true,
			retainContextWhenHidden: true,
		}
	);

	openPanels.set(key, panel);
	panel.onDidDispose(() => openPanels.delete(key));

	panel.webview.html = getHtml(panel.webview, fileName, data);
}

function getHtml(webview: vscode.Webview, fileName: string, data: unknown): string {
	const nonce = getNonce();
	// Embed as a script-tag payload (not string-interpolated JS) and escape
	// "</script>" so malformed content in the prefab can't break out of it.
	const json = JSON.stringify(data).replace(/</g, '\\u003c');

	return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Prefab: ${escapeHtml(fileName)}</title>
<style nonce="${nonce}">
	:root {
		color-scheme: light dark;
		/* Colors sampled from the Cocos Creator hierarchy panel, used to tell
		   ordinary nodes apart from nested-prefab-instance roots regardless of
		   the current VS Code theme. */
		--prefab-tree-bg: #2B2B2B;
		--prefab-node-ordinary: #C1C1C1;
		--prefab-node-nested-1: #64AC89;
		--prefab-node-nested-2: #8DD27A;
	}
	* { box-sizing: border-box; }
	body {
		font-family: var(--vscode-editor-font-family, monospace);
		font-size: var(--vscode-editor-font-size, 13px);
		color: var(--vscode-editor-foreground);
		background-color: var(--vscode-editor-background);
		margin: 0;
		padding: 0;
	}
	.toolbar {
		position: sticky;
		top: 0;
		z-index: 10;
		display: flex;
		gap: 8px;
		align-items: center;
		padding: 8px 12px;
		background-color: var(--vscode-editor-background);
		border-bottom: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
	}
	.toolbar button {
		background-color: var(--vscode-button-secondaryBackground, #3a3d41);
		color: var(--vscode-button-secondaryForeground, #fff);
		border: none;
		padding: 4px 10px;
		border-radius: 3px;
		cursor: pointer;
		font-size: 12px;
	}
	.toolbar button:hover {
		background-color: var(--vscode-button-secondaryHoverBackground, #45494e);
	}
	.toolbar input[type="text"] {
		flex: 1;
		max-width: 320px;
		background-color: var(--vscode-input-background);
		color: var(--vscode-input-foreground);
		border: 1px solid var(--vscode-input-border, transparent);
		border-radius: 3px;
		padding: 4px 8px;
		font-size: 12px;
	}
	.toolbar .count {
		font-size: 12px;
		opacity: 0.7;
		white-space: nowrap;
	}
	.toolbar .checkbox {
		display: flex;
		align-items: center;
		gap: 4px;
		font-size: 12px;
		white-space: nowrap;
		cursor: pointer;
		user-select: none;
	}
	body.hide-components .components-node {
		display: none;
	}
	.active-marker {
		margin-right: 4px;
		opacity: 0.8;
	}
	body.hide-active-markers .active-marker {
		display: none;
	}
	#tree {
		padding: 8px 12px 40px 12px;
		overflow-x: auto;
		background-color: var(--prefab-tree-bg);
	}
	.node {
		white-space: nowrap;
	}
	.node > .row {
		display: flex;
		align-items: flex-start;
		border-radius: 3px;
		padding: 1px 4px;
	}
	.node > .row:hover {
		background-color: var(--vscode-list-hoverBackground);
	}
	.children {
		margin-left: 18px;
		border-left: 1px dotted var(--vscode-widget-border, #555);
		padding-left: 2px;
	}
	.twisty {
		width: 14px;
		flex: 0 0 14px;
		cursor: pointer;
		user-select: none;
		opacity: 0.8;
		text-align: center;
	}
	.leaf-indent {
		width: 14px;
		flex: 0 0 14px;
	}
	.collapsed > .children {
		display: none;
	}
	.collapsed > .row .twisty::before {
		content: "▶";
	}
	.expanded > .row .twisty::before {
		content: "▼";
	}
	.key {
		color: var(--prefab-node-ordinary);
		margin-right: 4px;
	}
	.key.nested-1 {
		color: var(--prefab-node-nested-1);
	}
	.key.nested-2plus {
		color: var(--prefab-node-nested-2);
	}
	.key.components-list {
		/* Wins over .nested-1/.nested-2plus above regardless of nesting tier -
		   same specificity, later in source order. */
		color: #4079d3;
	}
	.key.inactive {
		/* ~35% darker than whatever color it's combined with above (tier or
		   components-list alike, since filter is a separate property from
		   color and so always applies on top). */
		filter: brightness(65%);
	}
	.punct {
		opacity: 0.6;
		margin-right: 4px;
	}
	.type-string { color: var(--vscode-debugTokenExpression-string, #ce9178); }
	.type-number { color: var(--vscode-debugTokenExpression-number, #b5cea8); }
	.type-boolean { color: var(--vscode-debugTokenExpression-boolean, #569cd6); }
	.type-null { color: var(--vscode-debugTokenExpression-name, #569cd6); opacity: 0.8; }
	.summary {
		opacity: 0.55;
		margin-left: 4px;
	}
	.node.match > .row {
		outline: 1px solid var(--vscode-editor-findMatchBorder, #f0c000);
		background-color: var(--vscode-editor-findMatchHighlightBackground, rgba(240, 192, 0, 0.25));
	}
	.node.hidden {
		display: none;
	}
	.empty {
		padding: 24px;
		opacity: 0.7;
	}
</style>
</head>
<body class="hide-components hide-active-markers">
	<div class="toolbar">
		<button id="expandAll">Expand All</button>
		<button id="collapseAll">Collapse All</button>
		<label class="checkbox"><input type="checkbox" id="toggleComponents" /> Components</label>
		<label class="checkbox"><input type="checkbox" id="toggleActiveMarkers" /> Active</label>
		<input id="filter" type="text" placeholder="Filter keys / values..." />
		<span class="count" id="count"></span>
	</div>
	<div id="tree"></div>

	<script id="prefab-data" type="application/json">${json}</script>
	<script nonce="${nonce}">
	(function () {
		const vscode = acquireVsCodeApi();
		// Reserved key a node's own children-map carries (alongside its real
		// children) when that node itself is inactive - see ACTIVE_KEY in
		// src/prefabTree.ts, the single source of truth for this literal.
		const ACTIVE_KEY = ${JSON.stringify(ACTIVE_KEY)};
		const data = JSON.parse(document.getElementById('prefab-data').textContent);
		const tree = document.getElementById('tree');
		const countEl = document.getElementById('count');

		function typeOf(v) {
			if (v === null) return 'null';
			if (Array.isArray(v)) return 'array';
			return typeof v;
		}

		function summaryFor(count, isArray) {
			return isArray ? '[' + count + ']' : '{' + count + '}';
		}

		function isComponentsKey(k) {
			return typeof k === 'string' && k.charAt(0) === '[' && k.charAt(k.length - 1) === ']';
		}

		function renderPrimitive(v) {
			const t = typeOf(v);
			const span = document.createElement('span');
			span.className = 'type-' + t;
			span.textContent = t === 'string' ? JSON.stringify(v) : String(v);
			return span;
		}

		let nodeCount = 0;

		// A node's own label carries a leading "*" when it's the root of a
		// nested prefab instance (see nodeDisplayLabel in src/prefabTree.ts).
		// prefabDepth counts how many such "*" boundaries have been crossed
		// from the tree root down to (and including) this node, so ordinary
		// nodes get the baseline color while nested-prefab roots are tiered
		// by how deep their nesting chain goes. ancestorInactive is true once
		// any ancestor is itself inactive - an inactive node's whole subtree
		// is effectively invisible in Cocos too, so the darkening cascades
		// down regardless of each descendant's own active flag.
		function buildNode(key, value, depth, prefabDepth, ancestorInactive) {
			nodeCount++;
			const t = typeOf(value);
			const isContainer = t === 'object' || t === 'array';
			const isNestedLabel = typeof key === 'string' && key.charAt(0) === '*';
			const ownPrefabDepth = isNestedLabel ? prefabDepth + 1 : prefabDepth;
			// Synthetic "[<component1>,<component2>,...]" nodes added by
			// --components=child (see withComponentsAsChildren in
			// src/prefabTree.ts) - toggled by the "Components" checkbox, and
			// excluded from the child count/twisty below so they don't count
			// as a "real" child of their parent node.
			const isComponentsLabel = isComponentsKey(key);
			// ACTIVE_KEY is metadata about THIS node (see below), not a child,
			// so it's stripped out before it ever reaches the entries list.
			const ownInactive = isContainer && !Array.isArray(value) && value[ACTIVE_KEY] === false;
			const isInactive = ancestorInactive || ownInactive;
			const entries = isContainer
				? (Array.isArray(value) ? value.map((v, i) => [i, v]) : Object.entries(value).filter(([k]) => k !== ACTIVE_KEY))
				: [];
			const realChildCount = entries.filter(([k]) => !isComponentsKey(k)).length;
			const hasRealChildren = realChildCount > 0;

			const node = document.createElement('div');
			const stateClass = isContainer ? (hasRealChildren ? (depth < 1 ? 'expanded' : 'collapsed') : 'expanded') : 'leaf';
			node.className = 'node ' + stateClass + (isComponentsLabel ? ' components-node' : '');
			if (key !== null) node.dataset.key = String(key).toLowerCase();

			const row = document.createElement('div');
			row.className = 'row';

			if (isContainer && hasRealChildren) {
				const twisty = document.createElement('span');
				twisty.className = 'twisty';
				twisty.addEventListener('click', () => {
					node.classList.toggle('collapsed');
					node.classList.toggle('expanded');
				});
				row.appendChild(twisty);
			} else {
				const indent = document.createElement('span');
				indent.className = 'leaf-indent';
				row.appendChild(indent);
			}

			if (key !== null) {
				if (isContainer) {
					const activeMarker = document.createElement('span');
					activeMarker.className = 'active-marker';
					activeMarker.textContent = ownInactive ? '☐' : '☑';
					row.appendChild(activeMarker);
				}

				const keySpan = document.createElement('span');
				keySpan.className = 'key' + (ownPrefabDepth >= 1 ? (ownPrefabDepth >= 2 ? ' nested-2plus' : ' nested-1') : '') + (isComponentsLabel ? ' components-list' : '') + (isInactive ? ' inactive' : '');
				keySpan.textContent = key.replace(/^\\*/, '') + (isContainer && hasRealChildren ? ':' : '');
				row.appendChild(keySpan);
			}

			if (isContainer) {
				if (hasRealChildren) {
					const summary = document.createElement('span');
					summary.className = 'summary';
					summary.textContent = summaryFor(realChildCount, Array.isArray(value));
					row.appendChild(summary);
				}
			} else {
				row.appendChild(renderPrimitive(value));
			}

			node.appendChild(row);

			if (isContainer) {
				const children = document.createElement('div');
				children.className = 'children';
				for (const [k, v] of entries) {
					children.appendChild(buildNode(k, v, depth + 1, ownPrefabDepth, isInactive));
				}
				node.appendChild(children);
			} else {
				// leaf value text is also searchable via textContent match below
				node.dataset.value = (t === 'string' ? value : String(value)).toLowerCase();
			}

			return node;
		}

		if (data !== null && typeof data === 'object' && Object.keys(data).length === 0) {
			const empty = document.createElement('div');
			empty.className = 'empty';
			empty.textContent = 'This JSON document is empty.';
			tree.appendChild(empty);
		} else {
			tree.appendChild(buildNode(null, data, 0, 0, false));
		}

		countEl.textContent = nodeCount + ' node' + (nodeCount === 1 ? '' : 's');

		const componentsToggle = document.getElementById('toggleComponents');
		componentsToggle.addEventListener('change', () => {
			document.body.classList.toggle('hide-components', !componentsToggle.checked);
		});

		const activeMarkersToggle = document.getElementById('toggleActiveMarkers');
		activeMarkersToggle.addEventListener('change', () => {
			document.body.classList.toggle('hide-active-markers', !activeMarkersToggle.checked);
		});

		document.getElementById('expandAll').addEventListener('click', () => {
			tree.querySelectorAll('.node').forEach((n) => {
				if (n.querySelector(':scope > .children')) {
					n.classList.remove('collapsed');
					n.classList.add('expanded');
				}
			});
		});

		document.getElementById('collapseAll').addEventListener('click', () => {
			tree.querySelectorAll('.node').forEach((n) => {
				if (n.querySelector(':scope > .children')) {
					n.classList.remove('expanded');
					n.classList.add('collapsed');
				}
			});
		});

		const filterInput = document.getElementById('filter');
		let filterTimer;
		filterInput.addEventListener('input', () => {
			clearTimeout(filterTimer);
			filterTimer = setTimeout(() => applyFilter(filterInput.value.trim().toLowerCase()), 120);
		});

		function applyFilter(term) {
			const allNodes = Array.from(tree.querySelectorAll('.node'));
			if (!term) {
				allNodes.forEach((n) => {
					n.classList.remove('hidden', 'match');
				});
				return;
			}
			allNodes.forEach((n) => n.classList.add('hidden'));
			allNodes.forEach((n) => {
				const key = n.dataset.key || '';
				const val = n.dataset.value || '';
				if (key.includes(term) || val.includes(term)) {
					n.classList.add('match');
					n.classList.remove('hidden');
					n.classList.remove('collapsed');
					n.classList.add('expanded');
					let p = n.parentElement;
					while (p && p !== tree) {
						if (p.classList.contains('node')) {
							p.classList.remove('hidden', 'collapsed');
							p.classList.add('expanded');
						}
						p = p.parentElement;
					}
				} else {
					n.classList.remove('match');
				}
			});
		}
	})();
	</script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}
