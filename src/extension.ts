// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { ChatViewProvider } from './chat_view_provider';

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
	const provider = new ChatViewProvider(context.extensionUri, context);
	
	const sendViaLnimDisposable = vscode.commands.registerCommand(
		'vscode-lnim.sendViaLnim',
		async (uri: vscode.Uri, selectedUris: vscode.Uri[] | undefined) => {
			const targets =
				selectedUris && selectedUris.length > 0
					? selectedUris
					: uri
					? [uri]
					: [];
			if (!targets.length) {
				vscode.window.showInformationMessage('未选择任何文件或文件夹');
				return;
			}
			await provider.sendPathsToChat(targets);
		}
	);

	context.subscriptions.push(sendViaLnimDisposable);

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, provider)
	);
	
	// 注册 provider 的 dispose 方法
	context.subscriptions.push({
		dispose: () => {
			provider.dispose();
		}
	});
}

// This method is called when your extension is deactivated
export function deactivate() {}
