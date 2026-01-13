import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import Peer, { LogLevel } from "peerjs";

interface UserSettings {
  nickname: string;
  ip: string;
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
  private peer?: Peer;

  public static readonly viewType = "lnim.chatView";

  private _view?: vscode.WebviewView;
  private _userSettings: UserSettings;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _context: vscode.ExtensionContext
  ) {
    this._userSettings = this._context.globalState.get<UserSettings>(
      "userSettings",
      {
        nickname: "User",
        ip: "",
      }
    );
    const id = Buffer.from(
      `${this._userSettings.ip}-${this._userSettings.nickname}`,
      "utf8"
    ).toString("base64");
    this.peer = new Peer(id, {
      debug: LogLevel.All,
    });
    console.log(`Peer initialized with ID: ${id}, `, this.peer);
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      // Allow scripts in the webview
      enableScripts: true,

      localResourceRoots: [this._extensionUri],
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (data) => {
      switch (data.type) {
        case "saveSettings": {
          this._userSettings = data.settings;
          await this._context.globalState.update("userSettings", data.settings);
          // 确认保存成功
          webviewView.webview.postMessage({
            type: "settingsSaved",
            settings: this._userSettings,
          });
          break;
        }
        case "getSettings": {
          webviewView.webview.postMessage({
            type: "updateSettings",
            settings: this._userSettings,
          });
          break;
        }
        case "sendMessage": {
          // 这里将来可以处理发送给其他 Peer 的逻辑
          // 目前仅仅是回显（其实前端自己已经处理了回显，这里可以做服务端确认等）
          break;
        }
      }
    });
  }

  private _getHtmlForWebview(webview: vscode.Webview) {
    const htmlPath = path.join(
      this._extensionUri.fsPath,
      "resources",
      "chat.html"
    );
    try {
      let html = fs.readFileSync(htmlPath, "utf-8");

      // Generate a nonce for Content-Security-Policy
      const nonce = this.getNonce();
      const cspSource = webview.cspSource;

      // Replace placeholders in the HTML file
      html = html
        .replace(/{{cspSource}}/g, cspSource)
        .replace(/{{nonce}}/g, nonce);

      return html;
    } catch (error) {
      console.error("Error loading HTML file:", error);
      return `<!DOCTYPE html><html><body>Error loading HTML file: ${error}</body></html>`;
    }
  }

  private getNonce() {
    let text = "";
    const possible =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    for (let i = 0; i < 32; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
  }
}
