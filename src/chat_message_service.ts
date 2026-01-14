import * as dgram from "dgram";
import * as vscode from "vscode";
import { LinkMessage } from "./lnim_message";

function ipToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) {
    return null;
  }
  let n = 0;
  for (const p of parts) {
    const v = Number(p);
    if (!Number.isInteger(v) || v < 0 || v > 255) {
      return null;
    }
    n = (n << 8) | v;
  }
  return n >>> 0;
}

function intToIp(n: number): string | null {
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) {
    return null;
  }
  const p1 = (n >>> 24) & 0xff;
  const p2 = (n >>> 16) & 0xff;
  const p3 = (n >>> 8) & 0xff;
  const p4 = n & 0xff;
  return `${p1}.${p2}.${p3}.${p4}`;
}

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

export interface DiscoveredPeer {
  ip: string;
  port: number;
  id: string;
}

export interface ChatMessageServiceOptions {
  view?: vscode.WebviewView;
  defaultPort: number;
  getSelfId?: () => string;
}

export class ChatMessageService {
  private udpServer?: dgram.Socket;
  private currentPort: number;
  private readonly defaultPort: number;
  private view?: vscode.WebviewView;
  private readonly getSelfId?: () => string;
  private readonly pendingLinkChecks = new Map<
    string,
    { resolve: (online: boolean) => void; timeout: NodeJS.Timeout }
  >();
  private currentScan?:
    | {
        results: Map<string, DiscoveredPeer>;
      }
    | undefined;

  constructor(port: number, options: ChatMessageServiceOptions) {
    this.currentPort = port || options.defaultPort;
    this.defaultPort = options.defaultPort;
    this.view = options.view;
    this.getSelfId = options.getSelfId;
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

  public async scanSubnet(
    maskBits: number,
    baseIp: string
  ): Promise<DiscoveredPeer[]> {
    if (!this.udpServer) {
      return [];
    }
    const bits = Math.max(0, Math.min(32, maskBits | 0));
    const base = ipToInt(baseIp);
    if (base === null) {
      return [];
    }
    const mask =
      bits === 0 ? 0 : ((0xffffffff << (32 - bits)) >>> 0) >>> 0;
    const network = base & mask;
    const hostCount = bits === 32 ? 1 : 1 << (32 - bits);
    this.currentScan = {
      results: new Map<string, DiscoveredPeer>(),
    };
    const targetPort = this.currentPort || this.defaultPort;
    const fromId = this.getSelfId ? this.getSelfId() : "";
    const payload: LinkMessage = {
      type: "link",
      from: fromId,
    };
    const buf = Buffer.from(JSON.stringify(payload), "utf8");
    for (let i = 1; i < hostCount - 1; i++) {
      const ipInt = (network + i) >>> 0;
      const ip = intToIp(ipInt);
      if (!ip) {
        continue;
      }
      this.udpServer.send(buf, targetPort, ip, (err) => {
        if (err) {
          console.error("Failed to send scan LinkMessage:", err);
        }
      });
    }
    return new Promise<DiscoveredPeer[]>((resolve) => {
      setTimeout(() => {
        const result = this.currentScan
          ? Array.from(this.currentScan.results.values())
          : [];
        this.currentScan = undefined;
        resolve(result);
      }, 1000);
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
            const key = `${rinfo.address}:${rinfo.port}`;
            const pending = this.pendingLinkChecks.get(key);
            if (pending) {
              this.pendingLinkChecks.delete(key);
              clearTimeout(pending.timeout);
              pending.resolve(true);
            }
            const isReply = !!payload.reply;
            if (!isReply && this.getSelfId) {
              const myId = this.getSelfId();
              const replyPayload: LinkMessage = {
                type: "link",
                from: myId,
                reply: true,
              };
              const replyBuf = Buffer.from(
                JSON.stringify(replyPayload),
                "utf8"
              );
              this.udpServer?.send(replyBuf, rinfo.port, rinfo.address, (err) => {
                if (err) {
                  console.error("Failed to send LinkMessage reply:", err);
                }
              });
            }
            if (this.currentScan && isReply && typeof payload.from === "string") {
              const scanKey = `${rinfo.address}:${rinfo.port}`;
              if (!this.currentScan.results.has(scanKey)) {
                this.currentScan.results.set(scanKey, {
                  ip: rinfo.address,
                  port: rinfo.port,
                  id: payload.from,
                });
              }
            }
            return;
          }

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
            if (this.view) {
              this.view.webview.postMessage({
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
        this.currentPort = targetPort;
        console.log(`UDP server listening on port ${targetPort}`);
      });
    } catch (e) {
      console.error("Failed to start UDP server:", e);
      vscode.window.showErrorMessage("无法启动 UDP 服务");
    }
  }
}
