// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { showPrefabView } from './prefabViewPanel';
import { buildPrefabTree, findAssetsDir, treeToJson } from './prefabTree';

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {

	// Use the console to output diagnostic information (console.log) and errors (console.error)
	// This line of code will only be executed once when your extension is activated
	console.log('Congratulations, your extension "cc-prefab-viewer" is now active!');

	// The command has been defined in the package.json file
	// Now provide the implementation of the command with registerCommand
	// The commandId parameter must match the command field in package.json
	const disposable = vscode.commands.registerCommand('cc-prefab-viewer.helloWorld', () => {
		// The code you place here will be executed every time your command is executed
		// Display a message box to the user
		vscode.window.showInformationMessage('Hello World from cc-prefab-viewer!');
	});

	context.subscriptions.push(disposable);

	const prefabView = vscode.commands.registerCommand('cc-prefab-viewer.prefabView', async (uriArg?: vscode.Uri) => {
		const uri = uriArg ?? vscode.window.activeTextEditor?.document.uri;
		if (!uri) {
			vscode.window.showErrorMessage('Prefab View: no file selected.');
			return;
		}

		const fileName = uri.path.split('/').pop() ?? uri.toString();
		const assetsDir = uri.scheme === 'file' ? findAssetsDir(uri.fsPath) : undefined;

		let data: unknown;
		if (assetsDir) {
			// setStatusBarMessage's own IPC "set" call has no guarantee of
			// reaching the UI process before the synchronous, potentially slow
			// tree-building work (it walks the whole assets/ folder) starts
			// blocking the extension host - so "set" and the later "dispose"
			// could both end up flushed only after the work is already done,
			// and nothing is ever seen. withProgress is the API actually
			// designed for "show this while a task runs" and owns making sure
			// the indicator is visible for the task's duration.
			await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Window, title: 'Building prefab tree...' },
				async () => {
					// Still yield once first so the progress UI has a chance to
					// paint before the synchronous work blocks the UI thread.
					await new Promise<void>((resolve) => setTimeout(resolve, 0));
					try {
						const tree = buildPrefabTree(uri.fsPath, assetsDir, { componentsMode: 'child' });
						data = treeToJson(uri.fsPath, tree, false);
					} catch {
						// Not a recognized .prefab/.scene (e.g. a plain .json file
						// under assets/) - fall through to showing its raw JSON below.
					}
				}
			);
		}

		if (!data) {
			let text: string;
			try {
				const bytes = await vscode.workspace.fs.readFile(uri);
				text = Buffer.from(bytes).toString('utf8');
			} catch (err) {
				vscode.window.showErrorMessage(`Prefab View: failed to read file (${err instanceof Error ? err.message : String(err)}).`);
				return;
			}

			try {
				data = JSON.parse(text);
			} catch {
				vscode.window.showErrorMessage('Prefab View: this file is not valid JSON.');
				return;
			}
		}

		showPrefabView(context, uri, fileName, data);
	});

	context.subscriptions.push(prefabView);
}

// This method is called when your extension is deactivated
export function deactivate() {}
