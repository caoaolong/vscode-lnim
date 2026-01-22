import * as net from "net";
import * as vscode from "vscode";
import * as fs from "fs";
import * as crypto from "crypto";
import { ChatMessageManager, ChatContact } from "./chat_message_manager";
import { ChatFileMetadata, ChatFileService } from "./chat_file_service";
import { ChatContactManager } from "./chat_contact_manager";

export interface ChatUserSettings {
  nickname: string;
  ip: string;
  port: number;
}

export interface ChatFileChunk {
  index: number;
  size: number;
  data: Buffer;
  total?: number;
}

export interface ChatMessage {
  type: "chat" | "link" | "chunk" | "file_received" | "file" | "fstats";
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
  private connections: Map<string, net.Socket> = new Map();
  private currentPort: number;
  private readonly defaultPort: number;
  private view?: vscode.WebviewView;
  private readonly getSelfId?: () => string;
  private readonly messageManager?: ChatMessageManager;
  private readonly fileService: ChatFileService;
  private readonly settings: ChatUserSettings;
  // 文件发送会话管理
  private fileSendSessions = new Map<
    string,
    {
      filePath: string;
      fd: number;
      chunkCount: number;
      targetIp: string;
      targetPort: number;
    }
  >();

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

  public selfId(): string {
    return Buffer.from(`${this.settings.nickname}-${Date.now()}`).toString("base64");
  }

  public dispose(): void {
    // 清理所有发送会话
    for (const [sessionId, session] of this.fileSendSessions.entries()) {
      try {
        fs.closeSync(session.fd);
      } catch (error) {
        console.error(`关闭文件句柄失败 ${sessionId}:`, error);
      }
    }
    this.fileSendSessions.clear();

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
    this.updateServerStatus(this.isServerRunning);
  }

  public getPort(): number {
    return this.currentPort;
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

  /**
   * 发送消息（不需要确认）
   */
  private sendMessage(message: ChatMessage, ip: string, port: number): void {
    if (!this.tcpServer) {
      return;
    }
    const id = this.socketId({
      remoteAddress: ip,
      remotePort: port,
    } as net.Socket);
    if (this.connections.has(id)) {
      this.connections.get(id)?.write(JSON.stringify(message));
    }
  }

  /**
   * 请求下载文件（发送chunk请求）
   */
  public sendFileRequest(file: ChatFileMetadata): string {
    // 生成16字节（16个字符）的随机字符串
    const uuid = crypto.randomBytes(8).toString("hex");
    this.sendMessage({
      type: "file",
      from: this.selfId(),
      timestamp: Date.now(),
      value: file.path,
      unique: uuid,
    }, file.ip, file.port);
    return uuid;
  }

  public sendChatMessage(message: ChatMessage) {
    if (!this.getSelfId) {
      return;
    }
    const selfId = this.getSelfId();
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
          from: selfId,
          timestamp,
          value: message.value,
          target: message.target,
          files: message.files,
        },
        ip,
        targetPort,
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

  public sendLinkMessage(contact: ChatContact, showError: boolean = false) {
    // if (!contact || !contact.ip) {
    //   if (showError) {
    //     vscode.window.showErrorMessage(
    //       "无法发送链接检测消息：目标或本地 UDP 服务无效",
    //     );
    //   }
    //   return;
    // }
    // const targetPort =
    //   contact.port && contact.port > 0 && contact.port <= 65535
    //     ? contact.port
    //     : this.defaultPort;

    // const fromId = this.getSelfId ? this.getSelfId() : "";

    // this.sendMessage(
    //   {
    //     type: "link",
    //     from: fromId,
    //     timestamp: Date.now(),
    //     isReply: false, // 主动发送的link消息，不是回复
    //   },
    //   contact.ip,
    //   targetPort,
    // );
  }

  /**
   * 发送文件接收完成确认
   */
  public sendFileReceivedConfirm(
    filePath: string,
    sessionId: string,
    ip: string,
    port: number,
  ): void {
    // if (!this.getSelfId) {
    //   console.error(`[sendFileReceivedConfirm] getSelfId为空`);
    //   return;
    // }

    // console.log(
    //   `[sendFileReceivedConfirm] 发送文件接收完成确认 - sessionId: ${sessionId}, to: ${ip}:${port}`,
    // );

    // this.sendMessage(
    //   {
    //     type: "file_received",
    //     from: this.getSelfId(),
    //     timestamp: Date.now(),
    //     sessionId,
    //     value: filePath,
    //   },
    //   ip,
    //   port,
    // );

    // console.log(`[sendFileReceivedConfirm] 确认消息已发送`);
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
      this.updateServerStatus(false);
      vscode.window.showErrorMessage(`TCP Server error: ${err.message}`);
    });
    // 服务器状态
    this.tcpServer.on("close", () => this.updateServerStatus(false));
    this.tcpServer.listen(port, "0.0.0.0", () => this.updateServerStatus(true));
  }

  private updateServerStatus(isRunning: boolean) {
    this.isServerRunning = isRunning;
    if (this.view) {
      this.view.webview.postMessage({
        type: "updateUserStatus",
        isOnline: isRunning,
      });
    }
  }

  private handleMessage(socket: net.Socket) {
    const id = this.socketId(socket);
    this.connections.set(id, socket);
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
    if (msg.type === "chunk") {
      this.handleChunkMessage(msg);
    } else if (msg.type === "file_received") {
      this.handleFileReceived(msg);
    } else if (msg.type === "fstats") {
      this.handleStatsMessage(socket, msg);
    } else if (msg.type === "link") {
      if (socket.remoteAddress && socket.remotePort) {
        ChatContactManager.handleLinkMessage({
          ip: socket.remoteAddress,
          port: socket.remotePort,
          nickname: this.nickname(msg.from),
        }).then((contacts) => {
          if (contacts && this.view) {
            this.view.webview.postMessage({
              type: "updateContacts",
              contacts: contacts,
            });
          }
        });
      }
    } else if (msg.type === "chat") {
      this.handleChatMessage(socket, msg);
    } else if (msg.type === "file") {
      console.log(msg);
    }
  }
  handleStatsMessage(socket: net.Socket, msg: ChatMessage) {
    this.fileService.updateSession(msg);
  }

  private handleOfflineMessage(socket: net.Socket) {
    const id = this.socketId(socket);
    this.connections.delete(id);
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

  /**
   * 处理chunk消息
   */
  private async handleChunkMessage(payload: ChatMessage) {
    // const data = payload as ChatMessage;
    // // 如果有chunk数据，说明是发送chunk
    // if (data.chunk && typeof data.chunk.index === 'number') {
    //   console.log(`[handleChunkMessage] 收到chunk - index: ${data.chunk.index}, size: ${data.chunk.size}, total: ${data.chunk.total}, sessionId: ${data.sessionId}`);
    //   this.fileService.saveChunk(data.value, data.chunk, rinfo.address, rinfo.port, data.sessionId);
    //   return;
    // }
    // // 否则是请求chunk（文件下载请求）
    // const filePath = typeof data.value === "string" ? data.value : "";
    // const requestChunks = data.requestChunks;
    // console.log(`[handleChunkMessage] 收到chunk请求 - filePath: ${filePath}, requestChunks: ${requestChunks ? requestChunks.length : 'all'}`);
    // if (!filePath) {
    //   console.error("收到chunk请求，但文件路径为空");
    //   return;
    // }
    // if (!fs.existsSync(filePath)) {
    //   console.error(`收到chunk请求，但文件不存在: ${filePath}`);
    //   return;
    // }
    // try {
    //   const stat = fs.statSync(filePath);
    //   if (!stat.isFile()) {
    //     console.error(`路径不是文件: ${filePath}`);
    //     return;
    //   }
    //   const chunkCount = Math.ceil(stat.size / this.chunkSize);
    //   const fd = fs.openSync(filePath, "r");
    //   // 创建或查找发送会话
    //   const sessionId = data.sessionId || `${rinfo.address}_${rinfo.port}_${filePath}_${Date.now()}`;
    //   console.log(`[handleChunkMessage] 准备发送文件 - sessionId: ${sessionId}, chunkCount: ${chunkCount}, fileSize: ${stat.size}`);
    //   let session = this.fileSendSessions.get(sessionId);
    //   if (!session) {
    //     session = {
    //       filePath,
    //       fd,
    //       chunkCount,
    //       targetIp: rinfo.address,
    //       targetPort: rinfo.port,
    //     };
    //     this.fileSendSessions.set(sessionId, session);
    //     console.log(`[handleChunkMessage] 创建新的发送会话: ${sessionId}`);
    //   } else {
    //     console.log(`[handleChunkMessage] 使用现有发送会话: ${sessionId}`);
    //   }
    //   // 确定要发送的chunk列表
    //   const chunksToSend = requestChunks || Array.from({ length: chunkCount }, (_, i) => i);
    //   console.log(`[handleChunkMessage] 将发送 ${chunksToSend.length} 个chunk`);
    //   // 异步发送chunk，避免UDP缓冲区溢出
    //   this.sendChunksWithDelay(fd, filePath, sessionId, chunksToSend, chunkCount, rinfo.address, rinfo.port);
    //   if (!requestChunks) {
    //     vscode.window.showInformationMessage(
    //       `正在向 ${rinfo.address}:${rinfo.port} 发送文件: ${filePath.split('/').pop()} (${chunkCount} 块)`
    //     );
    //   }
    // } catch (error) {
    //   console.error("处理chunk请求时出错:", error);
    // }
  }

  /**
   * 处理文件接收完成确认
   */
  private handleFileReceived(payload: ChatMessage) {
    // const msg = payload as ChatMessage;
    // console.log(`[handleFileReceived] 收到文件接收完成确认 - sessionId: ${msg.sessionId}, from: ${rinfo.address}:${rinfo.port}`);
    // if (!msg.sessionId) {
    //   console.error(`[handleFileReceived] sessionId为空`);
    //   return;
    // }
    // // 清理发送会话
    // const session = this.fileSendSessions.get(msg.sessionId);
    // if (session) {
    //   console.log(`[handleFileReceived] 找到发送会话，准备清理 - sessionId: ${msg.sessionId}, filePath: ${session.filePath}`);
    //   try {
    //     fs.closeSync(session.fd);
    //     console.log(`[handleFileReceived] 文件句柄已关闭`);
    //   } catch (error) {
    //     console.error('[handleFileReceived] 关闭文件句柄失败:', error);
    //   }
    //   this.fileSendSessions.delete(msg.sessionId);
    //   console.log(`[handleFileReceived] 发送会话已删除，剩余会话数: ${this.fileSendSessions.size}`);
    //   vscode.window.showInformationMessage(
    //     `文件发送完成: ${session.filePath.split('/').pop()}`
    //   );
    // } else {
    //   console.warn(`[handleFileReceived] 未找到发送会话: ${msg.sessionId}`);
    // }
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
