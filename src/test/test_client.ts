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

/**
 * 从跨平台路径中提取文件名
 * 支持 Windows 路径（C:\path\file.txt）和 Unix 路径（/path/file.txt）
 */
function extractFileName(filePath: string): string {
  // 统一处理反斜杠和正斜杠
  const normalizedPath = filePath.replace(/\\/g, '/');
  const parts = normalizedPath.split('/');
  return parts[parts.length - 1] || 'unknown_file';
}

const udpClient = dgram.createSocket("udp4");
let retryManager: MessageRetryManager;

// 文件接收会话管理
interface FileReceiveSession {
  filePath: string;
  fd: number;
  receivedChunks: Set<number>;
  totalChunks: number;
  chunkSize: number;
  sessionId: string;
  senderIp: string;
  senderPort: number;
  resendAttempts: number;
}
const fileReceiveSessions = new Map<string, FileReceiveSession>();

// 文件发送会话管理
interface FileSendSession {
  filePath: string;
  fd: number;
  chunkCount: number;
  sentChunks: Set<number>;
  targetIp: string;
  targetPort: number;
}
const fileSendSessions = new Map<string, FileSendSession>();

// 消息去重：记录最近处理的消息ID（request消息）
const processedRequestMessages = new Set<string>();
const MAX_PROCESSED_MESSAGES = 1000; // 最多记录1000条

/**
 * 检查并记录消息ID，如果已处理过则返回true
 */
function isDuplicateRequest(messageId: string): boolean {
  if (processedRequestMessages.has(messageId)) {
    return true;
  }
  
  processedRequestMessages.add(messageId);
  
  // 限制缓存大小，防止内存泄漏
  if (processedRequestMessages.size > MAX_PROCESSED_MESSAGES) {
    const firstId = processedRequestMessages.values().next().value as string;
    if (firstId) {
      processedRequestMessages.delete(firstId);
    }
  }
  
  return false;
}

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
    
    // 创建发送会话
    const sessionId = `${remoteAddr}_${remotePort}_${filePath}_${Date.now()}`;
    fileSendSessions.set(sessionId, {
      filePath,
      fd,
      chunkCount,
      sentChunks: new Set<number>(),
      targetIp: remoteAddr,
      targetPort: remotePort
    });
    
    log(`[文件发送] 创建会话 ${sessionId}, 共 ${chunkCount} 块`);
    
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
          sessionId: sessionId,
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
      
      // 记录已发送的 chunk
      const session = fileSendSessions.get(sessionId);
      if (session) {
        session.sentChunks.add(i);
      }
    }
    
    // 不在这里关闭 fd，等待传输完成确认后再关闭
    log(`[文件发送] 已发送 ${chunkCount} 个 chunk 到 ${remoteAddr}:${remotePort}, 等待传输完成确认...`);
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
      // Reply 消息不需要去重检查，因为它们是对我们发出的 request 的响应
      // 可以直接返回，不再处理（reply消息通常只用于确认，不需要额外处理）
      return;
    }

    // 检查 request 消息是否重复
    if (msg.request && msg.id) {
      if (isDuplicateRequest(msg.id)) {
        // 重复的 request 消息，忽略（但仍需发送 reply 确认）
        // 注意：对于某些消息类型（如link、file），我们仍然需要发送reply
        // 但不执行实际的业务逻辑（如创建文件会话等）
        log(`[去重] 忽略重复的 ${msg.type} request, id=${msg.id}`);
        
        // 发送简单的 reply 确认
        retryManager.sendReply(
          msg.id,
          {
            type: msg.type,
            from: getClientId(),
            timestamp: Date.now(),
            request: false,
          },
          rinfo.address,
          rinfo.port
        );
        return;
      }
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
        `[接收] type=chunk, from=${rinfo.address}:${rinfo.port}, type=${type}, id=${msg.id || "N/A"}, index=${msg.chunk?.index}`
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
        
        // 保存接收到的 chunk
        if (msg.chunk && msg.value) {
          const sessionKey = msg.sessionId || `${rinfo.address}_${rinfo.port}_${msg.value}`;
          let session = fileReceiveSessions.get(sessionKey);
          
          // 首次接收该文件的 chunk，创建会话
          if (!session && msg.chunk.total) {
            const fileName = extractFileName(msg.value);
            const receivePath = `./received_${Date.now()}_${fileName}`;
            const fd = fs.openSync(receivePath, 'w');
            session = {
              filePath: receivePath,
              fd,
              receivedChunks: new Set<number>(),
              totalChunks: msg.chunk.total,
              chunkSize: 1024,
              sessionId: msg.sessionId || sessionKey,
              senderIp: rinfo.address,
              senderPort: rinfo.port,
              resendAttempts: 0
            };
            fileReceiveSessions.set(sessionKey, session);
            log(`[文件接收] 开始接收文件: ${msg.value}, 共 ${msg.chunk.total} 块, sessionId=${session.sessionId}`);
          }
          
          if (session) {
            // 写入 chunk 数据
            const buffer = Buffer.isBuffer(msg.chunk.data)
              ? msg.chunk.data
              : Buffer.from((msg.chunk.data as any).data);
            fs.writeSync(session.fd, buffer, 0, msg.chunk.size, msg.chunk.index * session.chunkSize);
            session.receivedChunks.add(msg.chunk.index);
            
            // 如果是最后一个 chunk，检查完整性
            if (msg.chunk.finish) {
              const missingChunks: number[] = [];
              for (let i = 0; i < session.totalChunks; i++) {
                if (!session.receivedChunks.has(i)) {
                  missingChunks.push(i);
                }
              }
              
              if (missingChunks.length > 0 && session.resendAttempts < 3) {
                // 请求补发
                log(`[文件接收] 文件不完整，请求补发 ${missingChunks.length} 个块...`);
                session.resendAttempts++;
                
                retryManager.sendWithRetry(
                  {
                    type: "chunk_resend_request",
                    from: getClientId(),
                    timestamp: Date.now(),
                    request: true,
                    sessionId: session.sessionId,
                    value: msg.value,
                    missingChunks: missingChunks
                  },
                  rinfo.address,
                  rinfo.port
                );
                
                return; // 不关闭文件，等待补发
              } else if (missingChunks.length > 0) {
                // 达到最大重试次数
                errorLog(
                  `[文件接收] 文件接收失败！缺失 ${missingChunks.length} 个块，已达最大重试次数`
                );
              } else {
                // 所有 chunk 都收到了
                log(`[文件接收] 文件接收完成: ${session.filePath}, 共 ${session.totalChunks} 块`);
                
                // 发送传输完成确认
                retryManager.sendWithRetry(
                  {
                    type: "transfer_complete",
                    from: getClientId(),
                    timestamp: Date.now(),
                    request: true,
                    sessionId: session.sessionId,
                    value: msg.value
                  },
                  rinfo.address,
                  rinfo.port
                );
              }
              
              fs.closeSync(session.fd);
              fileReceiveSessions.delete(sessionKey);
            } else {
              // 显示进度
              const progress = Math.floor((session.receivedChunks.size / session.totalChunks) * 100);
              if (session.receivedChunks.size % 10 === 0 || session.receivedChunks.size === session.totalChunks) {
                log(`[文件接收] 进度: ${progress}% (${session.receivedChunks.size}/${session.totalChunks})`);
              }
            }
          }
        }
      }
      return;
    }
    
    // 处理补发请求
    if (msg.type === "chunk_resend_request") {
      const type = msg.request ? "request" : msg.reply ? "reply" : "unknown";
      log(
        `[接收] type=chunk_resend_request, from=${rinfo.address}:${rinfo.port}, type=${type}, id=${msg.id || "N/A"}, 缺失 ${msg.missingChunks?.length || 0} 个块`
      );
      
      if (msg.request && msg.id) {
        // 发送回复确认
        retryManager.sendReply(
          msg.id,
          {
            type: "chunk_resend_request",
            from: getClientId(),
            timestamp: Date.now(),
            request: false,
          },
          rinfo.address,
          rinfo.port
        );
        
        // 处理补发请求
        const sessionId = msg.sessionId;
        const missingChunks = msg.missingChunks || [];
        const session = fileSendSessions.get(sessionId || "");
        
        if (session && missingChunks.length > 0) {
          log(`[文件发送] 补发 ${missingChunks.length} 个块`);
          
          for (const index of missingChunks) {
            if (index < 0 || index >= session.chunkCount) {
              continue;
            }
            
            try {
              const buffer = Buffer.alloc(chunkSize);
              const nbytes = fs.readSync(session.fd, buffer, 0, chunkSize, index * chunkSize);
              
              retryManager.sendWithRetry(
                {
                  type: "chunk",
                  value: session.filePath,
                  from: getClientId(),
                  timestamp: Date.now(),
                  request: true,
                  sessionId: sessionId,
                  chunk: {
                    index: index,
                    size: nbytes,
                    data: buffer.subarray(0, nbytes),
                    finish: index === session.chunkCount - 1,
                    total: session.chunkCount,
                  }
                },
                rinfo.address,
                rinfo.port
              );
            } catch (error) {
              errorLog(`补发 chunk ${index} 失败: ${error}`);
            }
          }
        }
      }
      return;
    }
    
    // 处理传输完成确认
    if (msg.type === "transfer_complete") {
      const type = msg.request ? "request" : msg.reply ? "reply" : "unknown";
      log(
        `[接收] type=transfer_complete, from=${rinfo.address}:${rinfo.port}, type=${type}, id=${msg.id || "N/A"}`
      );
      
      if (msg.request && msg.id) {
        // 发送回复确认
        retryManager.sendReply(
          msg.id,
          {
            type: "transfer_complete",
            from: getClientId(),
            timestamp: Date.now(),
            request: false,
          },
          rinfo.address,
          rinfo.port
        );
        
        // 清理发送会话
        const sessionId = msg.sessionId;
        const session = fileSendSessions.get(sessionId || "");
        if (session) {
          try {
            fs.closeSync(session.fd);
          } catch (error) {
            errorLog(`关闭文件句柄失败: ${error}`);
          }
          fileSendSessions.delete(sessionId || "");
          log(`[文件发送] 传输完成，会话已清理: ${extractFileName(session.filePath)}`);
        }
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
