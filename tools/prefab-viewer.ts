/**
 * Prints the node tree of a specified .prefab or .scene asset in a human
 * readable, indented tree format (similar to `tree`/`ls -R`, but for Cocos
 * Creator node hierarchies instead of the filesystem).
 *
 * A node that is the root of a nested prefab instance (i.e. instantiated from
 * another .prefab file rather than authored inline in this asset) has its
 * name prefixed with "*". The tree connector (`├── `/`└── `) on its own
 * direct children is prefixed with "*" too, and so is every `│` continuation
 * bar running down through the rest of that nested prefab's subtree,
 * marking the full extent of where the nested prefab's own content lives.
 * Such a node is serialized in its owning
 * .prefab/.scene file as an empty stub - no `_name`, no `_children` - with
 * only a `_prefab` -> `cc.PrefabInfo` -> `asset` reference (a `__uuid__`
 * pointing at the source .prefab) marking it as an instance, the same
 * encoding tools/asset-references-report.ts uses to distinguish nested
 * prefab instances from plain prefab references. Its real name and children
 * live in the referenced .prefab file itself, so it's resolved (by uuid,
 * the same project-wide asset uuid -> path lookup asset-references-report.ts
 * builds from every asset's .meta file) and recursed into to build the rest
 * of the tree.
 *
 * The tree-building itself (resolving nested prefabs/scripts, walking node
 * hierarchies, shaping --components/--format output) lives in
 * src/prefabTree.ts and is shared with the VS Code extension's "Prefab
 * View" command; this file is the CLI-only wrapper around it (asset
 * search/resolution, text-format rendering, argv parsing, file output).
 *
 * The target asset can be given as:
 *   - an exact path, relative to the project root or to assets/, e.g.
 *     "assets/Prefabs/UI/HeroCard.prefab" or "Prefabs/UI/HeroCard.prefab"
 *   - a bare name or partial path to search for under assets/, e.g. "HeroCard"
 *   - a glob pattern ("*" within a path segment, "**" across "/"), e.g.
 *     "assets/Prefabs/UI/*.prefab"
 * Asset searching (walking assets/ for .prefab/.scene files and matching
 * them against the given name/glob) reuses the same approach as
 * tools/asset-references-report.ts.
 * If the search matches more than one asset, every candidate is listed and
 * you're asked to be more specific instead of one being picked arbitrarily.
 *
 * Run: npx tsx tools/prefab-viewer.ts <path-or-name-or-glob> [--output=<file>] [--components[=suffix|child]] [--format=text|json] [--nesting-depth=<n>]
 * Optional flags:
 *   --output=<file>   write the tree to this file (UTF-8) instead of stdout
 *   --nesting-depth=<n>  how many nested-prefab boundaries to expand,
 *                      defaults to unlimited. E.g. if prefab A instances
 *                      prefab B, which itself instances prefab C:
 *                      --nesting-depth=0 shows only B's name (not expanded);
 *                      --nesting-depth=1 expands B's own content, but C
 *                      (nested one level deeper) shows only its name.
 *   --format=text|json  output format, defaults to "text" (the box-drawing
 *                      tree). "json" mirrors the same tree shape/labels as
 *                      "text" - `{ "__asset": "<path>", "<root label>": {
 *                      "<child label>": { ... }, ... } }` - where each label
 *                      is that node's display text (the "*" nested prefix
 *                      and, with --components=suffix, the
 *                      " [<component1>,...]" suffix baked in) and children
 *                      nest as an object instead of indentation; a leaf is
 *                      `{}`. Sibling nodes that share the exact same label
 *                      get a " #2", " #3", ... suffix so they don't collide
 *                      as duplicate object keys. A node's own children
 *                      object also carries a `"$active": false` entry
 *                      alongside its real children when that node's
 *                      `_active` is false (omitted when active, same as
 *                      Cocos's own omit-if-default serialization).
 *   --components[=suffix|child]  show each node's component names. Script
 *                      components are serialized as a compressed id (the
 *                      same 23-char `"__type__": "<compressedUuid>"`
 *                      encoding tools/asset-references-report.ts decodes),
 *                      resolved back to the script's file name the same way
 *                      that tool resolves it (via every script's own .ts.meta
 *                      uuid, compressed and matched up); builtin components
 *                      (e.g. "cc.Sprite") are shown with their "cc."/"sp."
 *                      namespace prefix stripped.
 *                        suffix (default) - append as a
 *                          "[<component1>,<component2>,...]" node suffix,
 *                          same as bare --components.
 *                        child - add "[<component1>,<component2>,...]" as
 *                          the node's own first child instead of a suffix.
 */
import * as fs from "fs";
import * as path from "path";
import { buildPrefabTree, ComponentsMode, TreeNode, treeToJson } from "../src/prefabTree";

const ASSETS_DIR = "assets";

function toPosix(p: string): string {
    return p.split(path.sep).join("/");
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

// Minimal glob support: "*" matches any chars except "/", "**" matches
// across "/" too. Copied from tools/asset-references-report.ts.
function globToRegExp(glob: string): RegExp {
    const DOUBLE_STAR = " DOUBLE_STAR ";
    let pattern = glob.replace(/\*\*/g, DOUBLE_STAR);
    pattern = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    pattern = pattern.replace(/\*/g, "[^/]*");
    pattern = pattern.split(DOUBLE_STAR).join(".*");
    return new RegExp(`^${pattern}$`);
}

function collectAssetPaths(): string[] {
    const assetPaths: string[] = [];
    walk(ASSETS_DIR, (filePath) => {
        if (filePath.endsWith(".prefab") || filePath.endsWith(".scene")) {
            assetPaths.push(toPosix(filePath));
        }
    });
    return assetPaths.sort();
}

function pickSingleMatch(matches: string[], arg: string, searchedCount: number): string {
    if (matches.length === 1) return matches[0];
    if (matches.length === 0) {
        throw new Error(`No prefab/scene found matching "${arg}" (searched ${searchedCount} assets under ${ASSETS_DIR}/).`);
    }
    throw new Error(
        `"${arg}" matches ${matches.length} prefabs/scenes - be more specific:\n` +
            matches.map((p) => `  - ${p}`).join("\n")
    );
}

// Resolves the CLI argument to a single .prefab/.scene path: first tries it
// as an exact path (as given, and relative to assets/), then falls back to
// glob/substring search over every prefab/scene under assets/.
function resolveTargetAsset(arg: string): string {
    const normalized = toPosix(arg);

    for (const candidate of [normalized, toPosix(path.join(ASSETS_DIR, normalized))]) {
        if ((candidate.endsWith(".prefab") || candidate.endsWith(".scene")) && fs.existsSync(candidate)) {
            return candidate;
        }
    }

    const allPaths = collectAssetPaths();

    if (normalized.includes("*")) {
        const patterns = [normalized, toPosix(path.join(ASSETS_DIR, normalized))].map(globToRegExp);
        const matches = allPaths.filter((p) => patterns.some((re) => re.test(p)));
        return pickSingleMatch(matches, arg, allPaths.length);
    }

    const needle = normalized.toLowerCase();
    const matches = allPaths.filter((p) => p.toLowerCase().includes(needle));
    return pickSingleMatch(matches, arg, allPaths.length);
}

function componentsSuffix(components: readonly string[]): string {
    return components.length > 0 ? ` [${components.join(",")}]` : "";
}

function printTree(
    node: TreeNode,
    prefix: string,
    isLast: boolean,
    isRoot: boolean,
    starConnector: boolean,
    showComponents: boolean,
    lines: string[]
): void {
    const namePrefix = node.isNested ? "*" : "";
    const connectorPrefix = starConnector ? "*" : "";
    const nameSuffix = showComponents ? componentsSuffix(node.components) : "";
    if (isRoot) {
        lines.push(`${namePrefix}${node.label}${nameSuffix}`);
    } else {
        lines.push(`${prefix}${connectorPrefix}${isLast ? "└── " : "├── "}${namePrefix}${node.label}${nameSuffix}`);
    }

    const childPrefix = isRoot ? "" : `${prefix}${connectorPrefix}${isLast ? "    " : "│   "}`;
    node.children.forEach((child, index) => {
        printTree(child, childPrefix, index === node.children.length - 1, false, node.isNested, showComponents, lines);
    });
}

type OutputFormat = "text" | "json";

// `--format=text|json`, defaults to "text". Any other value is a hard error -
// silently falling back could leave someone staring at the wrong format.
function parseFormat(argv: string[]): OutputFormat {
    const flag = argv.find((a) => a.startsWith("--format="));
    if (!flag) return "text";

    const value = flag.slice("--format=".length).trim().toLowerCase();
    if (value === "text" || value === "json") return value;

    throw new Error(`Invalid --format value "${value}" - expected "text" or "json".`);
}

// `--components` (bare, same as `--components=suffix`) or
// `--components=suffix|child`. Omit entirely to hide components. Any other
// value is a hard error - silently falling back could leave someone staring
// at the wrong mode.
function parseComponentsMode(argv: string[]): ComponentsMode {
    const flag = argv.find((a) => a === "--components" || a.startsWith("--components="));
    if (!flag) return "none";
    if (flag === "--components") return "suffix";

    const value = flag.slice("--components=".length).trim().toLowerCase();
    if (value === "suffix" || value === "child") return value;

    throw new Error(`Invalid --components value "${value}" - expected "suffix" or "child".`);
}

// `--nesting-depth=<non-negative integer>`. Omit entirely for no limit
// (always expand every nested prefab). Any other value is a hard error -
// silently falling back could leave someone staring at a truncated tree
// without knowing why.
function parseNestingDepth(argv: string[]): number | undefined {
    const flag = argv.find((a) => a.startsWith("--nesting-depth="));
    if (!flag) return undefined;

    const raw = flag.slice("--nesting-depth=".length).trim();
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0) {
        throw new Error(`Invalid --nesting-depth value "${raw}" - expected a non-negative integer.`);
    }
    return value;
}

const cliArgs = process.argv.slice(2);
const outputFlag = cliArgs.find((a) => a.startsWith("--output="));
const outputFile = outputFlag ? outputFlag.slice("--output=".length) : undefined;
const componentsMode = parseComponentsMode(cliArgs);
const format = parseFormat(cliArgs);
const nestingDepth = parseNestingDepth(cliArgs);
const rawArg = cliArgs.find((a) => !a.startsWith("--"));

if (!rawArg) {
    throw new Error(
        "Usage: npx tsx tools/prefab-viewer.ts <path-or-name-or-glob> [--output=<file>] [--components[=suffix|child]] [--format=text|json] [--nesting-depth=<n>]"
    );
}

const assetPath = resolveTargetAsset(rawArg);
const tree = buildPrefabTree(assetPath, ASSETS_DIR, { componentsMode, nestingDepth });
const showComponentsSuffix = componentsMode === "suffix";

let output: string;
if (format === "json") {
    const jsonTree = treeToJson(assetPath, tree, showComponentsSuffix);
    output = `${JSON.stringify(jsonTree, null, 2)}\n`;
} else {
    const lines: string[] = [];
    printTree(tree, "", true, true, false, showComponentsSuffix, lines);
    output = `${assetPath}\n${lines.join("\n")}\n`;
}

if (outputFile) {
    fs.mkdirSync(path.dirname(outputFile), { recursive: true });
    fs.writeFileSync(outputFile, output, "utf8");
    console.log(`Tree written to ${outputFile}`);
} else {
    process.stdout.write(output);
}
