import * as net from "net";

/**
 * TCP消息类型定义（与ChatMessage保持一致）
 */
interface ChatMessage {
  type: "chat" | "link" | "chunk" | "fend" | "file" | "fstats";
  from: string;
  timestamp: number;
  value?: string;
  target?: string[];
  files?: string[];
  unique?: string;
  fd?: number;
}

/**
 * TCP测试服务端：接收并打印消息
 */
class TcpTestServer {
  private readonly host: string;
  private readonly port: number;
  private server?: net.Server;

  constructor(host: string = "0.0.0.0", port: number = 19090) {
    this.host = host;
    this.port = port;
  }

  public start(): void {
    this.server = net.createServer((socket) => this.handleConnection(socket));

    this.server.on("error", (err) => {
      console.error(`[服务端] ❌ 服务器错误: ${err.message}`);
      process.exit(1);
    });

    this.server.listen(this.port, this.host, () => {
      console.log("========================================");
      console.log("     LNIM TCP测试服务端");
      console.log("========================================");
      console.log(`[监听] ${this.host}:${this.port}`);
      console.log("========================================\n");
    });
  }

  private handleConnection(socket: net.Socket): void {
    const peer = `${socket.remoteAddress ?? "unknown"}:${socket.remotePort ?? "unknown"}`;
    console.log(`[连接] ✅ 新连接: ${peer}`);

    socket.on("data", (buffer) => this.handleData(peer, socket, buffer));
    socket.on("end", () => console.log(`[连接] ❌ 断开连接(end): ${peer}`));
    socket.on("close", () => console.log(`[连接] ❌ 断开连接(close): ${peer}`));
    socket.on("error", (err) => console.error(`[连接] ❌ Socket错误(${peer}): ${err.message}`));
  }

  private handleData(peer: string, socket: net.Socket, buffer: Buffer): void {
    console.log(`收到消息:${buffer.length}`);
    // 先尽量按JSON消息解析（支持末尾带换行）
    const text = buffer.toString("utf8").trim();
    if (text.length > 0) {
      try {
        const msg = JSON.parse(text) as ChatMessage;
        this.printJsonMessage(peer, socket, msg);
        return;
      } catch {
        // fallthrough：可能是文件分块等二进制数据
      }
    }

    // 兼容ChatMessageService里的分块格式：前8字节是uniqueId(hex)，后面是数据
    if (buffer.length >= 8) {
      const chunkId = buffer.subarray(0, 8).toString("hex");
      const chunkData = buffer.subarray(8);
      console.log(
        `[${new Date().toLocaleTimeString()}] 📦 收到二进制块: peer=${peer}, chunkId=${chunkId}, bytes=${chunkData.length}`,
      );
      return;
    }

    console.log(
      `[${new Date().toLocaleTimeString()}] 📦 收到未知数据: peer=${peer}, bytes=${buffer.length}`,
    );
  }

  private printJsonMessage(peer: string, socket: net.Socket, msg: ChatMessage): void {
    const timestamp = msg.timestamp ? new Date(msg.timestamp).toLocaleTimeString() : new Date().toLocaleTimeString();
    console.log(
      `\n[${timestamp}] 📨 收到JSON消息: peer=${peer}, type=${msg.type}, from=${msg.from}`,
    );

    // 专门把 link 消息内容完整打印出来，便于对接排查
    if (msg.type === "link") {
      const decodedFrom = this.tryDecodeBase64(msg.from);
      if (decodedFrom) {
        console.log(`  from(解码): ${decodedFrom}`);
      }
      console.log(`  link(完整JSON):\n${JSON.stringify(msg, null, 2)}`);

      // 回一个 link 消息，便于对端确认链路
      const reply: ChatMessage = {
        type: "link",
        from: this.selfId(),
        timestamp: Date.now(),
      };
      try {
        socket.write(JSON.stringify(reply));
        console.log(`  link(回包):\n${JSON.stringify(reply, null, 2)}`);
      } catch (error) {
        console.error(`  [错误] link回包失败: ${(error as Error).message}`);
      }
      return;
    }

    if (msg.value !== undefined) {
      console.log(`  value: ${msg.value}`);
    }
    if (msg.unique !== undefined) {
      console.log(`  unique: ${msg.unique}`);
    }
    if (msg.fd !== undefined) {
      console.log(`  fd: ${msg.fd}`);
    }
    if (msg.files && msg.files.length > 0) {
      console.log(`  files: ${msg.files.join(", ")}`);
    }
    if (msg.target && msg.target.length > 0) {
      console.log(`  target: ${msg.target.join(", ")}`);
    }
  }

  private selfId(): string {
    return Buffer.from(`测试服务端-${this.host}:${this.port}`).toString("base64");
  }

  private tryDecodeBase64(value: string): string | undefined {
    try {
      const decoded = Buffer.from(value, "base64").toString("utf8");
      // 如果解码结果里全是不可见字符，通常说明不是我们期望的base64文本
      if (!decoded || decoded.trim().length === 0) {
        return undefined;
      }
      return decoded;
    } catch {
      return undefined;
    }
  }
}

// 主函数
function main() {
  const args = process.argv.slice(2);
  const host = args[0] || "0.0.0.0";
  const port = args[1] ? parseInt(args[1], 10) : 19090;

  const server = new TcpTestServer(host, Number.isFinite(port) ? port : 19090);
  server.start();
}

main();
