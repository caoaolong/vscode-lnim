import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  ChatMessageService,
  ChatContact as MessageContact,
  ChatUserSettings as MessageUserSettings,
} from "./chat_message_service";
import {
  ChatDataStore,
  StoredContact,
  StoredUserSettings,
} from "./chat_data_store";

type UserSettings = StoredUserSettings;
type Contact = StoredContact;

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "lnim.chatView";
  private static readonly DEFAULT_PORT = 18080;

  private _view?: vscode.WebviewView;
  private _currentWebviewView?: vscode.WebviewView;
  private _userSettings: UserSettings;
  private _contacts: Contact[];
  private _currentPort: number;
  private readonly _store: ChatDataStore;
  private readonly _messageService: ChatMessageService;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _context: vscode.ExtensionContext
  ) {
    this._store = new ChatDataStore(this._context);
    this._userSettings = this._store.getUserSettings();
    this._contacts = this._store.getContacts();
    // 插件启动时重置所有联系人的 status 为 false
    this._store.resetAllContactsStatus().then((contacts) => {
      this._contacts = contacts;
    });
    this._currentPort = this._userSettings.port || ChatViewProvider.DEFAULT_PORT;
    this._messageService = new ChatMessageService(this._currentPort, {
      view: this._view,
      defaultPort: ChatViewProvider.DEFAULT_PORT,
      getSelfId: () => this.id(),
      onLinkMessageReceived: (result) => {
        this.handleLinkMessageReceived(result);
      },
    });
  }

  public id(): string {
    const { nickname, ip, port } = this._userSettings;
    return Buffer.from(`${nickname}:${ip}:${port}`, "utf-8").toString("base64");
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;
    this._messageService.attachView(webviewView);
    // 更新回调中的 view 引用
    this._currentWebviewView = webviewView;

    webviewView.webview.options = {
      // Allow scripts in the webview
      enableScripts: true,

      localResourceRoots: [
        this._extensionUri,
        vscode.Uri.joinPath(this._extensionUri, "node_modules"),
      ],
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (data) => {
      switch (data.type) {
        case "saveSettings": {
          const incoming = data.settings as UserSettings;
          const updated = await this._store.updateUserSettings(incoming);
          this._userSettings = updated;
          if (updated.port !== this._currentPort) {
            this._currentPort = updated.port;
            this._messageService.restart(this._currentPort);
          }
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
        case "getLocalIps": {
          const ips = this.getLocalIps();
          webviewView.webview.postMessage({
            type: "localIps",
            ips,
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
        case "scanContacts": {
          const targetHost = data.targetHost as string;
          // 解析 IP:端口 格式
          const parts = targetHost.trim().split(":");
          if (parts.length !== 2) {
            vscode.window.showErrorMessage("主机地址格式必须为 IP:端口");
            break;
          }

          const targetIp = parts[0].trim();
          const portStr = parts[1].trim();
          const targetPort = parseInt(portStr, 10);

          if (!targetIp || !portStr || isNaN(targetPort) || targetPort <= 0 || targetPort > 65535) {
            vscode.window.showErrorMessage("主机地址格式必须为 IP:有效端口(1-65535)");
            break;
          }

          vscode.window.setStatusBarMessage(
            `正在向 ${targetIp}:${targetPort} 发送 LinkMessage...`,
            2000
          );

          // 创建临时联系人用于发送扫描消息
          const tempContact: Contact = {
            ip: targetIp,
            port: targetPort,
            username: "",
          };

          // 只负责发送消息，结果在 message 事件处理器中通过回调处理
          this._messageService.sendScanContactMessage(tempContact);
          break;
        }
        case "getContactsStatus": {
          const reqList: Contact[] = Array.isArray(data.contacts)
            ? data.contacts
            : this._contacts;
          const statuses = await Promise.all(
            reqList.map(async (c) => {
              const online = await this._messageService.checkContactOnline(c);
              return {
                ip: c.ip,
                port: c.port,
                username: c.username,
                online,
              };
            })
          );
          webviewView.webview.postMessage({
            type: "contactsStatus",
            statuses,
          });
          break;
        }
        case "checkContactLink": {
          const c: Contact = data.contact;
          this._messageService.sendLinkMessage(c, this.id());
          break;
        }
        case "deleteContact": {
          const c: Contact = data.contact;
          this._contacts = await this._store.deleteContact(c);
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
                  path: "",
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
              if (
                name.startsWith(".") ||
                name === "node_modules" ||
                name === "out" ||
                name === "dist"
              ) {
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
              path: dirPath, // relative path from root
            });
          } catch (e) {
            console.error("Error reading directory", e);
            webviewView.webview.postMessage({
              type: "directoryContent",
              files: [],
              folders: [],
              path: dirPath,
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
              label: label,
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
          this.handleSendMessage(data);
          break;
        }
      }
    });
  }

  private handleSendMessage(data: any) {
    const msg = (data && (data.value ?? data.message)) || "";
    const contacts = this.extractContactsFromMessage(msg);
    if (!contacts.length) {
      vscode.window.showErrorMessage(
        "消息中没有找到任何有效的联系人，请确认已使用 @用户名"
      );
      return;
    }
    this._messageService.sendChatMessage(
      msg,
      this._userSettings as MessageUserSettings,
      contacts as MessageContact[]
    );
  }

  private extractContactsFromMessage(text: string): Contact[] {
    if (!text) {
      return [];
    }
    const mentioned = new Set<string>();
    const regex = /@([^\s@#]+)/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      const name = match[1].replace(/[.,;:!?]+$/, "");
      if (name) {
        mentioned.add(name);
      }
    }
    if (mentioned.size === 0) {
      return [];
    }
    const matched = this._contacts.filter((c) => mentioned.has(c.username));
    if (matched.length === 0) {
      return [];
    }
    return matched;
  }

  private getLocalIps(): string[] {
    const result: string[] = [];
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
      const netInfo = nets[name];
      if (!netInfo) {
        continue;
      }
      for (const info of netInfo) {
        const family: string | number = (info as any).family;
        const isIpv4 = family === "IPv4" || family === 4;
        if (!isIpv4 || info.internal) {
          continue;
        }
        if (!result.includes(info.address)) {
          result.push(info.address);
        }
      }
    }
    return result;
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

      // Get local resource URIs
      const jqueryUri = this._getLocalResourceUri(
        webview,
        "node_modules",
        "jquery",
        "dist",
        "jquery.min.js"
      );
      const codiconsCssUri = this._getLocalResourceUri(
        webview,
        "node_modules",
        "@vscode",
        "codicons",
        "dist",
        "codicon.css"
      );
      const chatCssUri = this._getLocalResourceUri(
        webview,
        "resources",
        "chat.css"
      );
      const chatJsUri = this._getLocalResourceUri(
        webview,
        "resources",
        "chat.js"
      );

      // Replace placeholders in the HTML file
      html = html
        .replace(/{{cspSource}}/g, cspSource)
        .replace(/{{nonce}}/g, nonce)
        .replace(/{{jqueryUri}}/g, jqueryUri.toString())
        .replace(/{{codiconsCssUri}}/g, codiconsCssUri.toString())
        .replace(/{{chatCssUri}}/g, chatCssUri.toString())
        .replace(/{{chatJsUri}}/g, chatJsUri.toString());

      return html;
    } catch (error) {
      console.error("Error loading HTML file:", error);
      return `<!DOCTYPE html><html><body>Error loading HTML file: ${error}</body></html>`;
    }
  }

  private _getLocalResourceUri(
    webview: vscode.Webview,
    ...pathSegments: string[]
  ): vscode.Uri {
    const uri = vscode.Uri.joinPath(this._extensionUri, ...pathSegments);
    return webview.asWebviewUri(uri);
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

  private async handleLinkMessageReceived(result: {
    ip: string;
    port: number;
    id?: string;
    isReply: boolean;
  }) {
    // 判断收到的来源是否在联系人中，不存在则加入本地列表中
    const existingContact = this._contacts.find(
      (c) =>
        c.ip === result.ip &&
        (c.port || ChatViewProvider.DEFAULT_PORT) ===
          (result.port || ChatViewProvider.DEFAULT_PORT)
    );

    if (existingContact) {
      // 如果联系人已存在，更新 status 为 true（在线）
      this._contacts = await this._store.updateContactStatus(
        result.ip,
        result.port,
        true
      );
    } else if (result.id) {
      // 如果联系人不存在，添加新联系人（status 默认为 false，但收到 LinkMessage 表示在线，所以设为 true）
      let username = `用户_${result.ip}`;
      try {
        const decoded = Buffer.from(result.id, "base64").toString("utf8");
        const parts = decoded.split(":");
        if (parts.length > 0 && parts[0]) {
          username = parts[0];
        }
      } catch {
        // 如果解析失败，使用默认用户名
      }

      const contact: Contact = {
        ip: result.ip,
        port: result.port,
        username: username,
      };
      this._contacts = await this._store.addContact(contact);
      // 收到 LinkMessage 表示在线，更新 status 为 true
      this._contacts = await this._store.updateContactStatus(
        result.ip,
        result.port,
        true
      );
    }

    const webviewView = this._currentWebviewView || this._view;
    if (webviewView) {
      webviewView.webview.postMessage({
        type: "contactsSaved",
        contacts: this._contacts,
      });
    }
  }
}
