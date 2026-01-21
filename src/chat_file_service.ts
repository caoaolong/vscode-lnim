import * as fs from "fs";
import { ChatFileChunk, ChatMessageService } from "./chat_message_service";
import * as path from "path";
import * as vscode from "vscode";

export interface ChatFileMetadata {
  ip: string;
  port: number;
  username: string;
  path: string;
}

export interface ReceivedFile {
  path: string;
  name: string;
  size: number;
  sender: string;
  ip: string;
  port: number;
}

export class ChatFileService {
  private readonly chunkSize: number = 1024;
  private fds: Map<string, number> = new Map();
  // 存储文件下载进度的会话信息
  private activeDownloads = new Map<string, {
    resolve: () => void;
    report: (value: { message?: string; increment?: number }) => void;
    lastPercentage: number;
    receivedChunks: Set<number>; // 记录已接收的 chunk index
    totalChunks: number; // 总 chunk 数
    sessionId: string; // 传输会话ID
    senderIp: string; // 发送方IP
    senderPort: number; // 发送方端口
    resendAttempts: number; // 补发请求次数
    lastActivityTime: number; // 最后活动时间
    cancelled: boolean; // 是否已取消
    filePath: string; // 本地文件路径
    originalFileName: string; // 原始文件名
    fileSize: number; // 文件大小（估算）
  }>();
  rootPath: string;
  private messageServiceRef?: any; // 引用 ChatMessageService 用于发送补发请求
  private sessionTimeoutChecker?: NodeJS.Timeout; // 超时检查定时器
  private readonly persistenceDir: string; // 持久化目录
  
  constructor(rootPath: string) {
    this.rootPath = rootPath;
    fs.mkdirSync(`${this.rootPath}/files`, { recursive: true });
    this.persistenceDir = path.join(this.rootPath, '.transfer_sessions');
    fs.mkdirSync(this.persistenceDir, { recursive: true });
    
    // 启动超时检查
    this.startSessionTimeoutChecker();
    
    // 恢复未完成的传输（如果需要）
    this.restoreUnfinishedTransfers();
  }
  
  /**
   * 设置消息服务引用（用于发送补发请求）
   */
  public setMessageService(messageService: any): void {
    this.messageServiceRef = messageService;
  }
  
  /**
   * 启动会话超时检查
   */
  private startSessionTimeoutChecker(): void {
    // 每30秒检查一次
    this.sessionTimeoutChecker = setInterval(() => {
      this.checkSessionTimeouts();
    }, 30000);
  }
  
  /**
   * 检查并清理超时的会话
   */
  private checkSessionTimeouts(): void {
    const now = Date.now();
    
    for (const [key, session] of this.activeDownloads.entries()) {
      if (session.cancelled) {
        continue; // 已取消的会话会单独处理
      }
      
      // 计算超时时间：基础60秒 + 每MB额外30秒，最多30分钟
      const estimatedSizeMB = (session.fileSize || session.totalChunks * this.chunkSize) / (1024 * 1024);
      const timeoutMs = Math.min(60000 + estimatedSizeMB * 30000, 30 * 60 * 1000);
      
      const idleTime = now - session.lastActivityTime;
      
      if (idleTime > timeoutMs) {
        console.warn(`传输会话超时：${session.sessionId}, 空闲时间：${Math.floor(idleTime / 1000)}秒`);
        vscode.window.showWarningMessage(
          `文件 ${session.originalFileName} 传输超时，已自动取消。`
        );
        this.cancelTransfer(key);
      }
    }
  }
  
  /**
   * 取消文件传输
   */
  public cancelTransfer(progressKey: string): void {
    const session = this.activeDownloads.get(progressKey);
    if (!session) {
      return;
    }
    
    session.cancelled = true;
    
    // 关闭文件句柄
    if (this.fds.has(session.filePath)) {
      const fd = this.fds.get(session.filePath);
      if (fd) {
        try {
          fs.closeSync(fd);
        } catch (error) {
          console.error('关闭文件句柄失败:', error);
        }
        this.fds.delete(session.filePath);
      }
    }
    
    // 删除半成品文件
    try {
      if (fs.existsSync(session.filePath)) {
        fs.unlinkSync(session.filePath);
        console.log(`已删除半成品文件：${session.filePath}`);
      }
    } catch (error) {
      console.error('删除半成品文件失败:', error);
    }
    
    // 删除持久化数据
    this.deletePersistenceData(session.sessionId);
    
    // 结束进度条
    session.resolve();
    this.activeDownloads.delete(progressKey);
    
    console.log(`传输会话已取消：${session.sessionId}`);
  }
  
  /**
   * 保存传输进度到持久化存储
   */
  private savePersistenceData(session: any): void {
    try {
      const persistenceFile = path.join(this.persistenceDir, `${session.sessionId}.json`);
      const data = {
        sessionId: session.sessionId,
        filePath: session.filePath,
        originalFileName: session.originalFileName,
        totalChunks: session.totalChunks,
        receivedChunks: Array.from(session.receivedChunks),
        senderIp: session.senderIp,
        senderPort: session.senderPort,
        fileSize: session.fileSize,
        lastActivityTime: session.lastActivityTime,
        timestamp: Date.now()
      };
      
      fs.writeFileSync(persistenceFile, JSON.stringify(data, null, 2));
    } catch (error) {
      console.error('保存传输进度失败:', error);
    }
  }
  
  /**
   * 删除持久化数据
   */
  private deletePersistenceData(sessionId: string): void {
    try {
      const persistenceFile = path.join(this.persistenceDir, `${sessionId}.json`);
      if (fs.existsSync(persistenceFile)) {
        fs.unlinkSync(persistenceFile);
        console.log(`已删除持久化数据：${sessionId}`);
      }
    } catch (error) {
      console.error('删除持久化数据失败:', error);
    }
  }
  
  /**
   * 恢复未完成的传输
   */
  private restoreUnfinishedTransfers(): void {
    try {
      if (!fs.existsSync(this.persistenceDir)) {
        return;
      }
      
      const files = fs.readdirSync(this.persistenceDir);
      const now = Date.now();
      
      for (const file of files) {
        if (!file.endsWith('.json')) {
          continue;
        }
        
        const persistenceFile = path.join(this.persistenceDir, file);
        try {
          const data = JSON.parse(fs.readFileSync(persistenceFile, 'utf-8'));
          
          // 检查会话是否过期（超过1小时）
          const age = now - (data.timestamp || 0);
          if (age > 60 * 60 * 1000) {
            // 过期的会话，清理文件和数据
            console.log(`清理过期的传输会话：${data.sessionId}`);
            if (fs.existsSync(data.filePath)) {
              fs.unlinkSync(data.filePath);
            }
            fs.unlinkSync(persistenceFile);
            continue;
          }
          
          // 可以选择是否恢复未完成的传输
          // 这里暂时只是清理过期会话，不自动恢复
          console.log(`发现未完成的传输会话：${data.sessionId}, 已接收 ${data.receivedChunks.length}/${data.totalChunks} 块`);
        } catch (error) {
          console.error(`恢复传输会话失败: ${file}`, error);
        }
      }
    } catch (error) {
      console.error('恢复未完成传输失败:', error);
    }
  }
  
  /**
   * 清理资源
   */
  public dispose(): void {
    if (this.sessionTimeoutChecker) {
      clearInterval(this.sessionTimeoutChecker);
    }
    
    // 关闭所有文件句柄
    for (const [filePath, fd] of this.fds.entries()) {
      try {
        fs.closeSync(fd);
      } catch (error) {
        console.error(`关闭文件句柄失败 ${filePath}:`, error);
      }
    }
    this.fds.clear();
  }

  /**
   * 获取安全的相对路径，防止绝对路径导致的错误
   * 支持跨平台路径处理（Windows 和 Unix）
   */
  private getSafeRelativePath(filePath: string): string {
    // 处理 Windows 路径（在任何平台上都能识别）
    // 匹配类似 C:\path\to\file 或 D:\path\to\file 的格式
    const winDriveMatch = filePath.match(/^[a-zA-Z]:\\/);
    if (winDriveMatch) {
      // 这是一个 Windows 绝对路径，移除盘符和根目录
      const withoutDrive = filePath.substring(3); // 跳过 "C:\"
      return withoutDrive.replace(/\\/g, '/'); // 统一使用正斜杠
    }
    
    // 处理 Unix 绝对路径（以 / 开头）
    if (filePath.startsWith('/')) {
      // 移除开头的 /
      return filePath.substring(1);
    }
    
    // 已经是相对路径，直接返回（统一使用正斜杠）
    return filePath.replace(/\\/g, '/');
  }

  /**
   * 在编辑器中打开文件
   * 使用 VS Code 的默认方式打开文件（会根据文件类型自动选择合适的编辑器）
   */
  private async openFileInEditor(filePath: string): Promise<void> {
    try {
      const uri = vscode.Uri.file(filePath);
      await vscode.commands.executeCommand("vscode.open", uri);
    } catch (error) {
      vscode.window.showErrorMessage(
        `无法打开文件: ${path.basename(filePath)}`,
      );
      console.error("打开文件失败:", error);
    }
  }

  /**
   * 获取所有接收的文件列表
   */
  public getFiles(): ReceivedFile[] {
    const files: ReceivedFile[] = [];
    
    if (!fs.existsSync(this.rootPath)) {
      return files;
    }

    try {
      // 扫描根目录下的所有目录（格式为 ${ip}_${port}）
      const entries = fs.readdirSync(this.rootPath, { withFileTypes: true });
      
      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }

        // 解析目录名，提取 IP 和端口
        const dirMatch = entry.name.match(/^(.+)_(\d+)$/);
        if (!dirMatch) {
          continue;
        }

        const [, ip, portStr] = dirMatch;
        const port = parseInt(portStr, 10);
        const dirPath = path.join(this.rootPath, entry.name);

        // 递归扫描目录下的所有文件
        this.scanDirectoryForFiles(dirPath, ip, port, files);
      }
    } catch (error) {
      console.error("获取文件列表失败:", error);
    }

    return files;
  }

  /**
   * 递归扫描目录中的文件
   */
  private scanDirectoryForFiles(
    dirPath: string,
    ip: string,
    port: number,
    files: ReceivedFile[]
  ): void {
    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        
        if (entry.isDirectory()) {
          // 递归扫描子目录
          this.scanDirectoryForFiles(fullPath, ip, port, files);
        } else if (entry.isFile()) {
          // 获取文件信息
          const stats = fs.statSync(fullPath);
          const relativePath = path.relative(
            path.join(this.rootPath, `${ip}_${port}`),
            fullPath
          );
          
          files.push({
            path: fullPath,
            name: entry.name,
            size: stats.size,
            sender: `${ip}:${port}`, // 默认显示 IP:Port，后续可以从联系人中获取用户名
            ip,
            port,
          });
        }
      }
    } catch (error) {
      console.error(`扫描目录失败 ${dirPath}:`, error);
    }
  }

  /**
   * 删除文件
   */
  public async deleteFile(filePath: string): Promise<boolean> {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        
        // 如果文件所在目录为空，尝试删除目录
        const dirPath = path.dirname(filePath);
        try {
          const dirEntries = fs.readdirSync(dirPath);
          if (dirEntries.length === 0) {
            fs.rmdirSync(dirPath);
          }
        } catch {
          // 忽略删除目录的错误
        }
        
        return true;
      }
      return false;
    } catch (error) {
      console.error("删除文件失败:", error);
      return false;
    }
  }

  /**
   * 打开文件（公开方法）
   */
  public async openFile(filePath: string): Promise<void> {
    await this.openFileInEditor(filePath);
  }

  public async download(
    file: ChatFileMetadata,
    messageService: ChatMessageService,
  ): Promise<void> {
    const safePath = this.getSafeRelativePath(file.path);
    const targetPath = path.join(
      this.rootPath,
      `${file.ip}_${file.port}`,
      safePath,
    );
    const filename = path.basename(file.path);

    if (fs.existsSync(targetPath) && fs.statSync(targetPath).size > 0) {
      // 文件已存在，询问用户是否要覆盖
      const answer = await vscode.window.showWarningMessage(
        `文件 ${filename} 已存在，是否覆盖？`,
        { modal: true },
        "覆盖",
        "取消",
      );

      if (answer === "覆盖") {
        // 用户选择覆盖，删除旧文件并重新创建
        fs.unlinkSync(targetPath);
        fs.writeFileSync(targetPath, "");
        this.fds.set(targetPath, fs.openSync(targetPath, "r+"));
        messageService.sendFileMessage(file);
        return;
      } else if (answer === "取消") {
        // 用户取消覆盖，在编辑器中打开已存在的文件
        await this.openFileInEditor(targetPath);
        return;
      }
    }

    // 文件不存在，直接创建
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, "");
    this.fds.set(targetPath, fs.openSync(targetPath, "r+"));
    messageService.sendFileMessage(file);
  }

  public saveChunk(
    value: string | undefined,
    chunk: ChatFileChunk | undefined,
    ip: string,
    port: number,
    sessionId?: string,
  ) {
    // 保存文件
    if (!value || !chunk) {
      return;
    }
    const safePath = this.getSafeRelativePath(value);
    const filePath = path.join(this.rootPath, `${ip}_${port}`, safePath);
    
    // 初始化或获取进度条会话
    const progressKey = `${ip}_${port}_${value}`;
    if (!this.activeDownloads.has(progressKey) && chunk.total && chunk.total > 0) {
      let resolveFunc: () => void;
      let cancelFunc: () => void;
      const p = new Promise<void>((resolve) => {
        resolveFunc = resolve;
        cancelFunc = () => {
          this.cancelTransfer(progressKey);
        };
      });

      vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `正在接收文件: ${path.basename(value)}`,
        cancellable: true // 允许取消
      }, (progress, token) => {
        const s = this.activeDownloads.get(progressKey);
        if (s) {
          s.report = progress.report;
        }
        
        // 监听取消事件
        token.onCancellationRequested(() => {
          console.log('用户取消了文件传输');
          this.cancelTransfer(progressKey);
        });
        
        return p;
      });

      const estimatedSize = chunk.total * this.chunkSize;
      this.activeDownloads.set(progressKey, {
        resolve: resolveFunc!,
        report: () => {}, // 占位符，等待 callback 替换
        lastPercentage: 0,
        receivedChunks: new Set<number>(),
        totalChunks: chunk.total,
        sessionId: sessionId || `${ip}_${port}_${value}_${Date.now()}`,
        senderIp: ip,
        senderPort: port,
        resendAttempts: 0,
        lastActivityTime: Date.now(),
        cancelled: false,
        filePath: filePath,
        originalFileName: path.basename(value),
        fileSize: estimatedSize
      });
    }
    
    const session = this.activeDownloads.get(progressKey);
    
    // 检查是否已取消
    if (session && session.cancelled) {
      console.log('传输已取消，忽略后续 chunk');
      return;
    }

    if (this.fds.has(filePath)) {
      const fd = this.fds.get(filePath);
      if (!fd) {
        return;
      }

      // 将 chunk.data 转换为 Buffer（因为 JSON.parse 后 Buffer 会变成普通对象）
      const buffer = Buffer.isBuffer(chunk.data)
        ? chunk.data
        : Buffer.from((chunk.data as any).data);

      fs.writeSync(fd, buffer, 0, chunk.size, chunk.index * this.chunkSize);
      
      // 记录已接收的 chunk
      if (session) {
        session.receivedChunks.add(chunk.index);
        session.lastActivityTime = Date.now(); // 更新活动时间
        
        // 定期保存进度（每10个chunk保存一次）
        if (session.receivedChunks.size % 10 === 0) {
          this.savePersistenceData(session);
        }
        
        // 更新进度
        if (chunk.total && chunk.total > 0) {
          const percentage = Math.floor((session.receivedChunks.size / chunk.total) * 100);
          const increment = percentage - session.lastPercentage;
          if (increment > 0) {
            session.report({ increment, message: `${percentage}% (${session.receivedChunks.size}/${chunk.total})` });
            session.lastPercentage = percentage;
          }
        }
      }

      if (chunk.finish) {
        // 检查是否收到所有 chunk
        if (session && chunk.total) {
          const missingChunks: number[] = [];
          for (let i = 0; i < chunk.total; i++) {
            if (!session.receivedChunks.has(i)) {
              missingChunks.push(i);
            }
          }
          
          if (missingChunks.length > 0 && session.resendAttempts < 3) {
            // 有缺失的 chunk，请求补发
            console.log(`文件传输不完整！缺失 ${missingChunks.length} 个块，请求补发...`);
            session.resendAttempts++;
            
            // 保存进度
            this.savePersistenceData(session);
            
            // 发送补发请求
            this.requestResendChunks(session.sessionId, missingChunks, value, session.senderIp, session.senderPort);
            
            // 不关闭文件，等待补发
            vscode.window.showWarningMessage(
              `文件 ${path.basename(value)} 接收不完整，正在请求补发 ${missingChunks.length} 个数据块... (尝试 ${session.resendAttempts}/3)`
            );
            return; // 不完成传输，等待补发
          } else if (missingChunks.length > 0) {
            // 达到最大重试次数，仍然有缺失
            console.error(`文件传输失败！缺失 ${missingChunks.length} 个块：${missingChunks.slice(0, 10).join(', ')}${missingChunks.length > 10 ? '...' : ''}`);
            vscode.window.showErrorMessage(
              `文件 ${path.basename(value)} 接收失败！缺失 ${missingChunks.length} 个数据块，已达最大重试次数。`
            );
            
            // 删除持久化数据
            this.deletePersistenceData(session.sessionId);
          } else {
            // 所有 chunk 都收到了
            console.log(`文件传输完成：${path.basename(value)}，共 ${chunk.total} 个块`);
            
            // 删除持久化数据
            this.deletePersistenceData(session.sessionId);
            
            // 发送传输完成确认
            this.sendTransferComplete(session.sessionId, value, session.senderIp, session.senderPort);
          }
        }
        
        fs.closeSync(fd);
        this.fds.delete(filePath);
        
        // 结束进度条
        if (session) {
          session.resolve();
          this.activeDownloads.delete(progressKey);
        }

        // 文件接收完成，在编辑器中打开文件
        if (session && !session.cancelled) {
          this.openFileInEditor(filePath);
        }
      }
    }
  }
  
  /**
   * 请求补发缺失的 chunk
   */
  private requestResendChunks(sessionId: string, missingChunks: number[], filePath: string, ip: string, port: number): void {
    if (!this.messageServiceRef) {
      console.error('无法发送补发请求：messageService 未设置');
      return;
    }
    
    this.messageServiceRef.sendResendRequest(sessionId, missingChunks, filePath, ip, port);
  }
  
  /**
   * 发送传输完成确认
   */
  private sendTransferComplete(sessionId: string, filePath: string, ip: string, port: number): void {
    if (!this.messageServiceRef) {
      console.error('无法发送传输完成确认：messageService 未设置');
      return;
    }
    
    this.messageServiceRef.sendTransferComplete(sessionId, filePath, ip, port);
  }
}
