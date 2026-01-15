import * as dgram from "dgram";
import { LinkMessage } from "./lnim_message";

// 全局变量配置
const CLIENT_IP = "10.110.4.12"; // 监听所有网络接口
const CLIENT_PORT = 18081; // 测试客户端端口
const CLIENT_USERNAME = "TestClient"; // 测试客户端用户名

// 生成客户端 ID
function getClientId(): string {
  return Buffer.from(
    `${CLIENT_USERNAME}:${CLIENT_IP}:${CLIENT_PORT}`,
    "utf-8"
  ).toString("base64");
}

// 创建 UDP Socket
const udpClient = dgram.createSocket("udp4");

// 处理收到的消息
udpClient.on("message", (data, rinfo) => {
  try {
    const text = data.toString("utf8");
    console.log(
      `[${new Date().toLocaleTimeString()}] 收到来自 ${rinfo.address}:${rinfo.port} 的消息:`,
      text
    );

    // 尝试解析 JSON
    let payload: any;
    try {
      payload = JSON.parse(text);
    } catch (err) {
      console.log("  非 JSON 消息，已忽略");
      return;
    }

    // 处理 LinkMessage
    if (payload && payload.type === "link") {
      const linkMsg = payload as LinkMessage;
      console.log("  消息类型: LinkMessage");
      console.log("  发送者 ID:", linkMsg.from);
      console.log("  是否为回复:", linkMsg.reply || false);

      // 如果不是回复消息，则发送回复
      if (!linkMsg.reply) {
        const replyPayload: LinkMessage = {
          type: "link",
          from: getClientId(),
          reply: true,
        };
        const replyBuf = Buffer.from(JSON.stringify(replyPayload), "utf8");
        udpClient.send(replyBuf, rinfo.port, rinfo.address, (err) => {
          if (err) {
            console.error("  发送 LinkMessage 回复失败:", err);
          } else {
            console.log(
              `  已向 ${rinfo.address}:${rinfo.port} 发送 LinkMessage 回复`
            );
          }
        });
      }
      return;
    }

    // 处理 ChatMessage
    if (payload && payload.type === "chat") {
      console.log("  消息类型: ChatMessage");
      console.log("  发送者:", payload.from?.nickname || payload.from || "未知");
      console.log("  消息内容:", payload.message || "");
      return;
    }

    // 处理其他类型的消息
    console.log("  消息类型:", payload.type || "未知");
    console.log("  完整消息内容:", JSON.stringify(payload, null, 2));
  } catch (e) {
    console.error("处理消息时出错:", e);
  }
});

// 处理错误
udpClient.on("error", (err) => {
  console.error("UDP 客户端错误:", err);
});

// 启动 UDP 服务器
udpClient.bind(CLIENT_PORT, CLIENT_IP, () => {
  console.log("=".repeat(50));
  console.log("UDP 测试客户端已启动");
  console.log("=".repeat(50));
  console.log(`监听地址: ${CLIENT_IP}`);
  console.log(`监听端口: ${CLIENT_PORT}`);
  console.log(`用户名: ${CLIENT_USERNAME}`);
  console.log(`客户端 ID: ${getClientId()}`);
  console.log("=".repeat(50));
  console.log("等待接收消息...");
  console.log("");
});

// 优雅退出处理
process.on("SIGINT", () => {
  console.log("\n正在关闭 UDP 客户端...");
  udpClient.close(() => {
    console.log("UDP 客户端已关闭");
    process.exit(0);
  });
});

process.on("SIGTERM", () => {
  console.log("\n正在关闭 UDP 客户端...");
  udpClient.close(() => {
    console.log("UDP 客户端已关闭");
    process.exit(0);
  });
});

