import * as dgram from "dgram";
import * as fs from "fs";
import * as readline from "readline";
import { ChatMessage } from "../chat_message_service";

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
 */
function extractFileName(filePath: string): string {
  const normalizedPath = filePath.replace(/\\/g, '/');
  const parts = normalizedPath.split('/');
  return parts[parts.length - 1] || 'unknown_file';
}

const udpClient = dgram.createSocket("udp4");

// 文件接收会话管理
interface FileReceiveSession {
  filePath: string;
  receivedChunks: Set<number>;
  totalChunks: number;
  chunkSize: number;
  sessionId: string;
  senderIp: string;
  senderPort: number;
  startTime: number; // 开始时间
  fileSize: number; // 文件大小
  buffer: Buffer; // 内存缓冲区
}
const fileReceiveSessions = new Map<string, FileReceiveSession>();

// 文件发送会话管理
interface FileSendSession {
  filePath: string;
  fd: number;
  chunkCount: number;
  targetIp: string;
  targetPort: number;
  startTime: number; // 开始时间
}
const fileSendSessions = new Map<string, FileSendSession>();

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

function sendMessage(message: ChatMessage, ip: string, port: number) {
  const buf = Buffer.from(JSON.stringify(message), "utf8");
  udpClient.send(buf, port, ip, (err) => {
    if (err) {
      errorLog(`发送消息失败: ${err.message}`);
    }
  });
}

function printBanner() {
  console.log("=".repeat(50));
  console.log("UDP 测试客户端已启动 (简化版)");
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
  sendMessage(
    {
      type: "link",
      from: getClientId(),
      timestamp: Date.now(),
      isReply: false, // 主动发送的link消息
    },
    ip,
    port
  );
  log(`[发送] type=link, to=${ip}:${port}`);
}

function sendChat(message: string, ip: string, port: number) {
  sendMessage(
    {
      type: "chat",
      from: getClientId(),
      timestamp: Date.now(),
      value: message,
    },
    ip,
    port
  );
  log(`[发送] type=chat, to=${ip}:${port}`);
}

function sendFileMessage(filePath: string, ip: string, port: number) {
  const message = `这是一个文件 {#${filePath}}`;
  sendMessage(
    {
      type: "chat",
      from: getClientId(),
      timestamp: Date.now(),
      value: message,
    },
    ip,
    port
  );
  log(`[发送] type=chat(file), to=${ip}:${port}`);
}

// 优化chunk大小以适应MTU限制
// 考虑：以太网MTU 1500 - IP头20 - UDP头8 = 1472 bytes可用
// JSON元数据约270 bytes，Buffer在JSON中会膨胀
// 为避免IP分片，chunk数据应该较小
// 256 bytes数据 + 元数据 ≈ 800 bytes < 1472 bytes (安全)
const chunkSize: number = 256;

async function handleChunkRequest(filePath: string, remoteAddr: string, remotePort: number, requestChunks?: number[], sessionId?: string) {
  try {
    const stat = fs.statSync(filePath);
    const chunkCount = Math.ceil(stat.size / chunkSize);
    const fd = fs.openSync(filePath, "r");
    
    // 创建或查找发送会话
    const sid = sessionId || `${remoteAddr}_${remotePort}_${filePath}_${Date.now()}`;
    
    let session = fileSendSessions.get(sid);
    const startTime = Date.now();
    
    if (!session) {
      session = {
        filePath,
        fd,
        chunkCount,
        targetIp: remoteAddr,
        targetPort: remotePort,
        startTime: startTime
      };
      fileSendSessions.set(sid, session);
      const fileName = extractFileName(filePath);
      const fileSizeMB = (stat.size / (1024 * 1024)).toFixed(2);
      log(`[文件发送] 📤 开始发送: ${fileName} (${fileSizeMB} MB, ${chunkCount} 块)`);
    }

    // 确定要发送的chunk列表
    const chunksToSend = requestChunks || Array.from({length: chunkCount}, (_, i) => i);
    
    // 降低批次大小，增加延迟时间，确保接收端有足够时间处理
    // 100个chunk × 256 bytes = 25.6 KB/批
    const batchSize = 100;
    const batchDelay = 20; // 增加到20ms
    
    // 批量发送chunk，避免UDP缓冲区溢出
    for (let batchStart = 0; batchStart < chunksToSend.length; batchStart += batchSize) {
      const batchEnd = Math.min(batchStart + batchSize, chunksToSend.length);
      
      // 批量发送当前批次的chunk
      for (let idx = batchStart; idx < batchEnd; idx++) {
        const i = chunksToSend[idx];
        
        if (i < 0 || i >= chunkCount) {
          continue;
        }
        
        const buffer = Buffer.alloc(chunkSize);
        const nbytes = fs.readSync(fd, buffer, 0, chunkSize, i * chunkSize);
        
        sendMessage(
          {
            type: "chunk",
            value: filePath,
            from: getClientId(),
            timestamp: Date.now(),
            sessionId: sid,
            chunk: {
              index: i,
              size: nbytes,
              data: buffer.subarray(0, nbytes),
              total: chunkCount,
            }
          },
          remoteAddr,
          remotePort
        );
      }
      
      // 每批次之间延迟，给接收方时间处理
      if (batchEnd < chunksToSend.length) {
        await new Promise(resolve => setTimeout(resolve, batchDelay));
        
        if (batchEnd % 1000 === 0) {
          log(`[文件发送] 进度: ${Math.floor((batchEnd / chunkCount) * 100)}% (${batchEnd}/${chunkCount})`);
        }
      }
    }
    
    const sendTime = ((Date.now() - startTime) / 1000).toFixed(2);
    
    if (!requestChunks) {
      const fileName = extractFileName(filePath);
      const fileSizeMB = (stat.size / (1024 * 1024)).toFixed(2);
      const speedMBps = (stat.size / (1024 * 1024) / parseFloat(sendTime)).toFixed(2);
      log(`[文件发送] ✅ 发送完成: ${fileName} (${fileSizeMB} MB, 耗时: ${sendTime}s, 速度: ${speedMBps} MB/s)`);
    } else {
      log(`[文件发送] 已补发 ${requestChunks.length} 个 chunk (耗时: ${sendTime}s)`);
    }
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

    if (msg.type === "link") {
      log(`[接收] type=link, from=${rinfo.address}:${rinfo.port}, isReply=${msg.isReply || false}`);
      
      // 只在收到非回复的link消息时才回复（防止无限循环）
      if (!msg.isReply) {
        sendMessage(
          {
            type: "link",
            from: getClientId(),
            timestamp: Date.now(),
            isReply: true, // 标记为回复消息
          },
          rinfo.address,
          rinfo.port
        );
        log(`[自动回复] type=link, to=${rinfo.address}:${rinfo.port}, isReply=true`);
      }
      return;
    }

    if (msg.type === "chat") {
      log(`[接收] type=chat, from=${rinfo.address}:${rinfo.port}, message=${msg.value}`);
      return;
    }

    if (msg.type === "chunk") {
      // 如果有chunk数据，说明是接收chunk
      if (msg.chunk && typeof msg.chunk.index === 'number') {
        // 保存接收到的 chunk
        if (msg.value) {
          const sessionKey = msg.sessionId || `${rinfo.address}_${rinfo.port}_${msg.value}`;
          let session = fileReceiveSessions.get(sessionKey);
          
          // 首次接收该文件的 chunk，创建会话
          if (!session && msg.chunk.total) {
            const fileName = extractFileName(msg.value);
            const receivePath = `./received_${Date.now()}_${fileName}`;
            const fileSize = msg.chunk.total * 256; // 估算文件大小
            const fileSizeMB = (fileSize / (1024 * 1024)).toFixed(2);
            
            // 创建内存缓冲区
            const fileBuffer = Buffer.alloc(fileSize);
            
            session = {
              filePath: receivePath,
              receivedChunks: new Set<number>(),
              totalChunks: msg.chunk.total,
              chunkSize: 256, // 与发送端保持一致
              sessionId: msg.sessionId || sessionKey,
              senderIp: rinfo.address,
              senderPort: rinfo.port,
              startTime: Date.now(),
              fileSize: fileSize,
              buffer: fileBuffer
            };
            fileReceiveSessions.set(sessionKey, session);
            log(`[文件接收] 📥 开始接收: ${fileName} (~${fileSizeMB} MB, ${msg.chunk.total} 块)`);
          }
          
          if (session) {
            // 写入内存缓冲区
            const chunkBuffer = Buffer.isBuffer(msg.chunk.data)
              ? msg.chunk.data
              : Buffer.from((msg.chunk.data as any).data);
            chunkBuffer.copy(session.buffer, msg.chunk.index * session.chunkSize, 0, msg.chunk.size);
            session.receivedChunks.add(msg.chunk.index);
            
            // 显示进度
            const progress = Math.floor((session.receivedChunks.size / session.totalChunks) * 100);
            if (session.receivedChunks.size % 2000 === 0 || session.receivedChunks.size === session.totalChunks) {
              log(`[文件接收] 进度: ${progress}% (${session.receivedChunks.size}/${session.totalChunks})`);
            }
            
            // 检查是否已接收所有 chunk
            if (session.receivedChunks.size === session.totalChunks) {
              // 写入文件
              fs.writeFileSync(session.filePath, session.buffer);
              
              const receiveTime = ((Date.now() - session.startTime) / 1000).toFixed(2);
              const fileSizeMB = (session.fileSize / (1024 * 1024)).toFixed(2);
              const speedMBps = (session.fileSize / (1024 * 1024) / parseFloat(receiveTime)).toFixed(2);
              const fileName = extractFileName(session.filePath);
              
              log(`[文件接收] ✅ 接收完成: ${fileName} (${fileSizeMB} MB, 耗时: ${receiveTime}s, 速度: ${speedMBps} MB/s)`);
              
              // 发送接收完成确认
              sendMessage(
                {
                  type: "file_received",
                  from: getClientId(),
                  timestamp: Date.now(),
                  sessionId: session.sessionId,
                  value: msg.value
                },
                rinfo.address,
                rinfo.port
              );
              
              fileReceiveSessions.delete(sessionKey);
            }
          }
        }
      } else {
        // 否则是chunk请求（文件下载请求）
        log(`[接收] type=chunk, from=${rinfo.address}:${rinfo.port}, type=request`);
        const filePath = typeof msg.value === "string" ? msg.value : "";
        if (filePath) {
          handleChunkRequest(filePath, rinfo.address, rinfo.port, msg.requestChunks, msg.sessionId);
        }
      }
      return;
    }
    
    // 处理文件接收完成确认
    if (msg.type === "file_received") {
      // 清理发送会话
      const sessionId = msg.sessionId;
      const session = fileSendSessions.get(sessionId || "");
      if (session) {
        const totalTime = ((Date.now() - session.startTime) / 1000).toFixed(2);
        const fileName = extractFileName(session.filePath);
        
        try {
          fs.closeSync(session.fd);
        } catch (error) {
          errorLog(`关闭文件句柄失败: ${error}`);
        }
        
        fileSendSessions.delete(sessionId || "");
        log(`[文件发送] 🎉 对方确认接收完成: ${fileName} (总耗时: ${totalTime}s)`);
      }
      return;
    }
    
    // 其他未知类型消息
    log(`[接收] type=${msg.type || "unknown"}, from=${rinfo.address}:${rinfo.port}`);
  } catch (e) {
    errorLog(`处理消息时出错: ${e}`);
  }
});

udpClient.on("error", (err) => {
  errorLog(`UDP 客户端错误: ${err.message}`);
});

function shutdown() {
  console.log("\n正在关闭 UDP 客户端...");
  
  // 关闭所有文件接收会话（内存缓冲区会自动释放）
  fileReceiveSessions.clear();
  
  // 关闭所有文件发送句柄
  for (const [, session] of fileSendSessions.entries()) {
    try {
      fs.closeSync(session.fd);
    } catch {}
  }
  
  rl.close();
  udpClient.close(() => {
    console.log("UDP 客户端已关闭");
    process.exit(0);
  });
}

udpClient.bind(CLIENT_PORT, CLIENT_IP, () => {
  // 增大UDP接收缓冲区，避免高速传输时丢包
  try {
    // 设置接收缓冲区为16MB（增大以应对大文件传输）
    const bufferSize = 16 * 1024 * 1024;
    udpClient.setRecvBufferSize(bufferSize);
    const actualSize = udpClient.getRecvBufferSize();
    const bufferSizeMB = (bufferSize / (1024 * 1024)).toFixed(2);
    const actualSizeMB = (actualSize / (1024 * 1024)).toFixed(2);
    log(`[UDP] 接收缓冲区请求大小: ${bufferSizeMB} MB, 实际大小: ${actualSizeMB} MB`);
    
    if (actualSize < bufferSize) {
      log(`[UDP] 警告：实际缓冲区大小小于请求大小，可能需要调整系统参数`);
    }
  } catch (error) {
    errorLog(`[UDP] 无法设置接收缓冲区大小: ${error}`);
  }
  
  printBanner();
});

process.on("SIGINT", () => {
  shutdown();
});

process.on("SIGTERM", () => {
  shutdown();
});
