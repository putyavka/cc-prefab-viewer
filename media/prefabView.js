(function () {
	const vscode = acquireVsCodeApi();
	// Reserved key a node's own children-map carries (alongside its real
	// children) when that node itself is inactive - see ACTIVE_KEY in
	// src/prefabTree.ts, the single source of truth for this literal; threaded
	// in via the body's data-active-key attribute (see prefabView.html), since
	// this file is a static asset and can't be templated directly.
	const ACTIVE_KEY = document.body.dataset.activeKey;
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
			keySpan.textContent = key.replace(/^\*/, '') + (isContainer && hasRealChildren ? ':' : '');
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
