import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export class ChatViewProvider implements vscode.WebviewViewProvider {

	public static readonly viewType = 'lnim.chatView';

	constructor(
		private readonly _extensionUri: vscode.Uri,
	) { }

	public resolveWebviewView(
		webviewView: vscode.WebviewView,
		context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken,
	) {
		webviewView.webview.options = {
			// Allow scripts in the webview
			enableScripts: true,

			localResourceRoots: [
				this._extensionUri
			]
		};

		webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);
	}

	private _getHtmlForWebview(_webview: vscode.Webview) {
        const htmlPath = path.join(this._extensionUri.fsPath, 'resources', 'chat.html');
        try {
            return fs.readFileSync(htmlPath, 'utf-8');
        } catch (error) {
            console.error('Error loading HTML file:', error);
            return `<!DOCTYPE html><html><body>Error loading HTML file: ${error}</body></html>`;
        }
	}
}
