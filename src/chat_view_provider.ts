import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as dgram from "dgram";
import * as os from "os";
import { LinkMessage } from "./lnim_message";

interface UserSettings {
  nickname: string;
  ip: string;
  port: number;
}
interface Contact {
  ip: string;
  port?: number;
  username: string;
  status?: boolean;
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
  private udpServer?: dgram.Socket;

  public static readonly viewType = "lnim.chatView";
  private static readonly DEFAULT_PORT = 18080;

  private _view?: vscode.WebviewView;
  private _userSettings: UserSettings;
  private _contacts: Contact[];
  private _currentPort: number;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _context: vscode.ExtensionContext
  ) {
    this._userSettings = this._context.globalState.get<UserSettings>(
      "userSettings",
      {
        nickname: "User",
        ip: "",
        port: ChatViewProvider.DEFAULT_PORT,
      }
    );
    if (
      !this._userSettings.port ||
      this._userSettings.port <= 0 ||
      this._userSettings.port > 65535
    ) {
      this._userSettings.port = ChatViewProvider.DEFAULT_PORT;
    }
    this._currentPort = this._userSettings.port;
    this._contacts = this._context.globalState.get<Contact[]>("contacts", []);
    this.startUdpServer();
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

    webviewView.webview.options = {
      // Allow scripts in the webview
      enableScripts: true,

      localResourceRoots: [this._extensionUri],
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (data) => {
      switch (data.type) {
        case "saveSettings": {
          const incoming = data.settings as UserSettings;
          let port = incoming.port;
          if (!port || port <= 0 || port > 65535) {
            port = ChatViewProvider.DEFAULT_PORT;
          }
          this._userSettings = {
            nickname: incoming.nickname || "User",
            ip: incoming.ip || "",
            port,
          };
          await this._context.globalState.update(
            "userSettings",
            this._userSettings
          );
          if (port !== this._currentPort) {
            this.restartUdpServer(port);
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
          console.log(this._contacts);
          webviewView.webview.postMessage({
            type: "updateContacts",
            contacts: this._contacts,
          });
          break;
        }
        case "getContactsStatus": {
          const reqList: Contact[] = Array.isArray(data.contacts)
            ? data.contacts
            : this._contacts;
          const statuses = await Promise.all(
            reqList.map(async (c) => {
              const online = await this.checkContactOnline(c);
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
        case "addContact": {
          const c: Contact = data.contact;
          if (c?.ip && c?.username) {
            const exists = this._contacts.some(
              (x) =>
                x.ip === c.ip &&
                (x.port || ChatViewProvider.DEFAULT_PORT) ===
                  (c.port || ChatViewProvider.DEFAULT_PORT) &&
                x.username === c.username
            );
            if (!exists) {
              this._contacts.push(c);
              await this._context.globalState.update(
                "contacts",
                this._contacts
              );
            }
          }
          webviewView.webview.postMessage({
            type: "contactsSaved",
            contacts: this._contacts,
          });
          break;
        }
        case "checkContactLink": {
          const c: Contact = data.contact;
          if (!c || !c.ip || !this.udpServer) {
            vscode.window.showErrorMessage("无法发送 LinkMessage：目标或本地 UDP 服务无效");
            break;
          }
          const targetPort =
            c.port && c.port > 0 && c.port <= 65535
              ? c.port
              : ChatViewProvider.DEFAULT_PORT;
          const payload: LinkMessage = {
            type: "link",
            from: this.id(),
          };
          const buf = Buffer.from(JSON.stringify(payload), "utf8");
          this.udpServer.send(buf, targetPort, c.ip, (err) => {
            if (err) {
              console.error("Failed to send LinkMessage:", err);
              vscode.window.showErrorMessage(
                `向 ${c.username}(${c.ip}:${targetPort}) 发送 LinkMessage 失败：${String(
                  err
                )}`
              );
            } else {
              vscode.window.showInformationMessage(
                `已向 ${c.username}(${c.ip}:${targetPort}) 发送 LinkMessage`
              );
            }
          });
          break;
        }
        case "deleteContact": {
          const c: Contact = data.contact;
          this._contacts = this._contacts.filter(
            (x) =>
              !(
                x.ip === c?.ip &&
                (x.port || ChatViewProvider.DEFAULT_PORT) ===
                  (c.port || ChatViewProvider.DEFAULT_PORT) &&
                x.username === c?.username
              )
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

  private startUdpServer(port?: number) {
    try {
      const targetPort =
        port ||
        this._currentPort ||
        this._userSettings.port ||
        ChatViewProvider.DEFAULT_PORT;
      this.udpServer = dgram.createSocket("udp4");
      this.udpServer.on("message", (data, rinfo) => {
        try {
          const text = data.toString();
          const payload = JSON.parse(text);
          if (payload && payload.type === "ping") {
            const buf = Buffer.from(JSON.stringify({ type: "pong" }), "utf8");
            this.udpServer?.send(buf, rinfo.port, rinfo.address);
            return;
          }
          if (payload && payload.type === "chat") {
            const from = payload.from;
            const message = payload.message;
            console.log(
              "Received message:",
              message,
              "from:",
              from.nickname || from
            );
            if (this._view) {
              this._view.webview.postMessage({
                type: "receiveMessage",
                from,
                message,
                timestamp: Date.now(),
              });
            }
          }
        } catch (e) {
          console.error("Failed to handle incoming UDP message:", e);
        }
      });
      this.udpServer.on("error", (err) => {
        console.error("UDP server error:", err);
        vscode.window.showErrorMessage(`UDP 服务异常：${String(err)}`);
      });
      this.udpServer.bind(targetPort, () => {
        this._currentPort = targetPort;
        console.log(`UDP server listening on port ${targetPort}`);
      });
    } catch (e) {
      console.error("Failed to start UDP server:", e);
      vscode.window.showErrorMessage("无法启动 UDP 服务");
    }
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
    const payload = JSON.stringify({
      type: "chat",
      from: this._userSettings,
      message: msg,
    });
    const buf = Buffer.from(payload, "utf8");
    if (!this.udpServer) {
      vscode.window.showErrorMessage("UDP 服务未启动，无法发送消息");
      return;
    }
    for (const c of contacts) {
      const targetPort =
        c.port && c.port > 0 && c.port <= 65535
          ? c.port
          : ChatViewProvider.DEFAULT_PORT;
      this.udpServer.send(buf, targetPort, c.ip, (err) => {
        if (err) {
          console.error("Failed to send UDP message:", err);
          vscode.window.showErrorMessage(
            `向 ${c.username}(${c.ip}) 发送消息失败：${String(err)}`
          );
        }
      });
    }
    console.log(
      "Sent message:",
      msg,
      "contacts:",
      contacts.map((c) => `${c.username}(${c.ip})`)
    );
  }

  private async checkContactOnline(contact: Contact): Promise<boolean> {
    if (!contact || !contact.ip) {
      return false;
    }
    return new Promise<boolean>((resolve) => {
      let resolved = false;
      const socket = dgram.createSocket("udp4");
      const timeout = setTimeout(() => {
        if (resolved) {
          return;
        }
        resolved = true;
        socket.close();
        resolve(false);
      }, 1500);
      try {
        socket.on("message", () => {
          if (resolved) {
            return;
          }
          resolved = true;
          clearTimeout(timeout);
          socket.close();
          resolve(true);
        });
        socket.on("error", () => {
          if (resolved) {
            return;
          }
          resolved = true;
          clearTimeout(timeout);
          socket.close();
          resolve(false);
        });
        socket.bind(0, () => {
          const payload = JSON.stringify({ type: "ping" });
          const buf = Buffer.from(payload, "utf8");
          const targetPort =
            contact.port && contact.port > 0 && contact.port <= 65535
              ? contact.port
              : ChatViewProvider.DEFAULT_PORT;
          socket.send(buf, targetPort, contact.ip, (err) => {
            if (err && !resolved) {
              resolved = true;
              clearTimeout(timeout);
              socket.close();
              resolve(false);
            }
          });
        });
      } catch (e) {
        clearTimeout(timeout);
        socket.close();
        resolve(false);
        return;
      }
    });
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

  private restartUdpServer(port: number) {
    if (this.udpServer) {
      try {
        this.udpServer.close();
      } catch {}
      this.udpServer = undefined;
    }
    this._currentPort = port;
    this.startUdpServer(port);
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
