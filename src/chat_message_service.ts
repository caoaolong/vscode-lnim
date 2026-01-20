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
}

export interface ChatMessage {
  type: "chat" | "file" | "link" | "chunk";
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

  constructor(port: number, options: ChatMessageServiceOptions) {
    this.currentPort = port || options.defaultPort;
    this.defaultPort = options.defaultPort;
    this.view = options.view;
    this.getSelfId = options.getSelfId;
    this.onLinkMessageReceived = options.onLinkMessageReceived;
    this.fileService = options.fileService;
    // 创建消息管理器
    this.messageManager = new ChatMessageManager(
      options.context.globalStorageUri.fsPath,
    );
    // 开启服务
    this.startUdpServer(this.currentPort);
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
    
    // 发送回复消息确认收到文件块
    if (data.id && !data.reply && this.retryManager && this.getSelfId) {
      this.retryManager.sendReply(
        data.id,
        {
          type: "chunk",
          value: "",
          from: this.getSelfId(),
          timestamp: Date.now(),
          request: data.request,
        },
        rinfo.address,
        rinfo.port
      );
    }
    
    this.fileService.saveChunk(data.value, data.chunk, rinfo.address, rinfo.port);
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

      // 分块读取并发送文件
      for (let i = 0; i < chunkCount; i++) {
        const buffer = Buffer.alloc(this.chunkSize);
        const nbytes = fs.readSync(fd, buffer, 0, this.chunkSize, i * this.chunkSize);
        
        if (this.retryManager) {
          this.retryManager.sendWithRetry(
            {
              type: "chunk",
              value: filePath,
              from: from,
              timestamp: Date.now(),
              request: true, // 原始消息，需要确认
              chunk: {
                index: i,
                size: nbytes,
                data: buffer.slice(0, nbytes), // 只发送实际读取的字节
                finish: i === chunkCount - 1,
              }
            },
            rinfo.address,
            rinfo.port
          );
        }
      }

      fs.closeSync(fd);
      
      vscode.window.showInformationMessage(
        `已向 ${rinfo.address}:${rinfo.port} 发送文件: ${filePath} (${chunkCount} 块)`
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
