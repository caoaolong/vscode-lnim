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
  private readonly settings: ChatUserSettings;

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

  // private createClient(ip: string, port: number, nickname: string, socket: net.Socket): void {
  //   this.clients.set(ip, {
  //     ip: ip, port: port, username: nickname, socket: socket
  //   } as Client)
  // }

  public selfId(): string {
    return Buffer.from(`${this.settings.nickname}-${this.settings.ip}:${this.settings.port}`).toString(
      "base64",
    );
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
      } catch { }
      this.tcpServer = undefined;
    }
    this.currentPort = port || this.defaultPort;
    this.startTcpServer(this.currentPort);
  }

  connectToServer(ip: string, port: number): void {
    // 连接并发送LinkMessage
    const socket = net.connect(port, ip, () => {
      socket.write(JSON.stringify({
        type: "link",
        from: this.selfId(),
        timestamp: Date.now(),
      } as ChatMessage));
    });
    // 设置输出链接
    this.clients.set(ip, {
      out: {
        port: port, socket: socket
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
        from: this.selfId(),
        timestamp: Date.now(),
        value: file.path,
        unique: uuid,
        fd: file.fd,
      },
      file.ip
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
          from: this.selfId(),
          timestamp,
          value: message.value,
          target: message.target,
          files: message.files,
        },
        ip
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

  private socketId(socket: net.Socket): string {
    return Buffer.from(`${socket.remoteAddress}:${socket.remotePort}`).toString(
      "base64",
    );
  }

  private nickname(from: string): string {
    return Buffer.from(from, "base64").toString("utf8").split("-")[0];
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
    // 通知所有联系人上线
    this.notifyAllContactsOnline(this.selfId());
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
          contact.ip
        );
      }
    }
  }

  private handleMessage(socket: net.Socket) {
    // 设置连接
    if (socket.remoteAddress && socket.remotePort) {
      this.clients.set(socket.remoteAddress, {
        in: {
          port: socket.remotePort,
          socket: socket
        } as Connection,
      })
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
      if (socket.remoteAddress && socket.remotePort) {
        const client = this.clients.get(socket.remoteAddress);
        if (client && !client.out) {
          client.nickname = nickname;
          client.out = {
            port: socket.remotePort,
            socket: socket
          } as Connection;
        }
        ChatContactManager.handleLinkMessage({
          ip: socket.remoteAddress,
          port: socket.remotePort,
          nickname: nickname,
        }).then((contacts) => {
          if (contacts && this.view) {
            this.view.webview.postMessage({
              type: "updateContacts",
              contacts: contacts,
            });
          }
        });
        socket.write(JSON.stringify({
          type: "link",
          from: this.selfId(),
          timestamp: Date.now(),
        } as ChatMessage));
      }
    } else if (msg.type === "chat") {
      this.handleChatMessage(socket, msg);
    } else if (msg.type === "file") {
      this.fileService.handleFileRequest(socket, msg, this.selfId());
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
    if (this.messageManager && socket.remoteAddress && socket.remotePort) {
      this.messageManager.saveIncoming(
        {
          nickname: username,
          ip: socket.remoteAddress,
          port: socket.remotePort,
        },
        msg.value || "",
        msg.timestamp,
      );
    }
    if (this.view) {
      this.view.webview.postMessage({
        type: "receiveMessage",
        from: username,
        fromIp: socket.remoteAddress,
        fromPort: socket.remotePort,
        message: msg.value || "",
        files: msg.files || [],
        timestamp: msg.timestamp,
      });
    }
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
    const peerPort =
      contact.port && contact.port > 0 && contact.port <= 65535
        ? contact.port
        : this.defaultPort;
    const peerUsername = contact.username || "";
    const peerKey = `${peerIp}|${peerPort}|${peerUsername}`;

    await this.messageManager.deleteHistory(peerKey);
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
