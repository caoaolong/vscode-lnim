import * as dgram from "dgram";
import * as vscode from "vscode";
import { LinkMessage } from "./lnim_message";

export interface ChatUserSettings {
  nickname: string;
  ip: string;
  port: number;
}

export interface ChatContact {
  ip: string;
  port?: number;
  username: string;
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

  constructor(port: number, options: ChatMessageServiceOptions) {
    this.currentPort = port || options.defaultPort;
    this.defaultPort = options.defaultPort;
    this.view = options.view;
    this.getSelfId = options.getSelfId;
    this.onLinkMessageReceived = options.onLinkMessageReceived;
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
      const payload: LinkMessage = {
        type: "link",
        from: fromId,
      };
      const buf = Buffer.from(JSON.stringify(payload), "utf8");
      this.udpServer!.send(buf, targetPort, contact.ip, (err) => {
        if (err) {
          console.error("Failed to send online-check LinkMessage:", err);
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

    // 只发送 LinkMessage，不等待回复
    const fromId = this.getSelfId ? this.getSelfId() : "";
    const payload: LinkMessage = {
      type: "link",
      from: fromId,
    };
    const buf = Buffer.from(JSON.stringify(payload), "utf8");
    this.udpServer.send(buf, targetPort, contact.ip, (err) => {
      if (err) {
        console.error("Failed to send scan LinkMessage:", err);
      }
    });
  }

  public sendLinkMessage(contact: ChatContact, fromId: string) {
    if (!contact || !contact.ip || !this.udpServer) {
      vscode.window.showErrorMessage("无法发送 LinkMessage：目标或本地 UDP 服务无效");
      return;
    }
    const targetPort =
      contact.port && contact.port > 0 && contact.port <= 65535
        ? contact.port
        : this.defaultPort;
    const payload: LinkMessage = {
      type: "link",
      from: fromId,
    };
    const buf = Buffer.from(JSON.stringify(payload), "utf8");
    this.udpServer.send(buf, targetPort, contact.ip, (err) => {
      if (err) {
        console.error("Failed to send LinkMessage:", err);
        vscode.window.showErrorMessage(
          `向 ${contact.username}(${contact.ip}:${targetPort}) 发送 LinkMessage 失败：${String(
            err
          )}`
        );
      } else {
        vscode.window.showInformationMessage(
          `已向 ${contact.username}(${contact.ip}:${targetPort}) 发送 LinkMessage`
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

          if (payload && payload.type === "ping") {
            this.handlePingMessage(rinfo);
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
    const key = `${rinfo.address}:${rinfo.port}`;
    const isReply = !!payload.reply;

    // 核心功能1: 接收到 LinkMessage 时回复 LinkMessage（from改为自身ID）
    if (!isReply && this.getSelfId) {
      const myId = this.getSelfId();
      const replyPayload: LinkMessage = {
        type: "link",
        from: myId,
        reply: true,
      };
      const replyBuf = Buffer.from(JSON.stringify(replyPayload), "utf8");
      this.udpServer?.send(replyBuf, rinfo.port, rinfo.address, (err) => {
        if (err) {
          console.error("Failed to send LinkMessage reply:", err);
        }
      });
    }

    // 核心功能2: 通知收到 LinkMessage，让外部判断是否需要添加到联系人列表
    if (typeof payload.from === "string" && this.onLinkMessageReceived) {
      this.onLinkMessageReceived({
        ip: rinfo.address,
        port: rinfo.port,
        id: payload.from,
        isReply,
      });
    }

    // 辅助功能: 处理待处理的在线检测请求
    const pending = this.pendingLinkChecks.get(key);
    if (pending) {
      this.pendingLinkChecks.delete(key);
      clearTimeout(pending.timeout);
      pending.resolve(true);
    }
  }

  private handlePingMessage(rinfo: dgram.RemoteInfo) {
    const buf = Buffer.from(JSON.stringify({ type: "pong" }), "utf8");
    this.udpServer?.send(buf, rinfo.port, rinfo.address);
  }

  private handleChatMessage(payload: any) {
    const from = payload.from;
    const message = payload.message;
    console.log(
      "Received message:",
      message,
      "from:",
      from.nickname || from
    );
    if (this.view) {
      this.view.webview.postMessage({
        type: "receiveMessage",
        from,
        message,
        timestamp: Date.now(),
      });
    }
  }
}
