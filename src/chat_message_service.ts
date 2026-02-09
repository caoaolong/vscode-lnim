import * as fs from "fs";
import * as net from "net";
import * as path from "path";
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
  private readonly extensionUri: vscode.Uri;
  private settings: ChatUserSettings;

  constructor(port: number, options: ChatMessageServiceOptions) {
    this.currentPort = port || options.defaultPort;
    this.defaultPort = options.defaultPort;
    this.view = options.view;
    this.fileService = options.fileService;
    this.extensionUri = options.context.extensionUri;
    this.messageManager = new ChatMessageManager(
      options.context.globalStorageUri.fsPath,
    );
    this.settings = options.settings;
    this.startTcpServer(this.currentPort);
  }

  /**
   * 在 TCP 连接上解析 HTTP 请求并回复：/file 返回文件信息页，/file/download 返回文件流
   */
  private handleHttpOnSocket(socket: net.Socket, buffer: Buffer): void {
    const raw = buffer.toString("utf8");
    const endOfHeaders = raw.indexOf("\r\n\r\n");
    const headerBlock = endOfHeaders >= 0 ? raw.slice(0, endOfHeaders) : raw;
    const firstLine = headerBlock.split("\r\n")[0] || "";
    const match = firstLine.match(/^(GET|POST|HEAD)\s+(\/[^?\s]*)(?:\?([^\s]*))?\s+HTTP\/./i);
    if (!match) {
      this.sendHttpResponse(socket, 400, { code: 400, message: "Bad Request" });
      return;
    }
    const pathPart = (match[2] || "").replace(/\/+$/, "") || "/";
    const query = match[3] ? new URLSearchParams(match[3]) : new URLSearchParams();

    if (pathPart === "/file/download") {
      const filePath = query.get("path") || "";
      if (!filePath || !this.fileService.isPathAllowed(filePath)) {
        this.sendHttpResponse(socket, 404, { code: 404, message: "Not Found" });
        return;
      }
      try {
        const stat = fs.statSync(filePath);
        const fileName = path.basename(filePath);
        this.sendHttpFile(socket, filePath, fileName, stat.size);
      } catch {
        this.sendHttpResponse(socket, 404, { code: 404, message: "Not Found" });
      }
      return;
    }

    if (pathPart !== "/file") {
      this.sendHttpResponse(socket, 404, { code: 404, message: "Not Found" });
      return;
    }

    const name = query.get("name") || "";
    const pathParam = query.get("path") || "";
    const sizeStr = query.get("size") || "0";
    const size = parseInt(sizeStr, 10) || 0;

    if (!name && !pathParam) {
      this.sendHttpResponse(socket, 400, { code: 400, message: "Bad Request" });
      return;
    }

    if (pathParam && !this.fileService.isPathAllowed(pathParam)) {
      this.sendHttpResponse(socket, 404, { code: 404, message: "Not Found" });
      return;
    }

    const downloadPath = pathParam ? encodeURIComponent(pathParam) : "";
    const html = this.buildFilePageHtml(name, size, downloadPath);
    this.sendHttpResponseHtml(socket, 200, html);
  }

  private formatFileSize(bytes: number): string {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + " " + sizes[i];
  }

  private buildFilePageHtml(
    fileName: string,
    fileSize: number,
    encodedPath: string,
  ): string {
    const templatePath = vscode.Uri.joinPath(
      this.extensionUri,
      "resources",
      "download.html",
    ).fsPath;
    let template: string;
    try {
      template = fs.readFileSync(templatePath, "utf8");
    } catch {
      return this.buildFilePageHtmlFallback(fileName, fileSize, encodedPath);
    }
    const sizeStr = this.formatFileSize(fileSize);
    const downloadUrl = encodedPath ? `/file/download?path=${encodedPath}` : "#";
    return template
      .replace(/\{\{fileName\}\}/g, this.escapeHtml(fileName))
      .replace(/\{\{fileSize\}\}/g, this.escapeHtml(sizeStr))
      .replace(/\{\{downloadUrl\}\}/g, this.escapeHtml(downloadUrl));
  }

  private buildFilePageHtmlFallback(
    fileName: string,
    fileSize: number,
    encodedPath: string,
  ): string {
    const sizeStr = this.formatFileSize(fileSize);
    const downloadUrl = encodedPath ? `/file/download?path=${encodedPath}` : "#";
    return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"/><title>文件 - ${this.escapeHtml(fileName)}</title></head><body><h1>${this.escapeHtml(fileName)}</h1><p>大小：${this.escapeHtml(sizeStr)}</p><a href="${this.escapeHtml(downloadUrl)}" download>下载文件</a></body></html>`;
  }

  private escapeHtml(s: string): string {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  private sendHttpResponse(
    socket: net.Socket,
    statusCode: number,
    body: object,
  ): void {
    const bodyStr = JSON.stringify(body);
    const statusText = statusCode === 200 ? "OK" : statusCode === 404 ? "Not Found" : "Bad Request";
    const response =
      `HTTP/1.1 ${statusCode} ${statusText}\r\n` +
      "Content-Type: application/json; charset=utf-8\r\n" +
      "Connection: close\r\n" +
      `Content-Length: ${Buffer.byteLength(bodyStr, "utf8")}\r\n` +
      "\r\n" +
      bodyStr;
    socket.write(response, "utf8", () => {
      socket.end();
    });
    if (socket.remoteAddress) {
      this.clients.delete(socket.remoteAddress);
    }
  }

  private sendHttpResponseHtml(
    socket: net.Socket,
    statusCode: number,
    html: string,
  ): void {
    const buf = Buffer.from(html, "utf8");
    const statusText = statusCode === 200 ? "OK" : "Not Found";
    const headers =
      `HTTP/1.1 ${statusCode} ${statusText}\r\n` +
      "Content-Type: text/html; charset=utf-8\r\n" +
      "Connection: close\r\n" +
      `Content-Length: ${buf.length}\r\n` +
      "\r\n";
    socket.write(headers, "utf8");
    socket.write(buf, () => {
      socket.end();
    });
    if (socket.remoteAddress) {
      this.clients.delete(socket.remoteAddress);
    }
  }

  private sendHttpFile(
    socket: net.Socket,
    filePath: string,
    fileName: string,
    fileSize: number,
  ): void {
    const safeName = fileName.replace(/[^\w\u4e00-\u9fa5.-]/g, "_");
    const disposition = `attachment; filename*=UTF-8''${encodeURIComponent(safeName)}`;
    const headers =
      "HTTP/1.1 200 OK\r\n" +
      "Content-Type: application/octet-stream\r\n" +
      "Connection: close\r\n" +
      `Content-Disposition: ${disposition}\r\n` +
      `Content-Length: ${fileSize}\r\n` +
      "\r\n";
    socket.write(headers, "utf8");
    const stream = fs.createReadStream(filePath);
    stream.on("error", () => {
      try {
        socket.end();
      } catch {}
    });
    stream.pipe(socket, { end: true });
    stream.on("end", () => {
      if (socket.remoteAddress) {
        this.clients.delete(socket.remoteAddress);
      }
    });
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
      } catch { }
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
      const firstBytes = buffer.toString("utf8", 0, 3);
      const isHttp = ["GET", "POS", "PUT", "DEL", "OPT"].includes(firstBytes);
      if (isHttp) {
        this.handleHttpOnSocket(socket, buffer);
        return;
      } else {
        try {
          const data = JSON.parse(buffer.toString("utf8")) as ChatMessage;
          this.handleDataMessage(socket, data);
        } catch (error) {
          // uuid是16个字符的hex字符串，编码为8字节的二进制Buffer
          const fpId = buffer.subarray(0, 8).toString("hex");
          const fpData = buffer.subarray(8);
          this.fileService.saveChunk(fpId, fpData);
        }
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
