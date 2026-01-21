import * as net from "net";
import * as readline from "readline";
import * as fs from "fs";
import * as path from "path";

/**
 * TCP消息类型定义
 */
interface TcpMessage {
  type: "chat" | "link" | "file_meta" | "file_data" | "file_complete" | "heartbeat";
  from: string;
  timestamp: number;
  value?: string;
  isReply?: boolean;
  fileName?: string;
  fileSize?: number;
  sessionId?: string;
  data?: string;
  offset?: number;
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

      this.client = net.connect(this.serverPort, this.serverIp, () => {
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
    this.receiveBuffer = Buffer.concat([this.receiveBuffer, chunk]);

    // 尝试解析消息（以\n分隔）
    let newlineIndex: number;
    while ((newlineIndex = this.receiveBuffer.indexOf("\n")) !== -1) {
      const messageData = this.receiveBuffer.slice(0, newlineIndex);
      this.receiveBuffer = this.receiveBuffer.slice(newlineIndex + 1);

      try {
        const message = JSON.parse(messageData.toString("utf8")) as TcpMessage;
        this.handleMessage(message);
      } catch (error) {
        console.error(`[错误] 解析消息失败:`, error);
      }
    }
  }

  /**
   * 处理接收到的消息
   */
  private handleMessage(msg: TcpMessage): void {
    const timestamp = new Date(msg.timestamp).toLocaleTimeString();

    switch (msg.type) {
      case "link":
        console.log(`\n[${timestamp}] 📡 收到Link消息 - isReply: ${msg.isReply}, from: ${msg.from}`);
        break;

      case "chat":
        console.log(`\n[${timestamp}] 💬 收到聊天消息: ${msg.value}`);
        break;

      case "heartbeat":
        // 静默处理心跳
        // console.log(`[${timestamp}] ❤️ 收到心跳`);
        break;

      case "file_meta":
        console.log(`\n[${timestamp}] 📁 收到文件元数据 - 文件: ${msg.fileName}, 大小: ${msg.fileSize} bytes`);
        break;

      case "file_data":
        console.log(`\n[${timestamp}] 📦 收到文件数据 - offset: ${msg.offset}`);
        break;

      case "file_complete":
        console.log(`\n[${timestamp}] ✅ 文件传输完成 - sessionId: ${msg.sessionId}`);
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
  private sendMessage(msg: TcpMessage): void {
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
    const msg: TcpMessage = {
      type: "link",
      from: this.clientId,
      timestamp: Date.now(),
      isReply: false,
    };

    this.sendMessage(msg);
    console.log("[发送] 📡 已发送Link消息");
  }

  /**
   * 发送聊天消息
   */
  private sendChat(message: string): void {
    const msg: TcpMessage = {
      type: "chat",
      from: this.clientId,
      timestamp: Date.now(),
      value: message,
    };

    this.sendMessage(msg);
    console.log(`[发送] 💬 已发送聊天消息: ${message}`);
  }

  /**
   * 发送文件
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
    const sessionId = `${this.clientId}_${Date.now()}`;

    console.log(`[文件] 📤 准备发送文件: ${fileName} (${fileSize} bytes)`);

    // 1. 发送文件元数据
    const metaMsg: TcpMessage = {
      type: "file_meta",
      from: this.clientId,
      timestamp: Date.now(),
      fileName: filePath,
      fileSize,
      sessionId,
    };
    this.sendMessage(metaMsg);

    // 2. 读取并发送文件数据
    const fd = fs.openSync(filePath, "r");
    const chunkSize = 64 * 1024; // 64KB per chunk
    let offset = 0;

    try {
      while (offset < fileSize) {
        const buffer = Buffer.alloc(chunkSize);
        const bytesRead = fs.readSync(fd, buffer, 0, chunkSize, offset);

        const dataMsg: TcpMessage = {
          type: "file_data",
          from: this.clientId,
          timestamp: Date.now(),
          sessionId,
          data: buffer.subarray(0, bytesRead).toString("base64"),
          offset,
        };

        this.sendMessage(dataMsg);

        offset += bytesRead;
        const progress = ((offset / fileSize) * 100).toFixed(2);
        process.stdout.write(`\r[文件] 发送进度: ${progress}%`);

        // 小延迟，避免发送过快
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      console.log(); // 换行

      // 3. 发送完成消息
      const completeMsg: TcpMessage = {
        type: "file_complete",
        from: this.clientId,
        timestamp: Date.now(),
        sessionId,
      };
      this.sendMessage(completeMsg);

      fs.closeSync(fd);
      console.log(`[文件] ✅ 文件发送完成: ${fileName}`);
    } catch (error) {
      fs.closeSync(fd);
      console.error(`[错误] 文件发送失败:`, error);
    }
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

