/**
 * Shared logic for turning a Cocos Creator .prefab/.scene asset's raw JSON
 * into a readable node-tree shape (name + components, nested prefabs
 * resolved/inlined). This is the same transformation tools/prefab-viewer.ts
 * exposes as a CLI (see that file for the full behavioral writeup); this
 * module holds the reusable pieces so both the CLI and the extension can
 * call the exact same logic instead of maintaining two copies.
 *
 * Every path handled here (assetsDir, assetPath, script paths) is expected
 * to already be a path fs.* can open as-is - either absolute, or relative
 * to the caller's process.cwd(). Callers pick whichever is convenient.
 */
import * as fs from 'fs';
import * as path from 'path';

const NESTED_PREFIX = '*';
const UNNAMED_NODE_LABEL = '(unnamed)';

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const LITERAL_PREFIX_NIBBLES = 5;

// Script components are serialized as `"__type__": "<compressedUuid>"` - the
// editor's internal onCompressUUID(uuid, false): the first 5 hex nibbles of
// the script's own .ts.meta uuid kept literally, then the remaining 108 bits
// (27 nibbles) base64-encoded into 18 chars, for a fixed 23-char result.
function hexToBits(hex: string): string {
	let bits = '';
	for (const ch of hex) {
		bits += parseInt(ch, 16).toString(2).padStart(4, '0');
	}
	return bits;
}

function bitsToBase64(bits: string): string {
	let out = '';
	for (let i = 0; i + 6 <= bits.length; i += 6) {
		out += BASE64_ALPHABET[parseInt(bits.slice(i, i + 6), 2)];
	}
	return out;
}

function compressUuid(uuid: string): string {
	const hex = uuid.replace(/-/g, '');
	if (hex.length !== 32) {
		throw new Error(`Invalid uuid: ${uuid}`);
	}
	const literalPrefix = hex.slice(0, LITERAL_PREFIX_NIBBLES);
	const rest = hex.slice(LITERAL_PREFIX_NIBBLES);
	return literalPrefix + bitsToBase64(hexToBits(rest));
}

// Builtin cocos types ("cc.Xxx") and internal wrapper types are plain
// identifiers, never hex-prefixed, so they never match this pattern.
const COMPRESSED_ID_PATTERN = /^[0-9a-f]{5}[A-Za-z0-9+/]{18}$/;

function isLikelyCompressedScriptId(typeName: string): boolean {
	return COMPRESSED_ID_PATTERN.test(typeName);
}

function toPosix(p: string): string {
	return p.split(path.sep).join('/');
}

function walk(dir: string, onFile: (filePath: string) => void): void {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			walk(fullPath, onFile);
		} else {
			onFile(fullPath);
		}
	}
}

// Every asset (prefabs included) is identified by its plain, uncompressed
// .meta uuid.
export function buildAssetUuidLookup(assetsDir: string): Map<string, string> {
	const lookup = new Map<string, string>();
	walk(assetsDir, (filePath) => {
		if (!filePath.endsWith('.meta') || filePath.endsWith('.ts.meta')) {return;}

		const assetPath = filePath.slice(0, -'.meta'.length);
		const meta = JSON.parse(fs.readFileSync(filePath, 'utf8'));
		if (meta.importer === 'directory' || !meta.uuid) {return;}

		lookup.set(meta.uuid, toPosix(assetPath));
	});
	return lookup;
}

// Maps a script component's compressed id (as it shows up in a node's
// `_components` -> `__type__`) to that script's .ts path, by compressing
// every script's own .ts.meta uuid the same way and matching it up.
export function buildScriptUuidLookup(assetsDir: string): Map<string, string> {
	const lookup = new Map<string, string>();
	walk(assetsDir, (filePath) => {
		if (!filePath.endsWith('.ts.meta')) {return;}

		const tsPath = filePath.slice(0, -'.meta'.length);
		if (!fs.existsSync(tsPath)) {return;} // stale meta, source file removed

		const meta = JSON.parse(fs.readFileSync(filePath, 'utf8'));
		if (meta.importer !== 'typescript' || !meta.uuid) {return;}

		lookup.set(compressUuid(meta.uuid), toPosix(tsPath));
	});
	return lookup;
}

export type RawObject = Record<string, unknown>;

interface RefIdLike {
	readonly __id__: number;
}

function isRefId(value: unknown): value is RefIdLike {
	return !!value && typeof value === 'object' && typeof (value as RefIdLike).__id__ === 'number';
}

export function findRootRefId(objects: RawObject[], assetPath: string): number {
	const root = objects[0];
	if (root?.__type__ === 'cc.Prefab' && isRefId(root.data)) {return root.data.__id__;}
	if (root?.__type__ === 'cc.SceneAsset' && isRefId(root.scene)) {return root.scene.__id__;}
	throw new Error(`Unrecognized root object in ${assetPath} (expected cc.Prefab or cc.SceneAsset).`);
}

export function loadObjects(assetPath: string, cache?: Map<string, RawObject[]>): RawObject[] {
	const cached = cache?.get(assetPath);
	if (cached) {return cached;}

	const objects: RawObject[] = JSON.parse(fs.readFileSync(assetPath, 'utf8'));
	cache?.set(assetPath, objects);
	return objects;
}

function nameFromAssetPath(assetPath: string): string {
	return path.basename(assetPath, path.extname(assetPath));
}

type NestedPrefabRef =
	| { readonly kind: 'none' }
	| { readonly kind: 'resolved'; readonly assetPath: string }
	| { readonly kind: 'unresolved'; readonly uuid: string };

// A node is the root of a nested prefab instance when its `_prefab` points at
// a `cc.PrefabInfo` object carrying an `asset` reference to the source
// .prefab. Plain (non-instanced) nodes have a `_prefab`/PrefabInfo too, but
// without an `asset` field.
function getNestedPrefabRef(node: RawObject, objects: RawObject[], uuidLookup: ReadonlyMap<string, string>): NestedPrefabRef {
	if (!isRefId(node._prefab)) {return { kind: 'none' };}

	const prefabInfo = objects[node._prefab.__id__];
	const assetRef = prefabInfo?.asset as RawObject | undefined;
	if (!assetRef || typeof assetRef.__uuid__ !== 'string') {return { kind: 'none' };}

	const resolvedPath = uuidLookup.get(assetRef.__uuid__);
	return resolvedPath ? { kind: 'resolved', assetPath: resolvedPath } : { kind: 'unresolved', uuid: assetRef.__uuid__ };
}

// Display name for a single component's `__type__`: script components
// resolve to their .ts file's base name (falling back to the raw compressed
// id if the script can't be found - deleted/moved script); builtin types
// ("cc.Sprite", "sp.SkeletonData", ...) have their lowercase namespace
// prefix stripped.
function componentDisplayName(typeName: string, scriptLookup: ReadonlyMap<string, string>): string {
	if (isLikelyCompressedScriptId(typeName)) {
		const tsPath = scriptLookup.get(typeName);
		return tsPath ? nameFromAssetPath(tsPath) : typeName;
	}
	return typeName.replace(/^[a-z]+\./, '');
}

function getNodeComponentNames(node: RawObject, objects: RawObject[], scriptLookup: ReadonlyMap<string, string>): string[] {
	const componentRefs = Array.isArray(node._components) ? node._components.filter(isRefId) : [];
	return componentRefs.map((ref) => {
		const component = objects[ref.__id__];
		const typeName = typeof component?.__type__ === 'string' ? component.__type__ : '';
		return componentDisplayName(typeName, scriptLookup);
	});
}

export interface TreeNode {
	readonly label: string;
	// true when this node is the root of a nested prefab instance - its name
	// gets the "*" prefix, and so does the tree connector of its own direct
	// children (but not further down, marking only where the nested
	// prefab's content starts).
	readonly isNested: boolean;
	// this node's own component display names, in `_components` order.
	readonly components: readonly string[];
	// mirrors the node's own `_active` flag (defaults to true, Cocos's own
	// default, when the field is omitted - Cocos only serializes it when
	// it differs from the default).
	readonly active: boolean;
	readonly children: readonly TreeNode[];
}

function isNodeActive(node: RawObject): boolean {
	return typeof node._active !== 'boolean' || node._active;
}

interface FileContext {
	readonly assetPath: string;
	readonly objects: RawObject[];
}

// undefined = no limit (always expand). Otherwise counts down the number of
// nested-prefab boundaries still allowed to be expanded: crossing into a
// nested prefab while it's > 0 consumes one level for everything found
// inside that prefab; once it reaches 0, the next nested prefab encountered
// is shown by name only, without loading/expanding its own content.
export function buildNode(
	refId: number,
	context: FileContext,
	fallbackName: string,
	uuidLookup: ReadonlyMap<string, string>,
	scriptLookup: ReadonlyMap<string, string>,
	visitedNestedPaths: readonly string[],
	remainingNestingDepth: number | undefined,
	cache: Map<string, RawObject[]>
): TreeNode {
	const node = context.objects[refId];
	const nestedRef = getNestedPrefabRef(node, context.objects, uuidLookup);
	// The instance's own active toggle in this file, not the nested prefab's
	// internal authored default - that's what actually governs whether this
	// instance is visible here.
	const active = isNodeActive(node);

	if (nestedRef.kind === 'unresolved') {
		return { label: `(missing prefab, uuid ${nestedRef.uuid})`, isNested: true, active, components: [], children: [] };
	}

	if (nestedRef.kind === 'resolved') {
		if (visitedNestedPaths.includes(nestedRef.assetPath)) {
			return {
				label: `${nameFromAssetPath(nestedRef.assetPath)} (circular reference)`,
				isNested: true,
				active,
				components: [],
				children: [],
			};
		}

		const nestedObjects = loadObjects(nestedRef.assetPath, cache);
		const nestedRootRefId = findRootRefId(nestedObjects, nestedRef.assetPath);
		const nestedRootObject = nestedObjects[nestedRootRefId];
		const nestedRootName =
			typeof nestedRootObject._name === 'string' && nestedRootObject._name.length > 0
				? nestedRootObject._name
				: nameFromAssetPath(nestedRef.assetPath);
		const nestedRootComponents = getNodeComponentNames(nestedRootObject, nestedObjects, scriptLookup);

		if (remainingNestingDepth !== undefined && remainingNestingDepth <= 0) {
			return { label: nestedRootName, isNested: true, active, components: nestedRootComponents, children: [] };
		}

		const nestedContext: FileContext = { assetPath: nestedRef.assetPath, objects: nestedObjects };
		const inner = buildNode(
			nestedRootRefId,
			nestedContext,
			nameFromAssetPath(nestedRef.assetPath),
			uuidLookup,
			scriptLookup,
			[...visitedNestedPaths, nestedRef.assetPath],
			remainingNestingDepth === undefined ? undefined : remainingNestingDepth - 1,
			cache
		);
		return { label: inner.label, isNested: true, active, components: inner.components, children: inner.children };
	}

	const name = typeof node._name === 'string' && node._name.length > 0 ? node._name : fallbackName;
	const components = getNodeComponentNames(node, context.objects, scriptLookup);
	const childRefs = Array.isArray(node._children) ? node._children.filter(isRefId) : [];
	const children = childRefs.map((ref) =>
		buildNode(ref.__id__, context, UNNAMED_NODE_LABEL, uuidLookup, scriptLookup, visitedNestedPaths, remainingNestingDepth, cache)
	);

	return { label: name, isNested: false, active, components, children };
}

export type ComponentsMode = 'none' | 'suffix' | 'child';

// For --components=child: turns each node's own component list into a
// synthetic "[<component1>,<component2>,...]" node, inserted as its first
// child instead of appended as a suffix.
export function withComponentsAsChildren(node: TreeNode): TreeNode {
	const children = node.children.map(withComponentsAsChildren);

	if (node.components.length === 0) {
		return { ...node, children };
	}

	const componentsChild: TreeNode = {
		label: `[${node.components.join(',')}]`,
		isNested: false,
		active: true,
		components: [],
		children: [],
	};
	return { ...node, children: [componentsChild, ...children] };
}

// Same display text as the CLI text format's tree line - "*" nested prefix
// and " [<component1>,<component2>,...]" suffix.
function nodeDisplayLabel(node: TreeNode, showComponents: boolean): string {
	const prefix = node.isNested ? NESTED_PREFIX : '';
	const suffix = showComponents && node.components.length > 0 ? ` [${node.components.join(',')}]` : '';
	return `${prefix}${node.label}${suffix}`;
}

export type JsonTree = { readonly [label: string]: JsonTree | boolean };

// Reserved key carrying a node's own `active` flag inside its own children
// map, alongside its real children - omitted when active (true), mirroring
// Cocos's own omit-if-default serialization. Not a real child, so consumers
// (the CLI's --format=json output, the extension's tree webview) must strip
// it out before treating the rest of the object as this node's children.
export const ACTIVE_KEY = '$active';

// Each child becomes an object key holding its own children (a leaf is `{}`).
// Sibling nodes sharing the same display label (e.g. several identically
// named list items) would otherwise collide as duplicate object keys and
// silently drop data, so repeats beyond the first get a " #2", " #3", ...
// suffix to stay unique.
export function buildJsonChildren(children: readonly TreeNode[], showComponents: boolean): JsonTree {
	const result: Record<string, JsonTree> = {};
	const labelCounts = new Map<string, number>();

	for (const child of children) {
		const baseLabel = nodeDisplayLabel(child, showComponents);
		const count = (labelCounts.get(baseLabel) ?? 0) + 1;
		labelCounts.set(baseLabel, count);
		const label = count === 1 ? baseLabel : `${baseLabel} #${count}`;
		const childTree = buildJsonChildren(child.children, showComponents);
		result[label] = child.active ? childTree : { [ACTIVE_KEY]: false, ...childTree };
	}

	return result;
}

export interface BuildPrefabTreeOptions {
	readonly componentsMode: ComponentsMode;
	readonly nestingDepth?: number;
}

// Resolves uuid/script lookups from assetsDir and builds the full node tree
// for the .prefab/.scene at assetPath, applying --components=child if
// requested (--components=suffix is left as per-node data for the caller to
// render, since "suffix" only matters for display, not tree shape).
export function buildPrefabTree(assetPath: string, assetsDir: string, options: BuildPrefabTreeOptions): TreeNode {
	const uuidLookup = buildAssetUuidLookup(assetsDir);
	const scriptLookup = buildScriptUuidLookup(assetsDir);
	const cache = new Map<string, RawObject[]>();

	const objects = loadObjects(assetPath, cache);
	const rootRefId = findRootRefId(objects, assetPath);
	const rootContext: FileContext = { assetPath, objects };
	const builtTree = buildNode(
		rootRefId,
		rootContext,
		nameFromAssetPath(assetPath),
		uuidLookup,
		scriptLookup,
		[assetPath],
		options.nestingDepth,
		cache
	);

	return options.componentsMode === 'child' ? withComponentsAsChildren(builtTree) : builtTree;
}

// Mirrors the CLI's --format=json output shape:
// { "__asset": "<path>", "<root label>": { "<child label>": {...}, ... } }
export function treeToJson(assetPath: string, tree: TreeNode, showComponentsSuffix: boolean): Record<string, unknown> {
	const rootChildren = buildJsonChildren(tree.children, showComponentsSuffix);
	return {
		__asset: assetPath,
		[nodeDisplayLabel(tree, showComponentsSuffix)]: tree.active ? rootChildren : { [ACTIVE_KEY]: false, ...rootChildren },
	};
}

// Given an absolute path to a file somewhere under a Cocos project's
// assets/ folder, returns that folder's absolute path (needed to resolve
// nested-prefab and script uuid references). Returns undefined if no
// "assets" directory is found among the file's ancestors.
export function findAssetsDir(absoluteFilePath: string): string | undefined {
	const segments = path.dirname(absoluteFilePath).split(path.sep);
	const index = segments.lastIndexOf('assets');
	if (index === -1) {return undefined;}
	return segments.slice(0, index + 1).join(path.sep);
}
