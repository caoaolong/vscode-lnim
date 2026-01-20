import * as dgram from "dgram";
import * as vscode from "vscode";
import * as fs from "fs";
import { ChatMessageManager, ChatContact } from "./chat_message_manager";
import { ChatFileMetadata, ChatFileService } from "./chat_file_service";
import { MessageRetryManager } from "./message_retry_manager";
export interface ChatUserSettings {
  nickname: string;
  ip: string;
  port: number;
}

export interface ChatFileChunk {
  index: number;
  size: number;
  data: Buffer;
  finish: boolean;
  total?: number;
}

export interface ChatMessage {
  type: "chat" | "file" | "link" | "chunk" | "chunk_resend_request" | "transfer_complete";
  from: string;
  timestamp: number;
  // 消息唯一标识（UUID）
  id: string;
  // 是否为回复消息
  reply: boolean;
  // type=chat时，表示消息内容
  // tyoe=chunk时，表示文件的唯一标识
  value?: string;
  target?: string[];
  files?: string[];
  // type=link时必填：true代表请求，false代表回复
  request: boolean;
  // type=chunk时，表示文件块
  chunk?: ChatFileChunk;
  // type=chunk_resend_request时，表示需要补发的 chunk 索引列表
  missingChunks?: number[];
  // 文件传输会话ID（用于关联同一个文件的所有 chunk）
  sessionId?: string;
}

export interface ChatMessageServiceOptions {
  view?: vscode.WebviewView;
  defaultPort: number;
  getSelfId?: () => string;
  fileService: ChatFileService;
  onLinkMessageReceived?: (result: {
    ip: string;
    port: number;
    id?: string;
    isReply: boolean;
  }) => void;
  context: vscode.ExtensionContext;
}

export class ChatMessageService {
  private udpServer?: dgram.Socket;
  private currentPort: number;
  private readonly defaultPort: number;
  private view?: vscode.WebviewView;
  private readonly getSelfId?: () => string;
  private readonly onLinkMessageReceived?: (result: {
    ip: string;
    port: number;
    id?: string;
    isReply: boolean;
  }) => void;
  private readonly messageManager?: ChatMessageManager;
  private readonly fileService: ChatFileService;
  private readonly chunkSize: number = 1024;
  private retryManager?: MessageRetryManager;
  // 文件发送会话管理（保持文件句柄和状态，直到传输完成）
  private fileSendSessions = new Map<string, {
    filePath: string;
    fd: number;
    chunkCount: number;
    sentChunks: Set<number>;
    targetIp: string;
    targetPort: number;
    lastActivityTime: number;
    createdTime: number;
  }>();
  private sessionTimeoutChecker?: NodeJS.Timeout;

  constructor(port: number, options: ChatMessageServiceOptions) {
    this.currentPort = port || options.defaultPort;
    this.defaultPort = options.defaultPort;
    this.view = options.view;
    this.getSelfId = options.getSelfId;
    this.onLinkMessageReceived = options.onLinkMessageReceived;
    this.fileService = options.fileService;
    // 设置文件服务对消息服务的引用
    this.fileService.setMessageService(this);
    // 创建消息管理器
    this.messageManager = new ChatMessageManager(
      options.context.globalStorageUri.fsPath,
    );
    // 开启服务
    this.startUdpServer(this.currentPort);
    // 启动会话超时检查
    this.startSessionTimeoutChecker();
  }
  
  /**
   * 启动发送会话超时检查
   */
  private startSessionTimeoutChecker(): void {
    // 每30秒检查一次
    this.sessionTimeoutChecker = setInterval(() => {
      this.checkSendSessionTimeouts();
    }, 30000);
  }
  
  /**
   * 检查并清理超时的发送会话
   */
  private checkSendSessionTimeouts(): void {
    const now = Date.now();
    
    for (const [sessionId, session] of this.fileSendSessions.entries()) {
      // 计算超时时间：基础5分钟 + 每MB额外1分钟，最多30分钟
      const estimatedSizeMB = (session.chunkCount * this.chunkSize) / (1024 * 1024);
      const timeoutMs = Math.min(5 * 60 * 1000 + estimatedSizeMB * 60 * 1000, 30 * 60 * 1000);
      
      const idleTime = now - session.lastActivityTime;
      
      if (idleTime > timeoutMs) {
        console.warn(`发送会话超时：${sessionId}, 空闲时间：${Math.floor(idleTime / 1000)}秒`);
        
        // 清理会话
        try {
          fs.closeSync(session.fd);
        } catch (error) {
          console.error('关闭文件句柄失败:', error);
        }
        this.fileSendSessions.delete(sessionId);
        
        vscode.window.showWarningMessage(
          `文件 ${session.filePath.split('/').pop()} 发送会话超时，已自动清理。`
        );
      }
    }
  }
  
  /**
   * 清理资源
   */
  public dispose(): void {
    if (this.sessionTimeoutChecker) {
      clearInterval(this.sessionTimeoutChecker);
    }
    
    // 清理所有发送会话
    for (const [sessionId, session] of this.fileSendSessions.entries()) {
      try {
        fs.closeSync(session.fd);
      } catch (error) {
        console.error(`关闭文件句柄失败 ${sessionId}:`, error);
      }
    }
    this.fileSendSessions.clear();
    
    // 清理文件服务
    if (this.fileService) {
      this.fileService.dispose();
    }
  }

  public attachView(view: vscode.WebviewView) {
    this.view = view;
  }

  public getPort(): number {
    return this.currentPort;
  }

  public restart(port: number) {
    if (this.udpServer) {
      try {
        this.udpServer.close();
      } catch { }
      this.udpServer = undefined;
    }
    this.currentPort = port || this.defaultPort;
    this.startUdpServer(this.currentPort);
  }

  sendFileMessage(file: ChatFileMetadata) {
    if (!this.retryManager || !this.getSelfId) {
      return;
    }
    
    this.retryManager.sendWithRetry(
      {
        type: "file",
        value: file.path,
        from: this.getSelfId(),
        timestamp: Date.now(),
        request: true,
      },
      file.ip,
      file.port
    );
  }

  public sendChatMessage(message: ChatMessage) {
    if (!this.getSelfId || !this.retryManager) {
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

      // 使用重试管理器发送消息
      this.retryManager.sendWithRetry(
        {
          type: "chat",
          from: selfId,
          timestamp,
          value: message.value,
          target: message.target,
          files: message.files,
          request: true,
        },
        ip,
        targetPort
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

  /**
   * 发送 LinkMessage 探测消息
   * @param contact 目标联系人
   * @param showError 是否显示错误提示（默认为 false）
   */
  public sendLinkMessage(contact: ChatContact, showError: boolean = false) {
    if (!contact || !contact.ip || !this.retryManager) {
      if (showError) {
        vscode.window.showErrorMessage(
          "无法发送链接检测消息：目标或本地 UDP 服务无效",
        );
      }
      return;
    }
    const targetPort =
      contact.port && contact.port > 0 && contact.port <= 65535
        ? contact.port
        : this.defaultPort;
    
    const fromId = this.getSelfId ? this.getSelfId() : "";
    
    // 使用重试管理器发送消息
    this.retryManager.sendWithRetry(
      {
        type: "link",
        from: fromId,
        timestamp: Date.now(),
        request: true,
      },
      contact.ip,
      targetPort
    );
  }
  
  /**
   * 发送补发请求
   */
  public sendResendRequest(sessionId: string, missingChunks: number[], filePath: string, ip: string, port: number): void {
    if (!this.retryManager || !this.getSelfId) {
      return;
    }
    
    console.log(`发送补发请求：sessionId=${sessionId}, 缺失 ${missingChunks.length} 个块`);
    
    this.retryManager.sendWithRetry(
      {
        type: "chunk_resend_request",
        from: this.getSelfId(),
        timestamp: Date.now(),
        request: true,
        sessionId,
        value: filePath,
        missingChunks
      },
      ip,
      port
    );
  }
  
  /**
   * 发送传输完成确认
   */
  public sendTransferComplete(sessionId: string, filePath: string, ip: string, port: number): void {
    if (!this.retryManager || !this.getSelfId) {
      return;
    }
    
    console.log(`发送传输完成确认：sessionId=${sessionId}`);
    
    this.retryManager.sendWithRetry(
      {
        type: "transfer_complete",
        from: this.getSelfId(),
        timestamp: Date.now(),
        request: true,
        sessionId,
        value: filePath
      },
      ip,
      port
    );
  }

  private startUdpServer(port: number) {
    try {
      const targetPort = port || this.defaultPort;
      this.udpServer = dgram.createSocket("udp4");
      
      // 创建重试管理器，从配置中读取参数
      const config = vscode.workspace.getConfiguration('lnim');
      const retryInterval = config.get<number>('retryInterval', 5000);
      const maxRetries = config.get<number>('maxRetries', -1);
      this.retryManager = new MessageRetryManager(
        this.udpServer,
        retryInterval,
        maxRetries
      );
      
      this.udpServer.on("message", (data, rinfo) => {
        try {
          const text = data.toString();
          const trimmed = text.trim();
          if (
            !trimmed.startsWith("{") &&
            !trimmed.startsWith("[") &&
            !trimmed.startsWith('"')
          ) {
            return;
          }

          let payload: any;
          try {
            payload = JSON.parse(text);
          } catch (err) {
            if (err instanceof SyntaxError) {
              return;
            }
            throw err;
          }

          // 检查是否为回复消息
          if (payload && payload.reply === true && payload.id) {
            // 标记消息已收到回复
            if (this.retryManager) {
              this.retryManager.markAsReceived(payload.id);
            }
          }

          if (payload && payload.type === "link") {
            this.handleLinkMessage(payload, rinfo);
            return;
          } else if (payload && payload.type === "chat") {
            this.handleChatMessage(payload, rinfo);
            return;
          } else if (payload && payload.type === "chunk") {
            this.handleChunkMessage(payload, rinfo);
            return;
          } else if (payload && payload.type === "file") {
            // 处理文件消息：收到文件请求后，读取本地文件并分块发送
            this.handleFileMessage(payload, rinfo);
            return;
          } else if (payload && payload.type === "chunk_resend_request") {
            // 处理补发请求
            this.handleResendRequest(payload, rinfo);
            return;
          } else if (payload && payload.type === "transfer_complete") {
            // 处理传输完成确认
            this.handleTransferComplete(payload, rinfo);
            return;
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
        this.currentPort = targetPort;
      });
    } catch (e) {
      console.error("Failed to start UDP server:", e);
      vscode.window.showErrorMessage("无法启动 UDP 服务");
    }
  }

  handleChunkMessage(payload: any, rinfo: dgram.RemoteInfo) {
    const data = payload as ChatMessage;
    
    console.log(`[接收] type=chunk, from=${rinfo.address}:${rinfo.port}, id=${data.id}, reply=${data.reply}, request=${data.request}, index=${data.chunk?.index}`);
    
    // 校验必填字段，防止处理无效消息
    if (!data.chunk || typeof data.chunk.index !== 'number') {
      console.error(`[错误] chunk消息字段不完整`);
      return;
    }

    // 如果是回复消息，不需要再次回复
    if (data.reply) {
      console.log(`[接收] 这是一个回复消息，不需要再次回复`);
      this.fileService.saveChunk(data.value, data.chunk, rinfo.address, rinfo.port, data.sessionId);
      return;
    }

    // 发送回复消息确认收到文件块
    // 必须在处理 saveChunk 之前或无论 saveChunk 是否成功都发送回复，否则发送方会无限重试
    if (data.id && this.retryManager && this.getSelfId) {
      this.retryManager.sendReply(
        data.id,
        {
          type: "chunk",
          value: data.value || "",
          from: this.getSelfId(),
          timestamp: Date.now(),
          request: false,
        },
        rinfo.address,
        rinfo.port
      );
      console.log(`[发送] type=chunk, to=${rinfo.address}:${rinfo.port}, type=reply, id=${data.id}`);
    } else {
      console.error(`[错误] 无法发送chunk回复: id=${data.id}, retryManager=${!!this.retryManager}, getSelfId=${!!this.getSelfId}`);
    }
    
    this.fileService.saveChunk(data.value, data.chunk, rinfo.address, rinfo.port, data.sessionId);
  }
  
  /**
   * 处理补发请求
   */
  private handleResendRequest(payload: any, rinfo: dgram.RemoteInfo) {
    const msg = payload as ChatMessage;
    console.log(`[接收] 补发请求, sessionId=${msg.sessionId}, 缺失 ${msg.missingChunks?.length || 0} 个块`);
    
    // 发送回复确认
    if (msg.id && this.retryManager && this.getSelfId) {
      this.retryManager.sendReply(
        msg.id,
        {
          type: "chunk_resend_request",
          from: this.getSelfId(),
          timestamp: Date.now(),
          request: false,
        },
        rinfo.address,
        rinfo.port
      );
    }
    
    const sessionId = msg.sessionId;
    const missingChunks = msg.missingChunks || [];
    const filePath = msg.value;
    
    if (!sessionId || !filePath || missingChunks.length === 0) {
      console.error('补发请求参数不完整');
      return;
    }
    
    // 查找对应的发送会话
    const session = this.fileSendSessions.get(sessionId);
    if (!session) {
      console.error(`未找到发送会话：${sessionId}`);
      return;
    }
    
    // 更新活动时间
    session.lastActivityTime = Date.now();
    
    console.log(`补发 ${missingChunks.length} 个块：${missingChunks.slice(0, 10).join(', ')}${missingChunks.length > 10 ? '...' : ''}`);
    
    // 补发缺失的 chunk
    for (const index of missingChunks) {
      if (index < 0 || index >= session.chunkCount) {
        console.error(`无效的 chunk 索引：${index}`);
        continue;
      }
      
      try {
        const buffer = Buffer.alloc(this.chunkSize);
        const nbytes = fs.readSync(session.fd, buffer, 0, this.chunkSize, index * this.chunkSize);
        
        if (this.retryManager && this.getSelfId) {
          this.retryManager.sendWithRetry(
            {
              type: "chunk",
              value: filePath,
              from: this.getSelfId(),
              timestamp: Date.now(),
              request: true,
              sessionId: sessionId,
              chunk: {
                index: index,
                size: nbytes,
                data: buffer.subarray(0, nbytes),
                finish: index === session.chunkCount - 1,
                total: session.chunkCount,
              }
            },
            rinfo.address,
            rinfo.port
          );
        }
      } catch (error) {
        console.error(`补发 chunk ${index} 失败:`, error);
      }
    }
  }
  
  /**
   * 处理传输完成确认
   */
  private handleTransferComplete(payload: any, rinfo: dgram.RemoteInfo) {
    const msg = payload as ChatMessage;
    console.log(`[接收] 传输完成确认, sessionId=${msg.sessionId}`);
    
    // 发送回复确认
    if (msg.id && this.retryManager && this.getSelfId) {
      this.retryManager.sendReply(
        msg.id,
        {
          type: "transfer_complete",
          from: this.getSelfId(),
          timestamp: Date.now(),
          request: false,
        },
        rinfo.address,
        rinfo.port
      );
    }
    
    const sessionId = msg.sessionId;
    if (!sessionId) {
      return;
    }
    
    // 清理发送会话
    const session = this.fileSendSessions.get(sessionId);
    if (session) {
      try {
        fs.closeSync(session.fd);
      } catch (error) {
        console.error('关闭文件句柄失败:', error);
      }
      this.fileSendSessions.delete(sessionId);
      console.log(`文件传输会话已清理：${sessionId}`);
      vscode.window.showInformationMessage(
        `文件发送完成: ${session.filePath.split('/').pop()}`
      );
    }
  }

  /**
   * 处理文件消息：收到文件请求后，读取本地文件并分块发送
   */
  private handleFileMessage(payload: any, rinfo: dgram.RemoteInfo) {
    const msg = payload as ChatMessage;
    const filePath = typeof msg.value === "string" ? msg.value : "";
    const from = msg.from || "";

    // 发送回复消息确认收到文件请求
    if (msg.id && this.retryManager && this.getSelfId) {
      this.retryManager.sendReply(
        msg.id,
        {
          type: "file",
          value: "",
          from: this.getSelfId(),
          timestamp: Date.now(),
          request: msg.request,
        },
        rinfo.address,
        rinfo.port
      );
    }

    if (!filePath) {
      console.error("收到文件请求，但文件路径为空");
      return;
    }

    if (!fs.existsSync(filePath)) {
      console.error(`收到文件请求，但文件不存在: ${filePath}`);
      vscode.window.showErrorMessage(`文件不存在: ${filePath}`);
      return;
    }

    try {
      const stat = fs.statSync(filePath);
      
      if (!stat.isFile()) {
        console.error(`路径不是文件: ${filePath}`);
        vscode.window.showErrorMessage(`路径不是文件: ${filePath}`);
        return;
      }

      const chunkCount = Math.ceil(stat.size / this.chunkSize);
      const fd = fs.openSync(filePath, "r");
      
      // 创建发送会话
      const sessionId = `${rinfo.address}_${rinfo.port}_${filePath}_${Date.now()}`;
      const now = Date.now();
      this.fileSendSessions.set(sessionId, {
        filePath,
        fd,
        chunkCount,
        sentChunks: new Set<number>(),
        targetIp: rinfo.address,
        targetPort: rinfo.port,
        lastActivityTime: now,
        createdTime: now
      });
      
      console.log(`创建文件发送会话：${sessionId}, 共 ${chunkCount} 块`);

      // 分块读取并发送文件
      for (let i = 0; i < chunkCount; i++) {
        const buffer = Buffer.alloc(this.chunkSize);
        const nbytes = fs.readSync(fd, buffer, 0, this.chunkSize, i * this.chunkSize);
        
        if (this.retryManager && this.getSelfId) {
          this.retryManager.sendWithRetry(
            {
              type: "chunk",
              value: filePath,
              from: this.getSelfId(),
              timestamp: Date.now(),
              request: true, // 原始消息，需要确认
              sessionId: sessionId,
              chunk: {
                index: i,
                size: nbytes,
                data: buffer.subarray(0, nbytes), // 只发送实际读取的字节
                finish: i === chunkCount - 1,
                total: chunkCount,
              }
            },
            rinfo.address,
            rinfo.port
          );
          
          // 记录已发送的 chunk
          const session = this.fileSendSessions.get(sessionId);
          if (session) {
            session.sentChunks.add(i);
          }
        }
      }
      
      console.log(`已发送所有 ${chunkCount} 个块，等待传输完成确认...`);
      
      // 不在这里关闭 fd，等待传输完成确认后再关闭
      vscode.window.showInformationMessage(
        `正在向 ${rinfo.address}:${rinfo.port} 发送文件: ${filePath.split('/').pop()} (${chunkCount} 块)`
      );
    } catch (error) {
      console.error("处理文件消息时出错:", error);
      vscode.window.showErrorMessage(`处理文件请求失败: ${error}`);
    }
  }

  private handleLinkMessage(payload: any, rinfo: dgram.RemoteInfo) {
    // 验证 request 字段
    if (typeof payload.request !== "boolean") {
      return;
    }
    const isRequest = payload.request;

    // 自动回复 LinkMessage（如果收到的是 request）
    if (isRequest && this.getSelfId && this.retryManager && payload.id) {
      const myId = this.getSelfId();
      
      // 使用 sendReply 发送回复消息（使用原始消息的 id）
      this.retryManager.sendReply(
        payload.id,
        {
          type: "link",
          from: myId,
          timestamp: Date.now(),
          request: false,
        },
        rinfo.address,
        rinfo.port
      );
    }

    // 通知收到 link 类型消息，让外部判断是否需要添加到联系人列表
    if (
      !isRequest &&
      typeof payload.from === "string" &&
      this.onLinkMessageReceived
    ) {
      this.onLinkMessageReceived({
        ip: rinfo.address,
        port: rinfo.port,
        id: payload.from,
        isReply: true,
      });
    }
  }

  private handleChatMessage(payload: ChatMessage, rinfo: dgram.RemoteInfo) {
    const { from, value, timestamp, id, reply } = payload;
    
    // 如果不是回复消息，需要发送确认回复
    if (!reply && id && this.getSelfId && this.retryManager) {
      const myId = this.getSelfId();
      this.retryManager.sendReply(
        id,
        {
          type: "chat",
          from: myId,
          timestamp: Date.now(),
          value: "",
          request: payload.request,
        },
        rinfo.address,
        rinfo.port
      );
    }

    let fromUsername = "";
    let fromIp = "";
    let fromPort = this.defaultPort;
    const decoded = Buffer.from(from, "base64").toString("utf8");
    const parts = decoded.split("-");
    fromUsername = parts[0];
    const fromParts = parts[1].split(":");
    fromIp = fromParts[0];
    fromPort = parseInt(fromParts[1]);
    const ts = timestamp || Date.now();
    
    // 只保存和显示非回复消息
    if (!reply) {
      if (this.messageManager) {
        this.messageManager.saveIncoming(
          {
            nickname: fromUsername,
            ip: fromIp,
            port: fromPort,
          },
          value || "",
          ts,
        );
      }
      if (this.view) {
        this.view.webview.postMessage({
          type: "receiveMessage",
          from: fromUsername,
          message: value || "",
          timestamp: ts,
        });
      }
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
}
