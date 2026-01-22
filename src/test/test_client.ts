import * as net from "net";
import * as readline from "readline";
import * as fs from "fs";
import * as path from "path";
import { FileChunkTransform } from "../file_chunk_transform";

/**
 * TCP消息类型定义（与ChatMessage保持一致）
 */
interface ChatMessage {
  type: "chat" | "link" | "chunk" | "file_received" | "file";
  from: string;
  timestamp: number;
  value?: string;
  target?: string[];
  files?: string[];
  unique?: string;
}

/**
 * TCP测试客户端
 */
class TcpTestClient {
  private client?: net.Socket;
  private readonly serverIp: string;
  private readonly serverPort: number;
  private readonly clientId: string;
  private connected: boolean = false;
  private rl: readline.Interface;
  private receiveBuffer: Buffer = Buffer.alloc(0);
  // 文件发送会话：key为文件路径，value为unique ID
  private fileSendSessions: Map<string, string> = new Map();

  constructor(serverIp: string = "127.0.0.1", serverPort: number = 18080) {
    this.serverIp = serverIp;
    this.serverPort = serverPort;
    this.clientId = Buffer.from(`测试客户端-${serverIp}:${serverPort + 1}`).toString("base64");

    // 创建命令行交互界面
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: "LNIM-Test> ",
    });
  }

  /**
   * 启动客户端
   */
  public async start(): Promise<void> {
    console.log("========================================");
    console.log("     LNIM TCP测试客户端");
    console.log("========================================");
    console.log(`目标服务器: ${this.serverIp}:${this.serverPort}`);
    console.log(`客户端ID: ${this.clientId}`);
    console.log("========================================\n");

    await this.connect();
    this.setupCommandLine();
  }

  /**
   * 连接到服务器
   */
  private async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      console.log(`[连接] 正在连接到 ${this.serverIp}:${this.serverPort}...`);

      this.client = net.connect({
        host: this.serverIp,
        port: this.serverPort,
        localPort: 62289,
      }, () => {
        this.connected = true;
        console.log(`[连接] ✅ 已连接到服务器 ${this.serverIp}:${this.serverPort}\n`);
        this.showHelp();
        resolve();
      });

      this.client.on("data", (data) => this.handleData(data));
      this.client.on("end", () => this.handleDisconnect());
      this.client.on("error", (err) => this.handleError(err));

      // 连接超时
      setTimeout(() => {
        if (!this.connected) {
          reject(new Error("连接超时"));
        }
      }, 5000);
    });
  }

  /**
   * 处理接收到的数据
   */
  private handleData(chunk: Buffer): void {
    try {
      this.handleMessage(JSON.parse(chunk.toString("utf8")) as ChatMessage);
    } catch (error) {
      console.error(`[错误] 解析消息失败:`, error);
    }
  }

  /**
   * 处理接收到的消息
   */
  private handleMessage(msg: ChatMessage): void {
    const timestamp = new Date(msg.timestamp).toLocaleTimeString();

    switch (msg.type) {
      case "link":
        console.log(`\n[${timestamp}] 📡 收到Link消息 - from: ${msg.from}`);
        break;

      case "chat":
        console.log(`\n[${timestamp}] 💬 收到聊天消息: ${msg.value}`);
        break;

      case "file":
        console.log(`\n[${timestamp}] 📁 收到文件消息 - file: ${msg.value}, ID: ${msg.unique}`);
        if (msg.value && msg.unique) {
          // 记录文件请求，确保同一个文件的ID保持一致
          this.fileSendSessions.set(msg.value, msg.unique);
          // 触发文件发送
          this.handleFileRequest(msg.value, msg.unique);
        }
        break;

      case "chunk":
        console.log(`\n[${timestamp}] 📦 收到文件块 - value: ${msg.value}`);
        break;

      case "file_received":
        console.log(`\n[${timestamp}] ✅ 文件接收确认 - value: ${msg.value}`);
        break;

      default:
        console.log(`\n[${timestamp}] ❓ 收到未知消息类型: ${msg.type}`);
    }

    // 重新显示提示符
    this.rl.prompt();
  }

  /**
   * 处理断开连接
   */
  private handleDisconnect(): void {
    this.connected = false;
    console.log("\n[连接] ❌ 与服务器断开连接");
    this.rl.close();
    process.exit(0);
  }

  /**
   * 处理错误
   */
  private handleError(err: Error): void {
    console.error(`\n[错误] TCP连接错误: ${err.message}`);

    if (!this.connected) {
      console.error("[错误] 无法连接到服务器，请检查：");
      console.error("  1. 服务器是否已启动");
      console.error("  2. IP和端口是否正确");
      console.error("  3. 防火墙是否阻止了连接");
      this.rl.close();
      process.exit(1);
    }
  }

  /**
   * 发送消息
   */
  private sendMessage(msg: ChatMessage): void {
    if (!this.connected || !this.client) {
      console.error("[错误] 未连接到服务器");
      return;
    }

    try {
      const data = JSON.stringify(msg) + "\n";
      this.client.write(data);
    } catch (error) {
      console.error(`[错误] 发送消息失败:`, error);
    }
  }

  /**
   * 发送Link消息
   */
  private sendLink(): void {
    const msg: ChatMessage = {
      type: "link",
      from: this.clientId,
      timestamp: Date.now(),
    };

    this.sendMessage(msg);
    console.log("[发送] 📡 已发送Link消息");
  }

  /**
   * 发送聊天消息
   */
  private sendChat(message: string): void {
    const msg: ChatMessage = {
      type: "chat",
      from: this.clientId,
      timestamp: Date.now(),
      value: message,
    };

    this.sendMessage(msg);
    console.log(`[发送] 💬 已发送聊天消息: ${message}`);
  }

  /**
   * 处理文件请求（收到file类型消息后自动发送文件）
   */
  private async handleFileRequest(filePath: string, uniqueId: string): Promise<void> {
    // 获取当前socket
    const socket = this.client;
    if (!socket || !this.connected) {
      console.error(`[错误] 未连接到服务器，无法发送文件`);
      return;
    }

    if (!fs.existsSync(filePath)) {
      console.error(`[错误] 文件不存在: ${filePath}`);
      return;
    }

    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      console.error(`[错误] 不是文件: ${filePath}`);
      return;
    }

    const fileName = path.basename(filePath);
    const fileSize = stat.size;

    console.log(`[文件请求] 📤 开始发送文件: ${fileName} (${fileSize} bytes), ID: ${uniqueId}`);

    // 发送文件原数据
    socket.write(JSON.stringify({
      type: "fstats",
      from: this.clientId,
      timestamp: Date.now(),
      value: fileSize.toString(),
      unique: uniqueId,
    }));

    // 发送文件
    return await new Promise<void>((resolve) => {
      const rs = fs.createReadStream(filePath);
      rs.on("end", () => {
        console.log(`[文件请求] ✅ 文件发送完成: ${fileName}`);
        // 清理会话
        this.fileSendSessions.delete(filePath);
        // 返回
        resolve();
      })
      rs.pipe(new FileChunkTransform(uniqueId)).pipe(socket, {
        end: false,
      });
    })
  }

  /**
   * 发送文件（手动命令）
   */
  private async sendFile(filePath: string): Promise<void> {
    if (!fs.existsSync(filePath)) {
      console.error(`[错误] 文件不存在: ${filePath}`);
      return;
    }

    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      console.error(`[错误] 不是文件: ${filePath}`);
      return;
    }

    const fileName = path.basename(filePath);
    const fileSize = stat.size;

    console.log(`[文件] 📤 准备发送文件: ${fileName} (${fileSize} bytes)`);

    // 发送文件消息（使用ChatMessage的file类型）
    const fileMsg: ChatMessage = {
      type: "chat",
      from: this.clientId,
      timestamp: Date.now(),
      value: `这是一个文件 {#${filePath}}`,
      files: [filePath],
    };

    this.sendMessage(fileMsg);
    console.log(`[文件] ✅ 文件消息已发送: ${fileName}`);
  }

  /**
   * 显示帮助信息
   */
  private showHelp(): void {
    console.log("可用命令:");
    console.log("  /link              - 发送Link消息（用于检测在线状态）");
    console.log("  /chat <消息>       - 发送聊天消息");
    console.log("  /file <文件路径>   - 发送文件");
    console.log("  /help              - 显示帮助信息");
    console.log("  /quit, /exit       - 退出程序");
    console.log("  直接输入文本       - 发送聊天消息\n");
  }

  /**
   * 设置命令行交互
   */
  private setupCommandLine(): void {
    this.rl.prompt();

    this.rl.on("line", async (line) => {
      const input = line.trim();

      if (!input) {
        this.rl.prompt();
        return;
      }

      // 处理命令
      if (input.startsWith("/")) {
        const parts = input.split(" ");
        const command = parts[0].toLowerCase();
        const args = parts.slice(1);

        switch (command) {
          case "/link":
            this.sendLink();
            break;

          case "/chat":
            if (args.length === 0) {
              console.log("[错误] 用法: /chat <消息>");
            } else {
              this.sendChat(args.join(" "));
            }
            break;

          case "/file":
            if (args.length === 0) {
              console.log("[错误] 用法: /file <文件路径>");
            } else {
              await this.sendFile(args[0]);
            }
            break;

          case "/help":
            this.showHelp();
            break;

          case "/quit":
          case "/exit":
            console.log("[退出] 正在断开连接...");
            if (this.client) {
              this.client.end();
            }
            this.rl.close();
            process.exit(0);
            break;

          default:
            console.log(`[错误] 未知命令: ${command}`);
            console.log("输入 /help 查看可用命令");
        }
      } else {
        // 直接发送聊天消息
        this.sendChat(input);
      }

      this.rl.prompt();
    });

    this.rl.on("close", () => {
      console.log("\n[退出] 再见！");
      process.exit(0);
    });
  }
}

// 主函数
async function main() {
  // 从命令行参数获取服务器地址
  const args = process.argv.slice(2);
  const serverIp = args[0] || "127.0.0.1";
  const serverPort = args[1] ? parseInt(args[1]) : 18080;

  const client = new TcpTestClient(serverIp, serverPort);

  try {
    await client.start();
  } catch (error) {
    console.error(`[错误] 启动失败:`, error);
    process.exit(1);
  }
}

// 运行
main();

