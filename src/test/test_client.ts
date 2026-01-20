import * as dgram from "dgram";
import * as fs from "fs";
import * as readline from "readline";
import { ChatMessage } from "../chat_message_service";
import { MessageRetryManager } from "../message_retry_manager";

const CLIENT_IP = "192.168.10.21";
const CLIENT_PORT = 18081;
const CLIENT_USERNAME = "TestClient";

let remoteIp = "192.168.10.21";
let remotePort = 18080;

function getClientId(): string {
  return Buffer.from(
    `${CLIENT_USERNAME}-${CLIENT_IP}:${CLIENT_PORT}`,
    "utf-8"
  ).toString("base64");
}

const udpClient = dgram.createSocket("udp4");
let retryManager: MessageRetryManager;

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: "> ",
});

function log(msg: string) {
  readline.clearLine(process.stdout, 0);
  readline.cursorTo(process.stdout, 0);
  console.log(msg);
  updatePrompt();
  rl.prompt(true);
}

function errorLog(msg: string) {
  readline.clearLine(process.stdout, 0);
  readline.cursorTo(process.stdout, 0);
  console.error(msg);
  updatePrompt();
  rl.prompt(true);
}

function updatePrompt() {
  rl.setPrompt(`[Target: ${remoteIp}:${remotePort}]> `);
}

function printBanner() {
  console.log("=".repeat(50));
  console.log("UDP 测试客户端已启动 (TUI 模式)");
  console.log("=".repeat(50));
  console.log(`本机地址: ${CLIENT_IP}`);
  console.log(`本机端口: ${CLIENT_PORT}`);
  console.log(`用户名: ${CLIENT_USERNAME}`);
  console.log(`客户端 ID: ${getClientId()}`);
  console.log("-".repeat(50));
  console.log(`当前默认目标: ${remoteIp}:${remotePort}`);
  console.log("指令说明：");
  console.log("  直接输入内容 -> 发送 Chat 消息给默认目标");
  console.log("  /link        -> 发送 link 探测消息给默认目标");
  console.log("  /target <ip> <port> -> 修改默认目标地址");
  console.log("  /send <ip> <port> <msg> -> 向指定地址发送一次性消息");
  console.log("  /file <path> -> 向默认目标发送文件消息");
  console.log("  /quit        -> 退出客户端");
  console.log("=".repeat(50));
  updatePrompt();
  rl.prompt();
}

rl.on("line", (line) => {
  const text = line.trim();
  if (!text) {
    rl.prompt();
    return;
  }

  if (text.startsWith("/")) {
    const parts = text.split(/\s+/);
    const cmd = parts[0].toLowerCase();

    if (cmd === "/quit") {
      shutdown();
      return;
    }

    if (cmd === "/link") {
      sendLink(remoteIp, remotePort);
      rl.prompt();
      return;
    }

    if (cmd === "/target") {
      if (parts.length !== 3) {
        errorLog("用法: /target <ip> <port>");
      } else {
        remoteIp = parts[1];
        remotePort = parseInt(parts[2], 10);
        log(`默认目标已更新为: ${remoteIp}:${remotePort}`);
      }
      return;
    }

    if (cmd === "/send") {
      if (parts.length < 4) {
        errorLog("用法: /send <ip> <port> <msg>");
      } else {
        const targetIp = parts[1];
        const targetPort = parseInt(parts[2], 10);
        const msg = parts.slice(3).join(" ");
        sendChat(msg, targetIp, targetPort);
      }
      return;
    }

    if (cmd === "/file") {
      if (parts.length < 2) {
        errorLog("用法: /file <path>");
      } else {
        const filePath = parts.slice(1).join(" ");
        sendFileMessage(filePath, remoteIp, remotePort);
      }
      return;
    }

    errorLog(`未知命令: ${cmd}`);
    return;
  }

  sendChat(text, remoteIp, remotePort);
});

function sendLink(ip: string, port: number) {
  retryManager.sendWithRetry(
    {
      type: "link",
      from: getClientId(),
      timestamp: Date.now(),
      request: true,
    },
    ip,
    port
  );
  log(
    `[发送] type=link, to=${ip}:${port}, request=true`
  );
}

function sendChat(message: string, ip: string, port: number) {
  retryManager.sendWithRetry(
    {
      type: "chat",
      from: getClientId(),
      timestamp: Date.now(),
      value: message,
      request: true, // 原始消息，需要确认
    },
    ip,
    port
  );
  log(
    `[发送] type=chat, to=${ip}:${port}, request=true`
  );
}

function sendFileMessage(filePath: string, ip: string, port: number) {
  const message = `这是一个文件 {#${filePath}}`;
  retryManager.sendWithRetry(
    {
      type: "chat",
      from: getClientId(),
      timestamp: Date.now(),
      value: message,
      request: true, // 原始消息，需要确认
    },
    ip,
    port
  );
  log(
    `[发送] type=chat(file), to=${ip}:${port}, request=true`
  );
}

const chunkSize: number = 1024;

function handleSendFile(filePath: string, from: string, remoteAddr: string, remotePort: number, requestMsgId: string) {
  // 1. 发送 file 类型的 reply
  retryManager.sendReply(
    requestMsgId,
    {
      type: "file",
      from: getClientId(),
      timestamp: Date.now(),
      request: false,
      value: filePath,
    },
    remoteAddr,
    remotePort
  );
  log(`[发送] type=file, to=${remoteAddr}:${remotePort}, type=reply, id=${requestMsgId}`);

  try {
    const stat = fs.statSync(filePath);
    const chunkCount = Math.ceil(stat.size / chunkSize);
    const fd = fs.openSync(filePath, "r");
    for (let i = 0; i < chunkCount; i++) {
      const buffer = Buffer.alloc(chunkSize);
      const nbytes = fs.readSync(fd, buffer, 0, chunkSize, i * chunkSize);
      
      // 2. 发送 request 类型的 chunk
      const chunkMsgId = retryManager.sendWithRetry(
        {
          type: "chunk",
          value: filePath,
          from: getClientId(),
          timestamp: Date.now(),
          request: true,
          chunk: {
            index: i,
            size: nbytes,
            data: buffer,
            finish: i === chunkCount - 1,
            total: chunkCount,
          }
        },
        remoteAddr,
        remotePort
      );
    }
    fs.closeSync(fd);
    log(`[发送] type=chunk, to=${remoteAddr}:${remotePort}, type=reply, id=${requestMsgId}, count=${chunkCount}`);
  } catch (err) {
    errorLog(`发送文件失败: ${err}`);
  }
}


udpClient.on("message", (data, rinfo) => {
  try {
    const text = data.toString("utf8");

    let payload: any;
    try {
      payload = JSON.parse(text);
    } catch {
      log(
        `[${new Date().toLocaleTimeString()}] 收到来自 ${rinfo.address}:${rinfo.port} 的非 JSON 消息: ${text}`
      );
      return;
    }

    const msg = payload as ChatMessage;

    // 检查是否为回复消息
    if (msg.reply && msg.id) {
      retryManager.markAsReceived(msg.id);
    }

    if (msg.type === "link") {
      const isRequest = msg.request;
			const type = msg.request ? "request" : msg.reply ? "reply" : "unknown";
      log(
        `[接收] type=link, from=${rinfo.address}:${rinfo.port}, type=${type}, id=${msg.id || "N/A"}`
      );

      if (isRequest && msg.id) {
        retryManager.sendReply(
          msg.id,
          {
            type: "link",
            from: getClientId(),
            timestamp: Date.now(),
            request: false,
          },
          rinfo.address,
          rinfo.port
        );
        log(
          `[发送] type=link, to=${rinfo.address}:${rinfo.port}, type=reply, id=${msg.id}`
        );
      }
      return;
    }

    if (msg.type === "chat") {
      const type = msg.request ? "request" : msg.reply ? "reply" : "unknown";
      log(
        `[接收] type=chat, from=${rinfo.address}:${rinfo.port}, type=${type}, id=${msg.id || "N/A"}`
      );
      return;
    }

    if (msg.type === "file") {
      const type = msg.request ? "request" : msg.reply ? "reply" : "unknown";
      log(
        `[接收] type=file, from=${rinfo.address}:${rinfo.port}, type=${type}, id=${msg.id || "N/A"}`
      );
      const filePath = typeof msg.value === "string" ? msg.value : "";
      if (filePath && msg.request && msg.id) {
        handleSendFile(filePath, msg.from, rinfo.address, rinfo.port, msg.id);
      }
      return;
    }

    // 处理 chunk 消息
    if (msg.type === "chunk") {
      const type = msg.request ? "request" : msg.reply ? "reply" : "unknown";
      log(
        `[接收] type=chunk, from=${rinfo.address}:${rinfo.port}, type=${type}, id=${msg.id || "N/A"}`
      );
      
      // 如果是请求消息，需要发送回复确认
      if (msg.request && msg.id) {
        retryManager.sendReply(
          msg.id,
          {
            type: "chunk",
            from: getClientId(),
            timestamp: Date.now(),
            request: false,
            value: msg.value || "",
          },
          rinfo.address,
          rinfo.port
        );
        log(
          `[发送] type=chunk, to=${rinfo.address}:${rinfo.port}, type=reply, id=${msg.id}`
        );
      }
      return;
    }
    
    // 其他未知类型消息
    const type = msg.request ? "request" : msg.reply ? "reply" : "unknown";
    log(
      `[接收] type=${msg.type || "unknown"}, from=${rinfo.address}:${rinfo.port}, type=${type}, id=${msg.id || "N/A"}`
    );
  } catch (e) {
    errorLog(`处理消息时出错: ${e}`);
  }
});

udpClient.on("error", (err) => {
  errorLog(`UDP 客户端错误: ${err.message}`);
});

function shutdown() {
  console.log("\n正在关闭 UDP 客户端...");
  rl.close();
  udpClient.close(() => {
    console.log("UDP 客户端已关闭");
    process.exit(0);
  });
}

udpClient.bind(CLIENT_PORT, CLIENT_IP, () => {
  // 初始化重试管理器
  // 可以在这里配置重试参数，默认: retryInterval=5000ms, maxRetries=-1(无限重试)
  const retryInterval = 5000; // 5秒
  const maxRetries = -1; // 无限重试
  retryManager = new MessageRetryManager(udpClient, retryInterval, maxRetries);
  printBanner();
});

process.on("SIGINT", () => {
  shutdown();
});

process.on("SIGTERM", () => {
  shutdown();
});
