import * as fs from 'fs';
import * as path from 'path';
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
			localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
		}
	);

	openPanels.set(key, panel);
	panel.onDidDispose(() => openPanels.delete(key));

	panel.webview.html = getHtml(context, panel.webview, fileName, data);
}

// Fills in the __TOKEN__ placeholders in media/prefabView.html. Uses
// split/join rather than String.replace so replacement text containing "$"
// (e.g. ACTIVE_KEY's "$active", or arbitrary prefab data) is never
// misinterpreted as a replacement pattern ("$&", "$$", ...).
function fillTemplate(template: string, values: Record<string, string>): string {
	let result = template;
	for (const [token, value] of Object.entries(values)) {
		result = result.split(token).join(value);
	}
	return result;
}

function getHtml(context: vscode.ExtensionContext, webview: vscode.Webview, fileName: string, data: unknown): string {
	const nonce = getNonce();
	// Embed as a script-tag payload (not string-interpolated JS) and escape
	// "</script>" so malformed content in the prefab can't break out of it.
	const json = JSON.stringify(data).replace(/</g, '\\u003c');

	const mediaDir = vscode.Uri.joinPath(context.extensionUri, 'media');
	const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaDir, 'prefabView.css'));
	const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaDir, 'prefabView.js'));
	const template = fs.readFileSync(context.asAbsolutePath(path.join('media', 'prefabView.html')), 'utf8');

	return fillTemplate(template, {
		__NONCE__: nonce,
		__CSS_URI__: cssUri.toString(),
		__JS_URI__: jsUri.toString(),
		__TITLE__: escapeHtml(`Prefab: ${fileName}`),
		__ACTIVE_KEY__: ACTIVE_KEY,
		__PREFAB_DATA__: json,
	});
}

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}
