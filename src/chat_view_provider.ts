import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { ChatMessage, ChatMessageService } from "./chat_message_service";
import { ChatMessageManager } from "./chat_message_manager";
import {
  ChatDataStore,
  StoredContact,
  StoredUserSettings,
} from "./chat_data_store";
import { ChatContactManager, LinkMessageResult } from "./chat_contact_manager";
import { ChatFileService } from "./chat_file_service";

type UserSettings = StoredUserSettings;
type Contact = StoredContact;

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "lnim.chatView";
  private static readonly DEFAULT_PORT = 18080;

  private _view?: vscode.WebviewView;
  private _currentWebviewView?: vscode.WebviewView;
  private _userSettings: UserSettings;
  private _currentPort: number;
  private readonly _store: ChatDataStore;
  private readonly _messageService: ChatMessageService;
  private readonly _messageManager: ChatMessageManager;
  private readonly _chatFileService: ChatFileService;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _context: vscode.ExtensionContext,
  ) {
    this._store = new ChatDataStore(this._context);
    this._userSettings = this._store.getUserSettings();
    ChatContactManager.init(this._store);
    this._currentPort =
      this._userSettings.port || ChatViewProvider.DEFAULT_PORT;
    this._messageManager = new ChatMessageManager(
      this._context.globalStorageUri.fsPath,
    );
    this._chatFileService = new ChatFileService(
      this._context.globalStorageUri.fsPath,
    );
    this._messageService = new ChatMessageService(this._currentPort, {
      view: this._view,
      defaultPort: ChatViewProvider.DEFAULT_PORT,
      context: this._context,
      fileService: this._chatFileService,
    });
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ) {
    this._view = webviewView;
    this._messageService.attachView(webviewView);
    // 更新回调中的 view 引用
    this._currentWebviewView = webviewView;

    webviewView.webview.options = {
      // Allow scripts in the webview
      enableScripts: true,
      enableCommandUris: true,
      localResourceRoots: [
        this._extensionUri,
        vscode.Uri.joinPath(this._extensionUri, "node_modules"),
      ],
    };

    webviewView.webview.html = this._getHtmlForWebview(
      webviewView.webview,
      "chat",
    );
    webviewView.webview.onDidReceiveMessage(async (data) => {
      switch (data.type) {
        case "navigate": {
          const page = data.page || "chat";
          webviewView.webview.html = this._getHtmlForWebview(
            webviewView.webview,
            page,
          );
          break;
        }
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
        case "getChatHistory": {
          await this.sendChatHistoryToWebview(webviewView.webview);
          break;
        }
        case "getContacts": {
          webviewView.webview.postMessage({
            type: "updateContacts",
            contacts: ChatContactManager.getContacts(),
          });
          break;
        }
        case "getFiles": {
          const files = this._chatFileService.getFiles();
          // 尝试从联系人中获取用户名
          const contacts = ChatContactManager.getContacts();
          const filesWithUsername = files.map((file) => {
            const contact = contacts.find(
              (c) => c.ip === file.ip && c.port === file.port,
            );
            return {
              ...file,
              sender: contact?.username || file.sender,
            };
          });
          webviewView.webview.postMessage({
            type: "updateFiles",
            files: filesWithUsername,
          });
          break;
        }
        case "deleteFile": {
          const file = data.file as { path: string; name: string };
          const answer = await vscode.window.showWarningMessage(
            `确定要删除文件 ${file.name} 吗？此操作不可撤销。`,
            "删除",
            "取消",
          );
          if (answer !== "删除") {
            break;
          }
          const success = await this._chatFileService.deleteFile(file.path);
          if (success) {
            // 刷新文件列表
            const files = this._chatFileService.getFiles();
            const contacts = ChatContactManager.getContacts();
            const filesWithUsername = files.map((f) => {
              const contact = contacts.find(
                (c) => c.ip === f.ip && c.port === f.port,
              );
              return {
                ...f,
                sender: contact?.username || f.sender,
              };
            });
            webviewView.webview.postMessage({
              type: "updateFiles",
              files: filesWithUsername,
            });
          } else {
            vscode.window.showErrorMessage(`删除文件 ${file.name} 失败`);
          }
          break;
        }
        case "openFile": {
          const file = data.file as { path: string; name: string };
          await this._chatFileService.openFile(file.path);
          break;
        }
        case "warning": {
          const warningType = (data as any).warningType;
          if (warningType === "noTargetSelected") {
            vscode.window.showWarningMessage(
              "请先在上方选择至少一个联系人后再发送消息",
            );
          } else if (
            typeof (data as any).message === "string" &&
            (data as any).message
          ) {
            vscode.window.showWarningMessage((data as any).message);
          }
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

          if (
            !targetIp ||
            !portStr ||
            isNaN(targetPort) ||
            targetPort <= 0 ||
            targetPort > 65535
          ) {
            vscode.window.showErrorMessage(
              "主机地址格式必须为 IP:有效端口(1-65535)",
            );
            break;
          }

          vscode.window.setStatusBarMessage(
            `正在向 ${targetIp}:${targetPort} 发送链接检测消息...`,
            2000,
          );

          // 创建临时联系人用于发送扫描消息
          const tempContact: Contact = {
            ip: targetIp,
            port: targetPort,
            username: "",
          };

          // 只负责发送消息，结果在 message 事件处理器中通过回调处理
          this._messageService.sendLinkMessage(tempContact, false);
          break;
        }
        case "getContactsStatus": {
          break;
        }
        case "checkContactLink": {
          const c: Contact = data.contact;
          this._messageService.sendLinkMessage(c, true);
          break;
        }
        case "deleteContact": {
          const c: Contact = data.contact;
          const answer = await vscode.window.showWarningMessage(
            `确定要删除联系人 ${c.username || c.ip} 吗？`,
            "删除",
            "取消",
          );
          if (answer !== "删除") {
            break;
          }
          const contacts = await ChatContactManager.deleteContact(c);
          webviewView.webview.postMessage({
            type: "contactsSaved",
            contacts,
          });
          break;
        }
        case "deleteRecord": {
          const c: Contact = data.contact;
          const answer = await vscode.window.showWarningMessage(
            `确定要清空与 ${c.username || c.ip} 的聊天记录吗？此操作不可撤销。`,
            "清空",
            "取消",
          );
          if (answer !== "清空") {
            break;
          }
          await this._messageService.deleteHistory(c);
          break;
        }
        case "clearAllChatHistory": {
          const answer = await vscode.window.showWarningMessage(
            "确定要清空所有聊天记录吗？此操作不可撤销。",
            "清空所有",
            "取消",
          );
          if (answer !== "清空所有") {
            break;
          }
          await this._messageService.clearAllHistory();
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
          const tagType = item?.type ?? "mention";
          if (tagType === "file") {
            const value: string | undefined = item?.value;
            const wsFolders = vscode.workspace.workspaceFolders;
            let absolutePath = value || "";
            if (
              value &&
              wsFolders &&
              wsFolders.length > 0 &&
              !path.isAbsolute(value)
            ) {
              absolutePath = path.join(wsFolders[0].uri.fsPath, value);
            }
            const from = data.from;
            if (from) {
              const [ip, port, username] = from.split("|");
              this._chatFileService.download(
                { ip, port: parseInt(port), username, path: absolutePath },
                this._messageService,
              );
            }
          } else {
            const label = item?.label ?? item?.value ?? "";
            vscode.window.showInformationMessage(label);
          }
          break;
        }
        case "sendMessage": {
          this.handleSendMessage(data);
          break;
        }
      }
    });
  }

  public async sendPathsToChat(uris: vscode.Uri[]): Promise<void> {
    if (!uris || uris.length === 0) {
      return;
    }
    const webviewView = this._currentWebviewView;
    if (!webviewView) {
      vscode.window.showInformationMessage("请先打开 LNIM Chat 视图");
      return;
    }
    for (const uri of uris) {
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        const type =
          stat.type === vscode.FileType.Directory ? "folder" : "file";
        let value = vscode.workspace.asRelativePath(uri, false);
        if (!value || value === uri.fsPath) {
          value = uri.fsPath;
        }
        value = value.replace(/\\/g, "/");
        const label = path.basename(value);
        webviewView.webview.postMessage({
          type: "insertPathTag",
          item: {
            type,
            value,
            label,
          },
        });
      } catch {
        vscode.window.showErrorMessage(
          `无法发送资源: ${uri.fsPath || uri.toString()}`,
        );
      }
    }
  }

  private async sendChatHistoryToWebview(webview: vscode.Webview) {
    try {
      const records = await this._messageManager.getAllHistory(100, 0);
      webview.postMessage({
        type: "chatHistory",
        history: records,
        selfNickname: this._userSettings.nickname,
      });
    } catch (e) {
      console.error("读取聊天记录失败", e);
    }
  }

  private handleSendMessage(data: ChatMessage) {
    const wsFolders = vscode.workspace.workspaceFolders;
    if (wsFolders && wsFolders.length > 0 && (data as any).files) {
      const root = wsFolders[0].uri.fsPath;
      const originalFiles = (data as any).files as Record<string, string>;
      const normalizedFiles: Record<string, string> = {};
      for (const key of Object.keys(originalFiles)) {
        const value = originalFiles[key];
        if (!value) {
          continue;
        }
        const absolutePath = path.isAbsolute(value)
          ? value
          : path.join(root, value);
        normalizedFiles[key] = absolutePath;
      }
      (data as any).files = normalizedFiles;
    }
    this._messageService.sendChatMessage(data);
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

  private _getHtmlForWebview(webview: vscode.Webview, page: string = "chat") {
    const htmlPath = path.join(
      this._extensionUri.fsPath,
      "resources",
      `${page}.html`,
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
        "jquery.min.js",
      );
      const codiconsCssUri = this._getLocalResourceUri(
        webview,
        "node_modules",
        "@vscode",
        "codicons",
        "dist",
        "codicon.css",
      );
      const chatCssUri = this._getLocalResourceUri(
        webview,
        "resources",
        "chat.css",
      );
      const chatJsUri = this._getLocalResourceUri(
        webview,
        "resources",
        "chat.js",
      );
      const settingsJsUri = this._getLocalResourceUri(
        webview,
        "resources",
        "settings.js",
      );
      const contactsJsUri = this._getLocalResourceUri(
        webview,
        "resources",
        "contacts.js",
      );
      const filesJsUri = this._getLocalResourceUri(
        webview,
        "resources",
        "files.js",
      );

      // Replace placeholders in the HTML file
      html = html
        .replace(/{{cspSource}}/g, cspSource)
        .replace(/{{nonce}}/g, nonce)
        .replace(/{{jqueryUri}}/g, jqueryUri.toString())
        .replace(/{{codiconsCssUri}}/g, codiconsCssUri.toString())
        .replace(/{{chatCssUri}}/g, chatCssUri.toString())
        .replace(/{{chatJsUri}}/g, chatJsUri.toString())
        .replace(/{{settingsJsUri}}/g, settingsJsUri.toString())
        .replace(/{{contactsJsUri}}/g, contactsJsUri.toString())
        .replace(/{{filesJsUri}}/g, filesJsUri.toString());

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

  /**
   * 清理资源
   */
  public dispose(): void {
    if (this._messageService) {
      this._messageService.dispose();
    }
  }
}
