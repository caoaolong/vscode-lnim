import * as dgram from "dgram";
import * as vscode from "vscode";
import { ChatMessageManager, ChatContact } from "./chat_message_manager";
export interface ChatUserSettings {
  nickname: string;
  ip: string;
  port: number;
}

export interface ChatMessage {
  type: "chat" | "file" | "link";
  from: string;
  timestamp: number;
  value?: string;
  target?: string[];
  files?: string[];
  linkType?: "request" | "reply";
}

export interface ChatMessageServiceOptions {
  view?: vscode.WebviewView;
  defaultPort: number;
  getSelfId?: () => string;
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
  private readonly pendingLinkChecks = new Map<
    string,
    { resolve: (online: boolean) => void; timeout: NodeJS.Timeout }
  >();
  private readonly messageManager?: ChatMessageManager;

  constructor(port: number, options: ChatMessageServiceOptions) {
    this.currentPort = port || options.defaultPort;
    this.defaultPort = options.defaultPort;
    this.view = options.view;
    this.getSelfId = options.getSelfId;
    this.onLinkMessageReceived = options.onLinkMessageReceived;
    // 创建消息管理器
    this.messageManager = new ChatMessageManager(
      options.context.globalStorageUri.fsPath
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
      } catch {}
      this.udpServer = undefined;
    }
    this.currentPort = port || this.defaultPort;
    this.startUdpServer(this.currentPort);
  }

  public sendChatMessage(
    text: string,
    from: ChatUserSettings,
    contacts: ChatContact[]
  ) {
    const timestamp = Date.now();
    const payload = JSON.stringify({
      type: "chat",
      from,
      message: text,
    });
    const buf = Buffer.from(payload, "utf8");
    if (!this.udpServer) {
      vscode.window.showErrorMessage("UDP 服务未启动，无法发送消息");
      return;
    }
    for (const c of contacts) {
      const targetPort =
        c.port && c.port > 0 && c.port <= 65535 ? c.port : this.defaultPort;
      this.udpServer.send(buf, targetPort, c.ip, (err) => {
        if (err) {
          console.error("Failed to send UDP message:", err);
          vscode.window.showErrorMessage(
            `向 ${c.username}(${c.ip}) 发送消息失败：${String(err)}`
          );
        }
      });
      if (this.messageManager) {
        this.messageManager.saveOutgoing(c, text, timestamp, this.defaultPort);
      }
    }
    console.log(
      "Sent message:",
      text,
      "contacts:",
      contacts.map((c) => `${c.username}(${c.ip})`)
    );
  }

  public async checkContactOnline(contact: ChatContact): Promise<boolean> {
    if (!contact || !contact.ip) {
      return false;
    }
    if (!this.udpServer) {
      return false;
    }
    return new Promise<boolean>((resolve) => {
      const targetPort =
        contact.port && contact.port > 0 && contact.port <= 65535
          ? contact.port
          : this.defaultPort;
      const key = `${contact.ip}:${targetPort}`;
      const existing = this.pendingLinkChecks.get(key);
      if (existing) {
        clearTimeout(existing.timeout);
        this.pendingLinkChecks.delete(key);
      }
      const timeout = setTimeout(() => {
        this.pendingLinkChecks.delete(key);
        resolve(false);
      }, 1000);
      this.pendingLinkChecks.set(key, { resolve, timeout });
      const fromId = this.getSelfId ? this.getSelfId() : "";
      const payload: ChatMessage = {
        type: "link",
        from: fromId,
        timestamp: Date.now(),
        linkType: "request",
      };
      const buf = Buffer.from(JSON.stringify(payload), "utf8");
      this.udpServer!.send(buf, targetPort, contact.ip, (err) => {
        if (err) {
          console.error("Failed to send online-check link message:", err);
        }
      });
    });
  }

  public sendScanContactMessage(contact: ChatContact) {
    if (!contact || !contact.ip || !this.udpServer) {
      return;
    }
    const targetPort =
      contact.port && contact.port > 0 && contact.port <= 65535
        ? contact.port
        : this.defaultPort;

    // 只发送 link 探测消息，不等待回复
    const fromId = this.getSelfId ? this.getSelfId() : "";
    const payload: ChatMessage = {
      type: "link",
      from: fromId,
      timestamp: Date.now(),
      linkType: "request",
    };
    const buf = Buffer.from(JSON.stringify(payload), "utf8");
    this.udpServer.send(buf, targetPort, contact.ip, (err) => {
      if (err) {
        console.error("Failed to send scan link message:", err);
      }
    });
  }

  public sendLinkMessage(contact: ChatContact, fromId: string) {
    if (!contact || !contact.ip || !this.udpServer) {
      vscode.window.showErrorMessage(
        "无法发送链接检测消息：目标或本地 UDP 服务无效"
      );
      return;
    }
    const targetPort =
      contact.port && contact.port > 0 && contact.port <= 65535
        ? contact.port
        : this.defaultPort;
    const payload: ChatMessage = {
      type: "link",
      from: fromId,
      timestamp: Date.now(),
      linkType: "request",
    };
    const buf = Buffer.from(JSON.stringify(payload), "utf8");
    this.udpServer.send(buf, targetPort, contact.ip, (err) => {
      if (err) {
        vscode.window.showErrorMessage(
          `检测 ${contact.username}(${
            contact.ip
          }:${targetPort}) 的状态时报错：${String(err)}`
        );
      }
    });
  }

  private startUdpServer(port: number) {
    try {
      const targetPort = port || this.defaultPort;
      this.udpServer = dgram.createSocket("udp4");
      this.udpServer.on("message", (data, rinfo) => {
        try {
          const text = data.toString();
          console.log(
            "UDP raw message from",
            `${rinfo.address}:${rinfo.port}`,
            "length",
            data.length,
            "data",
            text
          );
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

          if (payload && payload.type === "link") {
            this.handleLinkMessage(payload, rinfo);
            return;
          }
          if (payload && payload.type === "chat") {
            this.handleChatMessage(payload);
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
        console.log(`UDP server listening on port ${targetPort}`);
      });
    } catch (e) {
      console.error("Failed to start UDP server:", e);
      vscode.window.showErrorMessage("无法启动 UDP 服务");
    }
  }

  private handleLinkMessage(payload: any, rinfo: dgram.RemoteInfo) {
    const rawType = payload.linkType;
    if (rawType !== "request" && rawType !== "reply") {
      return;
    }
    const linkType: "request" | "reply" = rawType;
    const isReply = linkType === "reply";

    // 通知收到 link 类型消息，让外部判断是否需要添加到联系人列表
    if (
      isReply &&
      typeof payload.from === "string" &&
      this.onLinkMessageReceived
    ) {
      this.onLinkMessageReceived({
        ip: rinfo.address,
        port: rinfo.port,
        id: payload.from,
        isReply,
      });
    }
  }

  private handleChatMessage(payload: any) {
		console.log("Received chat message:", payload);
		// 处理消息
    const { from, message } = payload;
    const timestamp = Date.now();
		// 保存聊天记录
    if (this.messageManager) {
      this.messageManager.saveIncoming(
        {
          nickname: from.nickname,
          ip: from.ip,
          port: from.port,
        },
        message,
        timestamp
      );
    }
    // 将收到的消息添加到聊天记录面板
    if (this.view) {
      this.view.webview.postMessage({
        type: "receiveMessage",
        from,
        message,
        timestamp,
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
}
