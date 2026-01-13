import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import Peer from "peerjs";

interface UserSettings {
  nickname: string;
  ip: string;
}
interface Contact {
  ip: string;
  username: string;
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
  private peer?: Peer;

  public static readonly viewType = "lnim.chatView";

  private _view?: vscode.WebviewView;
  private _userSettings: UserSettings;
  private _contacts: Contact[];

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
    this._contacts = this._context.globalState.get<Contact[]>("contacts", []);
    const id = Buffer.from(
      `${this._userSettings.ip}-${this._userSettings.nickname}`,
      "utf8"
    ).toString("base64");
    this.peer = new Peer(id, {
      debug: 3,
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
        case "getContacts": {
          webviewView.webview.postMessage({
            type: "updateContacts",
            contacts: this._contacts,
          });
          break;
        }
        case "addContact": {
          const c: Contact = data.contact;
          if (c?.ip && c?.username) {
            const exists = this._contacts.some(
              (x) => x.ip === c.ip && x.username === c.username
            );
            if (!exists) {
              this._contacts.push(c);
              await this._context.globalState.update("contacts", this._contacts);
            }
          }
          webviewView.webview.postMessage({
            type: "contactsSaved",
            contacts: this._contacts,
          });
          break;
        }
        case "deleteContact": {
          const c: Contact = data.contact;
          this._contacts = this._contacts.filter(
            (x) => !(x.ip === c?.ip && x.username === c?.username)
          );
          await this._context.globalState.update("contacts", this._contacts);
          webviewView.webview.postMessage({
            type: "contactsSaved",
            contacts: this._contacts,
          });
          break;
        }
        case "getFilesAndFolders": {
          // Default to root if no path provided, or handle specific path browsing
          // This original handler was for flat search. 
          // We'll keep it for flat search if needed, or redirect to directory listing?
          // The user wants "#" to show workspace folders and recurse. 
          // Let's implement a new message "getDirectoryContent" for that, 
          // but "getFilesAndFolders" was used for the initial "#" trigger.
          // We will deprecate this or leave it for "search" mode if we implement search.
          // But for now, let's just make sure we support the new requirement.
          // Let's implement 'getDirectoryContent' separately.
          break;
        }
        case "getDirectoryContent": {
          const dirPath = data.path || "";
          try {
            let targetUri: vscode.Uri;
            if (!dirPath) {
              const wsFolders = vscode.workspace.workspaceFolders;
              if (wsFolders && wsFolders.length > 0) {
                targetUri = wsFolders[0].uri;
              } else {
                 webviewView.webview.postMessage({
                  type: "directoryContent",
                  files: [],
                  folders: [],
                  path: ""
                });
                return;
              }
            } else {
              const wsFolders = vscode.workspace.workspaceFolders;
              if (wsFolders && wsFolders.length > 0) {
                 targetUri = vscode.Uri.joinPath(wsFolders[0].uri, dirPath);
              } else {
                return;
              }
            }

            const entries = await vscode.workspace.fs.readDirectory(targetUri);
            const files: string[] = [];
            const folders: string[] = [];

            for (const [name, type] of entries) {
              if (name.startsWith(".") || name === "node_modules" || name === "out" || name === "dist") {
                continue;
              }
              if (type === vscode.FileType.Directory) {
                folders.push(name);
              } else {
                files.push(name);
              }
            }
            
            webviewView.webview.postMessage({
              type: "directoryContent",
              files: files.sort(),
              folders: folders.sort(),
              path: dirPath // relative path from root
            });
          } catch (e) {
            console.error("Error reading directory", e);
            webviewView.webview.postMessage({
              type: "directoryContent",
              files: [],
              folders: [],
              path: dirPath
            });
          }
          break;
        }
        case "selectImage": {
          const uris = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            filters: {
              Images: ["png", "jpg", "jpeg", "gif", "webp", "bmp"],
            },
          });
          if (uris && uris.length > 0) {
            // We need to pass a path that the webview can display or reference
            // For now, just the relative path if in workspace, or absolute?
            // User wants to insert it as a tag.
            const uri = uris[0];
            const wsFolder = vscode.workspace.getWorkspaceFolder(uri);
            let label = path.basename(uri.fsPath);
            let value = uri.fsPath;
            if (wsFolder) {
               value = vscode.workspace.asRelativePath(uri, false);
            }
            webviewView.webview.postMessage({
              type: "imageSelected",
              path: value.replace(/\\/g, "/"),
              label: label
            });
          }
          break;
        }
        case "tagClicked": {
          const item = data.item;
          const label = item?.label ?? item?.value ?? "";
          const tagType = item?.type ?? "mention";
          vscode.window.showInformationMessage(
            `Tag clicked: ${label} (${tagType})`
          );
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
