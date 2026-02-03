import * as net from "net";
import * as vscode from "vscode";
import * as crypto from "crypto";
import { ChatMessageManager, ChatContact } from "./chat_message_manager";
import { ChatFileMetadata, ChatFileService } from "./chat_file_service";
import { ChatContactManager } from "./chat_contact_manager";

export interface Connection {
  port: number;
  socket: net.Socket;
}

export interface Client {
  in?: Connection;
  out?: Connection;
  nickname?: string;
}

export interface ChatUserSettings {
  nickname: string;
  ip: string;
  port: number;
}

export interface ChatMessage {
  type: "chat" | "link" | "file" | "fstats" | "fend";
  from: string;
  timestamp: number;
  // type=chat时，表示消息内容
  // type=chunk时，表示文件路径
  value?: string;
  target?: string[];
  files?: string[];
  // 记录某个大块数据的唯一ID
  unique?: string;
  // 文件数据块
  data?: Buffer;
  // 文件句柄
  fd?: number;
}

export interface ChatMessageServiceOptions {
  view?: vscode.WebviewView;
  defaultPort: number;
  fileService: ChatFileService;
  context: vscode.ExtensionContext;
  settings: ChatUserSettings;
}

export class ChatMessageService {
  public isServerRunning: boolean = false;

  private tcpServer?: net.Server;
  // IP: Client
  private clients: Map<string, Client> = new Map();
  private currentPort: number;
  private readonly defaultPort: number;
  private view?: vscode.WebviewView;
  private readonly messageManager?: ChatMessageManager;
  private readonly fileService: ChatFileService;
  private settings: ChatUserSettings;

  constructor(port: number, options: ChatMessageServiceOptions) {
    this.currentPort = port || options.defaultPort;
    this.defaultPort = options.defaultPort;
    this.view = options.view;
    this.fileService = options.fileService;
    this.messageManager = new ChatMessageManager(
      options.context.globalStorageUri.fsPath,
    );
    this.settings = options.settings;
    this.startTcpServer(this.currentPort);
  }

  /**
   * 更新设置，确保 selfId() 每次调用时都能读取到最新的 settings
   */
  public updateSettings(settings: ChatUserSettings): void {
    this.settings = settings;
  }

  public self(): string {
    return Buffer.from(
      `${this.settings.nickname}-${this.settings.ip}:${this.settings.port}`,
    ).toString("base64");
  }

  public dispose(): void {
    if (this.fileService) {
      this.fileService.dispose();
    }

    if (this.tcpServer) {
      this.tcpServer.close();
    }
  }

  public attachView(view: vscode.WebviewView) {
    this.view = view;
    // 立即发送当前服务器状态
    this.handleServerOnline(this.isServerRunning);
  }

  public restart(port: number) {
    if (this.tcpServer) {
      try {
        this.tcpServer.close();
      } catch {}
      this.tcpServer = undefined;
    }
    this.currentPort = port || this.defaultPort;
    this.startTcpServer(this.currentPort);
  }

  connectToServer(ip: string, port: number): void {
    // 连接并发送LinkMessage
    const socket = net.connect(port, ip, () => {
      socket.write(
        JSON.stringify({
          type: "link",
          from: this.self(),
          timestamp: Date.now(),
        } as ChatMessage),
      );
    });
    // 设置输出链接
    this.clients.set(ip, {
      out: {
        port: port,
        socket: socket,
      } as Connection,
    });
    socket.on("data", (buffer) => {
      const data = JSON.parse(buffer.toString("utf8")) as ChatMessage;
      if (data.type === "link") {
        const nickname = this.nickname(data.from);
        ChatContactManager.handleLinkMessage({
          ip: ip,
          port: port,
          nickname: nickname,
        }).then((contacts) => {
          // 更新连接
          const client = this.clients.get(ip);
          if (client && client.out) {
            client.nickname = nickname;
          }
          if (contacts && this.view) {
            this.view.webview.postMessage({
              type: "updateContacts",
              contacts: contacts,
            });
          }
        });
      }
    });
  }

  /**
   * 发送消息（不需要确认）
   */
  private sendMessage(message: ChatMessage, ip: string): void {
    if (!this.tcpServer) {
      return;
    }
    if (this.clients.has(ip)) {
      const client = this.clients.get(ip);
      if (client && client.out) {
        client.out.socket.write(JSON.stringify(message));
      }
    }
  }

  /**
   * 请求下载文件（发送chunk请求）
   */
  public sendFileRequest(file: ChatFileMetadata) {
    // 生成16字节（16个字符）的随机字符串
    const uuid = crypto.randomBytes(8).toString("hex");
    this.sendMessage(
      {
        type: "file",
        from: this.self(),
        timestamp: Date.now(),
        value: file.path,
        unique: uuid,
        fd: file.fd,
      },
      file.ip,
    );
  }

  public sendChatMessage(message: ChatMessage) {
    const timestamp = message.timestamp || Date.now();
    for (const c of message.target || []) {
      const parts = c.split(":");
      const ip = parts[0] || "";
      const portValue = parts[1] ? parseInt(parts[1], 10) : this.defaultPort;
      const targetPort =
        portValue && portValue > 0 && portValue <= 65535
          ? portValue
          : this.defaultPort;
      if (!ip) {
        continue;
      }

      this.sendMessage(
        {
          type: "chat",
          from: this.self(),
          timestamp,
          value: message.value,
          target: message.target,
          files: message.files,
        },
        ip,
      );

      // 保存消息到历史记录
      if (this.messageManager) {
        const contact: ChatContact = {
          ip,
          port: targetPort,
          username: ip,
        };
        this.messageManager.saveOutgoing(
          contact,
          message.value || "",
          timestamp,
          this.defaultPort,
        );
      }
    }
  }

  private nickname(from: string): string {
    return Buffer.from(from, "base64").toString("utf8").split("-")[0];
  }

  private address(from: string): string {
    return Buffer.from(from, "base64").toString("utf8").split("-")[1];
  }

  private startTcpServer(port: number) {
    this.tcpServer = net.createServer((socket) => this.handleMessage(socket));

    this.tcpServer.on("error", (err) => {
      this.handleServerOnline(false);
      vscode.window.showErrorMessage(`TCP Server error: ${err.message}`);
    });
    // 服务器状态
    this.tcpServer.on("close", () => this.handleServerOnline(false));
    this.tcpServer.listen(port, "0.0.0.0", () => this.handleServerOnline(true));
  }

  private handleServerOnline(isRunning: boolean) {
    // 先将所有联系人设为离线，再向所有人发 LinkMessage；收到对方 Link 后再改为在线
    ChatContactManager.setAllContactsOffline().then((contacts) => {
      if (this.view) {
        this.view.webview.postMessage({
          type: "updateContacts",
          contacts,
        });
      }
      this.notifyAllContactsOnline(this.self());
    });
    // 更新自身服务器状态
    this.isServerRunning = isRunning;
    if (this.view) {
      this.view.webview.postMessage({
        type: "updateUserStatus",
        isOnline: isRunning,
      });
    }
  }
  private notifyAllContactsOnline(from: string) {
    for (const contact of ChatContactManager.getContacts()) {
      if (contact.ip && contact.port) {
        this.sendMessage(
          {
            type: "link",
            from: from,
            timestamp: Date.now(),
          },
          contact.ip,
        );
      }
    }
  }

  private handleMessage(socket: net.Socket) {
    // 创建输入连接
    if (socket.remoteAddress && socket.remotePort) {
      const client = this.clients.get(socket.remoteAddress);
      if (client && !client.in) {
        client.in = {
          port: socket.remotePort,
          socket: socket,
        } as Connection;
      } else {
        this.clients.set(socket.remoteAddress, {
          in: {
            port: socket.remotePort,
            socket: socket,
          } as Connection,
        });
      }
    }
    // 接收到消息
    socket.on("data", (buffer) => {
      try {
        const data = JSON.parse(buffer.toString("utf8")) as ChatMessage;
        this.handleDataMessage(socket, data);
      } catch (error) {
        // uuid是16个字符的hex字符串，编码为8字节的二进制Buffer
        const fpId = buffer.subarray(0, 8).toString("hex");
        const fpData = buffer.subarray(8);
        this.fileService.saveChunk(fpId, fpData);
      }
    });
    // 接收到离线消息
    socket.on("end", () => this.handleOfflineMessage(socket));
    socket.on("close", () => this.handleOfflineMessage(socket));
    // 接收到错误消息
    socket.on("error", (err) => {
      vscode.window.showErrorMessage(
        `[LNIM]: TCP Server error: ${err.message}`,
      );
    });
  }

  private handleDataMessage(socket: net.Socket, msg: ChatMessage) {
    if (msg.type === "fend") {
      this.fileService.closeSession(msg);
    } else if (msg.type === "fstats") {
      this.fileService.createSession(msg);
    } else if (msg.type === "link") {
      const nickname = this.nickname(msg.from);
      const [ip, port] = this.address(msg.from).split(":");
      const client = this.clients.get(ip);
      if (client && !client.out) {
        client.nickname = nickname;
        client.out = {
          port: parseInt(port, 10),
          socket: net.connect(parseInt(port, 10), ip),
        } as Connection;
      }
      ChatContactManager.handleLinkMessage({
        ip: ip,
        port: parseInt(port, 10),
        nickname: nickname,
      }).then((contacts) => {
        if (contacts && this.view) {
          this.view.webview.postMessage({
            type: "updateContacts",
            contacts: contacts,
          });
        }
      });
      socket.write(
        JSON.stringify({
          type: "link",
          from: this.self(),
          timestamp: Date.now(),
        } as ChatMessage),
      );
    } else if (msg.type === "chat") {
      this.handleChatMessage(socket, msg);
    } else if (msg.type === "file") {
      this.fileService.handleFileRequest(socket, msg, this.self());
    }
  }

  private handleOfflineMessage(socket: net.Socket) {
    if (socket.remoteAddress) {
      this.clients.delete(socket.remoteAddress);
    }
    // TCP连接断开时，删除对应的联系人（标记为离线）
    if (socket.remoteAddress && socket.remotePort) {
      ChatContactManager.updateContact(
        socket.remoteAddress,
        socket.remotePort,
        {
          status: false,
        },
      ).then((contacts) => {
        this.view?.webview.postMessage({
          type: "updateContacts",
          contacts: contacts,
        });
      });
    }
  }

  private handleChatMessage(socket: net.Socket, msg: ChatMessage) {
    const decoded = Buffer.from(msg.from, "base64").toString("utf8");
    const parts = decoded.split("-");
    const username = parts[0];
    // 规范化为与发送展示一致的格式：value 用 {#path}，files 用路径数组，便于前端 renderMessageContent 正确显示
    const { displayValue, filesArray } = this.normalizeReceivedChatForDisplay(
      msg.value || "",
      msg.files,
    );
    if (this.messageManager && socket.remoteAddress && socket.remotePort) {
      this.messageManager.saveIncoming(
        {
          nickname: username,
          ip: socket.remoteAddress,
          port: socket.remotePort,
        },
        displayValue,
        msg.timestamp,
      );
    }
    if (this.view) {
      this.view.webview.postMessage({
        type: "receiveMessage",
        from: username,
        fromIp: socket.remoteAddress,
        fromPort: socket.remotePort,
        message: displayValue,
        files: filesArray,
        timestamp: msg.timestamp,
      });
    }
  }

  /**
   * 将收到的 chat 消息规范化为与发送时展示一致的格式：
   * - value 中 &lt;file1&gt; 等占位符替换为 {#path}，与前端 renderMessageContent 的 /\{#([^}]+)\}/g 一致
   * - files 统一为路径数组 string[]，与发送侧展示用的 files 格式一致
   */
  private normalizeReceivedChatForDisplay(
    value: string,
    files: string[] | Record<string, string> | undefined,
  ): { displayValue: string; filesArray: string[] } {
    let filesArray: string[] = [];
    if (Array.isArray(files)) {
      filesArray = files;
    } else if (files && typeof files === "object") {
      const keys = Object.keys(files).sort();
      filesArray = keys
        .map((k) => (files as Record<string, string>)[k])
        .filter(Boolean);
    }
    // 将 <file1>、<file2> 等占位符替换为 {#path}，与发送侧展示格式一致
    const displayValue = value.replace(/<file(\d+)>/g, (_, n) => {
      const idx = parseInt(n, 10) - 1;
      const path = filesArray[idx];
      return path !== null ? `{#${path}}` : `<file${n}>`;
    });
    return { displayValue, filesArray };
  }

  public async deleteHistory(contact: {
    ip: string;
    port?: number;
    username?: string;
  }) {
    if (!this.messageManager) {
      return;
    }
    const peerIp = contact.ip || "";
    const peerUsername = contact.username || "";
    const peerPort =
      contact.port && contact.port > 0 && contact.port <= 65535
        ? contact.port
        : this.defaultPort;
    const peerKeyWithPort = `${peerIp}|${peerPort}|${peerUsername}`;
    const peerKeyEmptyPort = `${peerIp}||${peerUsername}`;

    await this.messageManager.deleteHistory(peerKeyWithPort);
    if (peerKeyEmptyPort !== peerKeyWithPort) {
      await this.messageManager.deleteHistory(peerKeyEmptyPort);
    }
  }

  public async clearAllHistory() {
    if (!this.messageManager) {
      return;
    }
    await this.messageManager.clearAllHistory();
  }

  /**
   * 通知UI更新文件列表
   */
  public notifyFilesUpdated(files: any[]): void {
    if (this.view) {
      this.view.webview.postMessage({
        type: "updateFiles",
        files: files,
      });
    }
  }
}
