import * as dgram from "dgram";
import * as readline from "readline";

// 全局变量配置
const CLIENT_IP = "192.168.10.21"; // 本机监听地址
const CLIENT_PORT = 18081; // 测试客户端端口
const CLIENT_USERNAME = "TestClient"; // 测试客户端用户名

// 目标服务器配置（LNIM 扩展所在的主机）
let remoteIp = "192.168.10.21";
let remotePort = 18080;

// 生成客户端 ID
function getClientId(): string {
  return Buffer.from(
    `${CLIENT_USERNAME}:${CLIENT_IP}:${CLIENT_PORT}`,
    "utf-8"
  ).toString("base64");
}

// 创建 UDP Socket
const udpClient = dgram.createSocket("udp4");

// 简单 TUI：使用 readline 实现输入与消息显示
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: "> ",
});

// 封装日志输出，避免打断输入行
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
      return; // log already prompts
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

    errorLog(`未知命令: ${cmd}`);
    return;
  }

  sendChat(text, remoteIp, remotePort);
  // sendChat logs, which prompts
});

function sendLink(ip: string, port: number) {
  const payload = {
    type: "link",
    from: getClientId(),
    linkType: "request" as const,
    timestamp: Date.now(),
  };
  const buf = Buffer.from(JSON.stringify(payload), "utf8");
  udpClient.send(buf, port, ip, (err) => {
    if (err) {
      errorLog(`发送 link 消息到 ${ip}:${port} 失败: ${err.message}`);
    } else {
      log(
        `[${new Date().toLocaleTimeString()}] 已向 ${ip}:${port} 发送 link 消息`
      );
    }
  });
}

function sendChat(message: string, ip: string, port: number) {
  const payload = {
    type: "chat",
    from: getClientId(),
    message,
		timestamp: Date.now(),
  };
  const buf = Buffer.from(JSON.stringify(payload), "utf8");
  udpClient.send(buf, port, ip, (err) => {
    if (err) {
      errorLog(`发送消息到 ${ip}:${port} 失败: ${err.message}`);
    } else {
      log(
        `[${new Date().toLocaleTimeString()}] 已向 ${ip}:${port} 发送消息: ${message}`
      );
    }
  });
}

// 处理收到的消息
udpClient.on("message", (data, rinfo) => {
  try {
    const text = data.toString("utf8");

    // 尝试解析 JSON
    let payload: any;
    try {
      payload = JSON.parse(text);
    } catch {
      log(
        `[${new Date().toLocaleTimeString()}] 收到来自 ${rinfo.address}:${
          rinfo.port
        } 的非 JSON 消息: ${text}`
      );
      return;
    }

    // 处理 type 为 link 的消息
    if (payload && payload.type === "link") {
      const linkMsg = payload as any;
      if (linkMsg.linkType !== "request" && linkMsg.linkType !== "reply") {
        log(`[${new Date().toLocaleTimeString()}] 收到未知类型的 link 消息: ${JSON.stringify(
          linkMsg
        )}`);
        return;
      }
      const isReply = linkMsg.linkType === "reply";
      log(
        `[${new Date().toLocaleTimeString()}] 收到 link 消息来自 ${
          rinfo.address
        }:${rinfo.port} (ID: ${linkMsg.from}, Type: ${linkMsg.linkType})`
      );

      if (!isReply) {
        log(payload);

        // 发送 Reply 类型的 link 消息
        const replyPayload = {
          type: "link",
          from: getClientId(),
          linkType: "reply" as const,
          timestamp: Date.now(),
        };

        const replyBuf = Buffer.from(JSON.stringify(replyPayload), "utf8");
        udpClient.send(replyBuf, rinfo.port, rinfo.address, (err) => {
          if (err) {
            errorLog(`发送 link 消息 (reply) 到 ${rinfo.address}:${rinfo.port} 失败: ${err.message}`);
          } else {
            log(
              `[${new Date().toLocaleTimeString()}] 已向 ${rinfo.address}:${rinfo.port} 发送 link 消息 (reply)`
            );
          }
        });
      }
      return;
    }

    // 处理 ChatMessage
    if (payload && payload.type === "chat") {
      const nickname =
        (payload.from && payload.from.nickname) || payload.from || "未知";
      const msgText = payload.message || "";
      log(
        `[${new Date().toLocaleTimeString()}] ${nickname}@${rinfo.address}:${
          rinfo.port
        }: ${msgText}`
      );
      return;
    }

    // 处理其他类型的消息
    log(
      `[${new Date().toLocaleTimeString()}] 收到 ${
        payload.type || "未知"
      } 消息来自 ${rinfo.address}:${rinfo.port}\n  ${JSON.stringify(
        payload,
        null,
        2
      )}`
    );
  } catch (e) {
    errorLog(`处理消息时出错: ${e}`);
  }
});

// 处理错误
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

// 启动 UDP 服务器并进入 TUI 主循环
udpClient.bind(CLIENT_PORT, CLIENT_IP, () => {
  printBanner();
});

// 优雅退出处理
process.on("SIGINT", () => {
  shutdown();
});

process.on("SIGTERM", () => {
  shutdown();
});
